// cf-image-bridge — OpenAI-compatible Images API in front of Cloudflare Workers AI.
//
// Clients post { model, prompt, n?, size?, input_references? } and read
// { data: [{ b64_json, media_type }] }. The available models and every model
// specific detail (Workers AI id, transport, size grid, reference fields,
// fixed params) live in config/models.json — this file contains no model.
//
// A deployment may override the bundled registry without a rebuild by setting a
// MODELS_JSON variable (string or object) on the Worker; it is validated the
// same way as the bundled file.

import bundledRegistry from "../config/models.json" with { type: "json" };

const DEFAULT_MAX_PROMPT = 2048;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_SIZE_MIN = 256;
const DEFAULT_SIZE_STEP = 16;
const DEFAULT_SIZE = [1024, 1024];
const DEFAULT_REFERENCE_FIELD = "input_image_{index}";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(message, status, code = "invalid_request_error", param) {
  const type = code ?? "invalid_request_error";
  const body = { message, type, code: type };
  if (param) body.param = param;
  return json({ error: body }, status);
}

// ---------------------------------------------------------------------------
// Registry: validate and normalize config/models.json (or MODELS_JSON).
// ---------------------------------------------------------------------------

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeSize(raw, where, problems) {
  if (raw == null) return null;
  if (typeof raw !== "object") {
    problems.push(`${where}.size must be an object or null`);
    return null;
  }
  const max = raw.max;
  if (!isPositiveInt(max)) {
    problems.push(`${where}.size.max must be a positive integer`);
    return null;
  }
  const min = raw.min ?? DEFAULT_SIZE_MIN;
  const step = raw.step ?? DEFAULT_SIZE_STEP;
  const fallback = raw.default ?? DEFAULT_SIZE;
  const format = raw.format ?? "wh";
  if (!isPositiveInt(min) || min > max) problems.push(`${where}.size.min must be a positive integer <= max`);
  if (!isPositiveInt(step)) problems.push(`${where}.size.step must be a positive integer`);
  if (!Array.isArray(fallback) || fallback.length !== 2 || !fallback.every(isPositiveInt)) {
    problems.push(`${where}.size.default must be [width, height] of positive integers`);
  }
  if (format !== "wh" && format !== "size") problems.push(`${where}.size.format must be "wh" or "size"`);
  return {
    min,
    max,
    step,
    default: Array.isArray(fallback) && fallback.length === 2 ? fallback : DEFAULT_SIZE,
    format,
    widthField: raw.widthField ?? "width",
    heightField: raw.heightField ?? "height",
    sizeField: raw.sizeField ?? "size",
  };
}

function normalizeModel(raw, index, problems, names) {
  const where = `models[${index}]`;
  if (!raw || typeof raw !== "object") {
    problems.push(`${where} must be an object`);
    return null;
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    problems.push(`${where}.name must be a non-empty string`);
    return null;
  }
  if (names.has(raw.name)) problems.push(`${where}.name "${raw.name}" is duplicated`);
  names.add(raw.name);
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    problems.push(`${where}.id must be a non-empty string`);
  }
  const transport = raw.transport ?? "json";
  if (transport !== "json" && transport !== "multipart") {
    problems.push(`${where}.transport must be "json" or "multipart"`);
  }
  const refsRaw = raw.references ?? {};
  const refsMax = refsRaw.max ?? 0;
  const refField = refsRaw.field ?? DEFAULT_REFERENCE_FIELD;
  if (!Number.isInteger(refsMax) || refsMax < 0) problems.push(`${where}.references.max must be an integer >= 0`);
  if (typeof refField !== "string" || !refField) problems.push(`${where}.references.field must be a non-empty string`);
  if (refsMax > 1 && !refField.includes("{index}")) {
    problems.push(`${where}.references.field must contain {index} when references.max > 1`);
  }
  if (refsMax > 0 && transport !== "multipart") {
    problems.push(`${where}.references requires transport "multipart"`);
  }
  if (raw.params != null && (typeof raw.params !== "object" || Array.isArray(raw.params))) {
    problems.push(`${where}.params must be an object`);
  }
  return {
    name: raw.name,
    id: typeof raw.id === "string" ? raw.id : "",
    transport: transport === "multipart" ? "multipart" : "json",
    size: normalizeSize(raw.size, where, problems),
    references: { max: Number.isInteger(refsMax) ? refsMax : 0, field: refField },
    params: raw.params && typeof raw.params === "object" ? raw.params : {},
  };
}

