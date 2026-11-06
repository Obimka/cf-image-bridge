// Node harness: exercises the Worker against a stubbed Workers AI binding.
// Run with: node test/harness.mjs
import worker from "../src/worker.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TOKEN = "test-token";

let calls = [];
function makeEnv(impl) {
  return {
    BRIDGE_TOKEN: TOKEN,
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return impl(model, input);
      },
    },
  };
}

const base64Env = makeEnv(async () => ({ image: PNG }));
const streamEnv = makeEnv(async () => new Response(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))).body);
const upEnv = makeEnv(async () => {
  throw new Error("Neurons budget exhausted");
});

function req(path, body, method = "POST", token = TOKEN) {
  return new Request(`https://bridge.test${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) return console.log(`ok   ${name}`);
  failures++;
  console.log(`FAIL ${name} ${detail}`);
}

const formOf = async (call) => new Response(call.input.multipart.body, {
  headers: { "content-type": call.input.multipart.contentType },
}).formData();

// 1. Default model is FLUX.2 klein, which requires multipart.
calls = [];
let res = await worker.fetch(req("/v1/images/generations", { prompt: "a teal poster" }), base64Env);
let out = await res.json();
check("generations 200", res.status === 200, `got ${res.status}`);
check("b64_json returned", out.data?.[0]?.b64_json === PNG, JSON.stringify(out).slice(0, 120));
check("default model is klein", calls[0]?.model === "@cf/black-forest-labs/flux-2-klein-4b", calls[0]?.model);

// 2. klein always uses multipart, carrying width/height.
let form = await formOf(calls[0]);
check("klein form has prompt", form.get("prompt") === "a teal poster", String(form.get("prompt")));
check("klein default 1024x1024", form.get("width") === "1024" && form.get("height") === "1024", `${form.get("width")}x${form.get("height")}`);

// 3. omp sends size=1536x1024 for 16:9.
calls = [];
await worker.fetch(req("/v1/images/generations", { prompt: "wide", size: "1536x1024" }), base64Env);
form = await formOf(calls[0]);
check("size 1536x1024 honored", form.get("width") === "1536" && form.get("height") === "1024", `${form.get("width")}x${form.get("height")}`);

// 4. Sizes snap to the 16px grid and clamp at 1920 (verified API behaviour).
calls = [];
await worker.fetch(req("/v1/images/generations", { prompt: "tall", size: "1024x1536" }), base64Env);
form = await formOf(calls[0]);
check("size 1024x1536 honored", form.get("width") === "1024" && form.get("height") === "1536", `${form.get("width")}x${form.get("height")}`);

// 5. flux-schnell takes JSON only, and never width/height/seed.
calls = [];
res = await worker.fetch(req("/v1/images/generations", { model: "flux-schnell", prompt: "schnell", size: "1536x1024" }), base64Env);
out = await res.json();
check("schnell json payload", calls[0]?.input && calls[0].input.multipart === undefined, JSON.stringify(calls[0]?.input));
check("schnell omits width/height", !("width" in (calls[0]?.input || {})) && !("height" in (calls[0]?.input || {})), JSON.stringify(calls[0]?.input));
check("schnell keeps prompt+steps", calls[0]?.input?.prompt === "schnell" && calls[0]?.input?.steps === 4, JSON.stringify(calls[0]?.input));
check("schnell returns image", out.data?.[0]?.b64_json === PNG);
check("png detected", out.data?.[0]?.media_type === "image/png", out.data?.[0]?.media_type);

// 6. Binary ReadableStream output is base64-encoded.
res = await worker.fetch(req("/v1/images/generations", { prompt: "x" }), streamEnv);
out = await res.json();
check("stream output encoded", out.data?.[0]?.b64_json === PNG, JSON.stringify(out).slice(0, 120));

// 7. Edits carry the reference as input_image_0.
calls = [];
res = await worker.fetch(
  req("/v1/images/edits", {
    prompt: "add a teal circle",
    size: "1024x1024",
    input_references: [{ type: "image_url", url: `data:image/png;base64,${PNG}` }],
  }),
  base64Env,
);
out = await res.json();
form = await formOf(calls[0]);
check("edit form has input_image_0", form.has("input_image_0"), [...form.keys()].join(","));
check("edit returns image", out.data?.[0]?.b64_json === PNG, JSON.stringify(out).slice(0, 120));
check("stream media_type png", out.data?.[0]?.media_type === "image/png", out.data?.[0]?.media_type);

// 8. Edits on a model without edit support are refused, not silently degraded.
calls = [];
res = await worker.fetch(
  req("/v1/images/edits", { model: "flux-schnell", prompt: "x", input_references: [{ url: `data:image/png;base64,${PNG}` }] }),
  base64Env,
);
check("schnell edit rejected 400", res.status === 400, `got ${res.status}`);
check("schnell edit never called AI", calls.length === 0, JSON.stringify(calls));

// 9. Edits without any image are refused.
res = await worker.fetch(req("/v1/images/edits", { prompt: "x" }), base64Env);
check("edit without image 400", res.status === 400, `got ${res.status}`);

// 10. Missing prompt.
res = await worker.fetch(req("/v1/images/generations", { model: "flux-schnell" }), base64Env);
check("missing prompt 400", res.status === 400, `got ${res.status}`);

// 11. Unknown model.
res = await worker.fetch(req("/v1/images/generations", { model: "nope", prompt: "x" }), base64Env);
check("unknown model 404", res.status === 404, `got ${res.status}`);

// 12. Upstream failure surfaces as 502 with the provider message.
res = await worker.fetch(req("/v1/images/generations", { prompt: "x" }), upEnv);
out = await res.json();
check("upstream error 502", res.status === 502, `got ${res.status}`);
check("upstream message kept", /Neurons budget/.test(out.error?.message || ""), JSON.stringify(out));

// 13. Oversized prompts rejected before hitting the model.
calls = [];
res = await worker.fetch(req("/v1/images/generations", { prompt: "x".repeat(2049) }), base64Env);
check("long prompt 400", res.status === 400, `got ${res.status}`);
check("long prompt never called AI", calls.length === 0, JSON.stringify(calls.length));

// 14. Auth: no token, wrong token, missing configuration.
calls = [];
res = await worker.fetch(
  new Request("https://bridge.test/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "should not run" }),
  }),
  base64Env,
);
check("unauthenticated 401", res.status === 401, `got ${res.status}`);
check("unauthenticated never calls AI", calls.length === 0, JSON.stringify(calls));

res = await worker.fetch(req("/v1/images/generations", { prompt: "nope" }, "POST", "wrong-token"), base64Env);
check("wrong token 401", res.status === 401, `got ${res.status}`);

res = await worker.fetch(req("/v1/images/generations", { prompt: "x" }), { AI: base64Env.AI });
check("missing BRIDGE_TOKEN 500", res.status === 500, `got ${res.status}`);

// 15. Model listing stays public so discovery works before a key is wired.
res = await worker.fetch(new Request("https://bridge.test/v1/models"), { AI: base64Env.AI });
out = await res.json();
check("models listing needs no token", res.status === 200, `got ${res.status}`);
check("both models listed", out.data?.length === 2, JSON.stringify(out));

// 16. Deployments can override the registry through MODELS_JSON.
const override = {
  defaultModel: "custom",
  maxPromptLength: 10,
  maxImages: 2,
  models: [
    {
      name: "custom",
      id: "@cf/vendor/custom-model",
      transport: "multipart",
      size: { min: 512, max: 1024, step: 64, format: "size", sizeField: "resolution" },
      references: { max: 2, field: "ref_{index}" },
      params: { guidance: 3.5 },
    },
  ],
};
const overrideEnv = makeEnv(async () => ({ image: PNG }));
overrideEnv.MODELS_JSON = JSON.stringify(override);

calls = [];
res = await worker.fetch(req("/v1/images/generations", { prompt: "custom" }), overrideEnv);
check("override model used as default", res.status === 200 && calls[0]?.model === "@cf/vendor/custom-model", `${res.status} ${calls[0]?.model}`);
form = await formOf(calls[0]);
check("override single size field", form.get("resolution") === "1024x1024" && !form.has("width"), [...form.keys()].join(","));
check("override params sent", form.get("guidance") === "3.5", String(form.get("guidance")));
check("override prompt limit enforced", (await worker.fetch(req("/v1/images/generations", { prompt: "x".repeat(11) }), overrideEnv)).status === 400);

calls = [];
res = await worker.fetch(
  req("/v1/images/edits", {
    prompt: "edit",
    input_references: [
      { url: `data:image/png;base64,${PNG}` },
      { url: `data:image/png;base64,${PNG}` },
    ],
  }),
  overrideEnv,
);
form = await formOf(calls[0]);
check("override reference fields", form.has("ref_0") && form.has("ref_1"), [...form.keys()].join(","));
check("override accepts 2 refs", res.status === 200, `got ${res.status}`);

calls = [];
res = await worker.fetch(
  req("/v1/images/edits", {
    prompt: "edit",
    input_references: Array.from({ length: 3 }, () => ({ url: `data:image/png;base64,${PNG}` })),
  }),
  overrideEnv,
);
check("override rejects 3 refs", res.status === 400 && calls.length === 0, `got ${res.status}`);

res = await worker.fetch(req("/v1/images/generations", { prompt: "x", n: 3 }), overrideEnv);
check("override rejects n above maxImages", res.status === 400, `got ${res.status}`);

// 17. `n` generates that many images, bounded by maxImages (default 4).
calls = [];
res = await worker.fetch(req("/v1/images/generations", { prompt: "many", n: 2 }), base64Env);
out = await res.json();
check("n=2 returns two images", out.data?.length === 2 && calls.length === 2, `${out.data?.length}/${calls.length}`);
res = await worker.fetch(req("/v1/images/generations", { prompt: "many", n: 0 }), base64Env);
check("n=0 rejected", res.status === 400, `got ${res.status}`);
res = await worker.fetch(req("/v1/images/generations", { prompt: "many", n: 5 }), base64Env);
check("n=5 above maxImages rejected", res.status === 400, `got ${res.status}`);

// 18. Invalid configuration fails loudly instead of running half-configured.
const badEnv = makeEnv(async () => ({ image: PNG }));
badEnv.MODELS_JSON = "{not json";
res = await worker.fetch(req("/v1/images/generations", { prompt: "x" }), badEnv);
out = await res.json();
check("invalid MODELS_JSON 500", res.status === 500, `got ${res.status}`);
check("invalid MODELS_JSON explained", /MODELS_JSON/.test(out.error?.message || ""), JSON.stringify(out));

badEnv.MODELS_JSON = JSON.stringify({ models: [{ name: "a", id: "x", references: { max: 2, field: "img" } }] });
res = await worker.fetch(new Request("https://bridge.test/v1/models"), badEnv);
check("invalid registry 500 on listing", res.status === 500, `got ${res.status}`);

badEnv.MODELS_JSON = JSON.stringify({ models: [{ name: "a", id: "x", transport: "json", references: { max: 1 } }] });
res = await worker.fetch(new Request("https://bridge.test/v1/models"), badEnv);
check("references require multipart", res.status === 500, `got ${res.status}`);

// 19. Wrong method and malformed references are reported, not swallowed.
res = await worker.fetch(new Request("https://bridge.test/v1/images/generations"), base64Env);
check("GET on generations 405", res.status === 405, `got ${res.status}`);
res = await worker.fetch(req("/v1/images/generations", { prompt: "x", input_references: [{ url: "https://example.test/a.png" }] }), base64Env);
check("non data URL reference 400", res.status === 400, `got ${res.status}`);

process.exit(failures === 0 ? 0 : 1);