function normalizeRegistry(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.models) || input.models.length === 0) {
    throw new Error("model registry must contain a non-empty `models` array");
  }
  const problems = [];
  const names = new Set();
  const models = input.models
    .map((raw, i) => normalizeModel(raw, i, problems, names))
    .filter(Boolean);

  const byName = new Map(models.map((model) => [model.name, model]));
  const defaultModel = input.defaultModel ?? models[0]?.name;
  if (!byName.has(defaultModel)) problems.push(`defaultModel "${defaultModel}" is not in models`);

  const maxPromptLength = input.maxPromptLength ?? DEFAULT_MAX_PROMPT;
  if (!isPositiveInt(maxPromptLength)) problems.push("maxPromptLength must be a positive integer");
  const maxImages = input.maxImages ?? DEFAULT_MAX_IMAGES;
  if (!isPositiveInt(maxImages)) problems.push("maxImages must be a positive integer");

  if (problems.length > 0) throw new Error(problems.join("; "));
  return { models: byName, list: models, defaultModel, maxPromptLength, maxImages };
}

let bundled = null;
let overridden = null;

function registryFor(env) {
  const raw = env.MODELS_JSON;
  if (raw === undefined || raw === null || raw === "") {
    bundled ??= normalizeRegistry(bundledRegistry);
    return bundled;
  }
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (overridden?.text === text) return overridden.value;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`MODELS_JSON is not valid JSON: ${e.message}`);
  }
  const value = normalizeRegistry(parsed);
  overridden = { text, value };
  return value;
}

// ---------------------------------------------------------------------------
// Request translation.
// ---------------------------------------------------------------------------

// Parse an OpenAI `size` value ("1024x1024", "auto", [w, h]) onto the model grid.
function resolveSize(spec, requested) {
  const grid = spec.size;
  if (!grid) return null;
  let width = grid.default[0];
  let height = grid.default[1];
  if (typeof requested === "string") {
    const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(requested.trim());
    if (match) [width, height] = [Number(match[1]), Number(match[2])];
  } else if (Array.isArray(requested) && requested.length === 2 && requested.every(isPositiveInt)) {
    [width, height] = requested;
  }
  const scale = Math.min(1, grid.max / Math.max(width, height));
  const snap = (value) =>
    Math.min(grid.max, Math.max(grid.min, Math.ceil((value * scale) / grid.step) * grid.step));
  return [snap(width), snap(height)];
}

// Size fields differ per model: two numbers or a single "WxH" string.
function sizeEntries(grid, size) {
  if (!size) return [];
  if (grid.format === "size") return [[grid.sizeField, `${size[0]}x${size[1]}`]];
  return [
    [grid.widthField, size[0]],
    [grid.heightField, size[1]],
  ];
}

async function bytesToBase64(bytes) {
  // Chunked to stay clear of Worker string-length limits on large images.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Workers AI returns raw bytes from some models and base64 strings from others;
// the container format also varies.
async function toBase64(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ReadableStream) return bytesToBase64(new Uint8Array(await new Response(value).arrayBuffer()));
  if (value instanceof Blob) return bytesToBase64(new Uint8Array(await value.arrayBuffer()));
  return null;
}

// Detect the encoded format from magic bytes so clients name the file correctly.
function mediaTypeOf(base64) {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

// References arrive as OpenAI image_url objects carrying data URLs.
function referenceBlobs(references) {
  if (references === undefined || references === null) return [];
  if (!Array.isArray(references)) throw new Error("`input_references` must be an array");
  const blobs = [];
  for (const [i, ref] of references.entries()) {
    const url = typeof ref === "string" ? ref : ref && (ref.url ?? ref.image_url?.url);
    if (typeof url !== "string" || !url.startsWith("data:")) {
      throw new Error(`\`input_references[${i}]\` must be a data: URL`);
    }
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error(`\`input_references[${i}]\` is not a valid data: URL`);
    const meta = url.slice(5, comma);
    let bytes;
    try {
      bytes = Uint8Array.from(atob(url.slice(comma + 1)), (c) => c.charCodeAt(0));
    } catch {
      throw new Error(`\`input_references[${i}]\` has invalid base64 data`);
    }
    blobs.push(new Blob([bytes], { type: meta.replace(/;base64$/, "") || "image/png" }));
  }
  return blobs;
}

function referenceField(spec, index) {
  const field = spec.references.field;
  return field.includes("{index}") ? field.replaceAll("{index}", String(index)) : field;
}

// Send one generation to Workers AI and return the encoded image.
async function invoke(env, spec, prompt, size, blobs) {
  let result;
  if (spec.transport === "multipart") {
    const form = new FormData();
    form.append("prompt", prompt);
    for (const [key, value] of sizeEntries(spec.size ?? {}, size)) form.append(key, String(value));
    for (const [key, value] of Object.entries(spec.params)) {
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    blobs.forEach((blob, i) => form.append(referenceField(spec, i), blob));
    const serialized = new Response(form);
    result = await env.AI.run(spec.id, {
      multipart: { body: serialized.body, contentType: serialized.headers.get("content-type") },
    });
  } else {
    const input = { ...spec.params, prompt, ...Object.fromEntries(sizeEntries(spec.size ?? {}, size)) };
    result = await env.AI.run(spec.id, input);
  }
  const raw = result && result.image !== undefined ? result.image : result;
  const b64 = (await toBase64(raw))?.replace(/^data:[^,]*,/, "");
  if (!b64) throw new Error("Workers AI returned no image data.");
  return b64;
}

function authorized(request, env) {
  const expected = env.BRIDGE_TOKEN;
  if (!expected) return error("BRIDGE_TOKEN is not configured on this Worker.", 500, "misconfigured");
  const presented = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (presented !== expected) return error("Invalid API key.", 401, "invalid_api_key");
  return null;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  let registry;
  try {
    registry = registryFor(env);
  } catch (e) {
    return error(`Model registry is invalid: ${e.message}`, 500, "misconfigured");
  }

  if (request.method === "GET" && (path === "" || path === "/v1/models" || path === "/models")) {
    return json({
      object: "list",
      data: registry.list.map((model) => ({
        id: model.name,
        object: "model",
        owned_by: "cloudflare-workers-ai",
      })),
    });
  }

  const isEdit = path === "/v1/images/edits" || path === "/images/edits";
  const isGenerate = path === "/v1/images/generations" || path === "/images/generations";
  if (!isEdit && !isGenerate) return error(`No route for ${request.method} ${url.pathname}`, 404, "not_found");
  if (request.method !== "POST") return error(`${request.method} is not allowed on this route.`, 405, "method_not_allowed");

  // Every generation spends the account's quota, so the bridge is never open.
  const denied = authorized(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return error("Request body must be JSON.", 400);
  }
  if (!body || typeof body !== "object") return error("Request body must be a JSON object.", 400);

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return error("`prompt` is required.", 400, null, "prompt");
  if (prompt.length > registry.maxPromptLength) {
    return error(
      `\`prompt\` must be at most ${registry.maxPromptLength} characters.`,
      400,
      "context_length_exceeded",
      "prompt",
    );
  }

  const name = typeof body.model === "string" && body.model ? body.model : registry.defaultModel;
  const spec = registry.models.get(name);
  if (!spec) {
    return error(
      `Unknown model \`${name}\`. Known: ${registry.list.map((m) => m.name).join(", ")}.`,
      404,
      "model_not_found",
      "model",
    );
  }

  const n = body.n === undefined || body.n === null ? 1 : body.n;
  if (!Number.isInteger(n) || n < 1) return error("`n` must be a positive integer.", 400, null, "n");
  if (n > registry.maxImages) {
    return error(`\`n\` must be at most ${registry.maxImages}.`, 400, "unsupported_parameter", "n");
  }

  let blobs;
  try {
    blobs = referenceBlobs(body.input_references ?? body.images);
  } catch (e) {
    return error(e.message, 400, null, "input_references");
  }
  if (isEdit && blobs.length === 0) {
    return error("Edit requests need at least one input image.", 400, null, "input_references");
  }
  if (blobs.length > 0 && spec.references.max === 0) {
    return error(
      `\`${name}\` does not accept input images; use a model with edit support.`,
      400,
      "unsupported_parameter",
      "input_references",
    );
  }
  if (blobs.length > spec.references.max) {
    return error(`\`${name}\` accepts at most ${spec.references.max} input image(s).`, 400, "unsupported_parameter");
  }

  const size = resolveSize(spec, body.size);

  const data = [];
  try {
    for (let i = 0; i < n; i++) {
      const b64 = await invoke(env, spec, prompt, size, blobs);
      data.push({ b64_json: b64, media_type: mediaTypeOf(b64) });
    }
  } catch (e) {
    return error(`Workers AI request failed: ${e && e.message ? e.message : String(e)}`, 502, "upstream_error");
  }

  return json({ created: Math.floor(Date.now() / 1000), data });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return error(`Unhandled error: ${e && e.message ? e.message : String(e)}`, 500, "internal_error");
    }
  },
};
