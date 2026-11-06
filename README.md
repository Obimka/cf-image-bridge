# cf-image-bridge

[![CI](https://github.com/Obimka/cf-image-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Obimka/cf-image-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An OpenAI-compatible Images API (`POST /v1/images/generations`, `POST /v1/images/edits`)
in front of [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/), so
any client that speaks the OpenAI Images API can generate images on the Workers AI
free allocation without an OpenAI account.

The bridge is generic and user-configurable: models, transports, size limits, reference
fields and fixed parameters all live in a JSON registry (`config/models.json`).
No model is hardcoded in the Worker.

## Install

Three routes: an agent runs the install, a skill configures the client, or you follow the
manual steps. They compose — the skill assumes the Worker already exists.

### With an AI agent

This repository ships an [`AGENTS.md`](AGENTS.md): a step-by-step install runbook written
for AI coding agents (Claude Code, Cursor, Codex, omp, Aider, Copilot Workspaces, …).
Point the agent at it and it does the work:

```sh
claude "Read AGENTS.md and install cf-image-bridge in my Cloudflare account"
codex  "Read AGENTS.md and install cf-image-bridge in my Cloudflare account"
```

Agents that read `AGENTS.md` by convention need nothing more than "install this project".
It carries the Cloudflare CLI sequence, the permission each step needs, the registry
invariants, a change→verification table, and a failure playbook — and it never prints
your token, never writes one to a tracked file, and asks before spending quota.

### With a skill (client configuration)

Once the Worker is deployed, `skills/cf-image-bridge/` teaches an agent to wire a client
to it and to diagnose the response codes. Install it, then ask the agent to configure
your client:

```sh
ln -s "$PWD/skills/cf-image-bridge" ~/.omp/agent/skills/cf-image-bridge
omp "Configure cf-img in my models.yml for https://<name>.<subdomain>.workers.dev/v1"
```

The skill covers omp (`models.yml` + `config.yml`), any OpenAI Images client, and a
response-code table (`401` vs `404 model_not_found` vs `400 unsupported_parameter` vs
`502 upstream_error`). It configures clients only — it never deploys.

### By hand

Follow [Cloudflare setup](#cloudflare-setup) below.

### Optional: one-click Deploy button

If you publish this repository publicly on GitHub or GitLab, you can add Cloudflare's
one-click deploy badge. Cloudflare clones the repo into the visitor's account,
provisions the `AI` binding, and reads `.dev.vars.example` to prompt for `BRIDGE_TOKEN`:

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<your-repo-url>)
```

Constraints: public repository on github.com or gitlab.com, no monorepo subdirectory,
Workers only (not Pages). Add this only if you intend to publish the repo — the manual
path and `AGENTS.md` need nothing extra.

## Why a Worker

Workers AI exposes models at `/ai/run/<model>` and each model answers in its own shape
(base64 in JSON, raw bytes, or a multipart-only request schema). It has no
`/v1/images/generations` route. This Worker is the translation layer:

```
OpenAI client  ──POST /v1/images/generations──▶  Worker  ──env.AI.run(model, input)──▶  Workers AI
               ◀──{ data: [{ b64_json }] }────         ◀── image / bytes ──────────────
```

## Requirements

- Node.js 22+ (required by `wrangler` 4.158; the Worker code itself only needs 20+ ESM)
- A Cloudflare account, with Workers AI available on the Free plan
- `wrangler`, installed locally by `npm install`

Nothing else: no database, no OpenAI key, no paid plan.

---

## Cloudflare setup

Everything in this chapter happens in your own Cloudflare account. Values shown as
`<your-subdomain>` and `<your-account>` are placeholders — never commit real ones.

### 1. Get the project

```sh
git clone <your-fork-url> cf-image-bridge
cd cf-image-bridge
npm install
```

`npm install` pulls `wrangler` (pinned in `package.json`). No global install needed.

### 2. Authenticate Wrangler

Interactive, recommended for a first install:

```sh
npx wrangler login
```

This opens a browser, asks for the account, and stores an OAuth credential locally. It
grants your user's permissions, which is what the first deploy needs.

For CI or headless shells, use an API token instead:

```sh
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=<account-id>
```

Create the token in **My Profile → API Tokens → Create Token** with:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | **Workers Scripts: Edit** | Deploy the Worker (`wrangler deploy`). |
| Account | **Workers AI: Read** | Only for querying Workers AI from the API/dashboard; not needed to deploy or run the binding. |

Notes:

- `Workers Scripts: Edit` is the legacy permission name; it maps to the **Editor** role
  at the Workers product scope. The first deploy *creates* the Worker, which requires
  product-level **Admin** (the interactive `wrangler login` already has it).
- Bindings do not need extra permissions to be deployed. `env.AI` runs with the
  account's Workers AI quota, so no separate AI credential is passed to the Worker.
- Find the account id in the dashboard sidebar, or with `npx wrangler whoami`.

### 3. Choose the Worker name and hostname

`wrangler.jsonc` is already valid:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-image-bridge",
  "main": "src/worker.js",
  "compatibility_date": "2026-11-06",
  "observability": { "enabled": true },
  "ai": { "binding": "AI" },
  "workers_dev": true
}
```

| Key | Meaning |
| --- | --- |
| `name` | Worker name. Used as the DNS label: `<name>.<your-subdomain>.workers.dev`. Max 63 chars, alphanumerics and dashes only, no leading/trailing dash. |
| `main` | Entry point. `src/worker.js`. |
| `compatibility_date` | Workers runtime version. Keep it current when you upgrade `wrangler`. |
| `observability` | Enables Workers Logs so `wrangler tail` and the dashboard show requests. |
| `ai` | Declares the Workers AI binding under the name `AI`. The code reads `env.AI`. |
| `workers_dev` | Publishes the `*.workers.dev` route. Set to `false` to serve only on a custom domain. |

Rename the Worker if `cf-image-bridge` is already taken in your account — the deploy
fails if the name does not match the Worker you intend to update.

### 4. Deploy the Worker

```sh
npx wrangler deploy
```

Expected output ends with a `workers.dev` URL:

```
https://cf-image-bridge.<your-subdomain>.workers.dev
```

At this point the route exists but has **no token**: every generation call returns
`500 misconfigured` and `GET /v1/models` still answers. That is deliberate — the Worker
refuses to run open on your neuron budget.

### 5. Set the access token

`wrangler secret put` creates a new version of an *existing* Worker and deploys it
immediately, so it must run **after** the first `wrangler deploy`.

```sh
openssl rand -hex 32          # generate, copy the value
npx wrangler secret put BRIDGE_TOKEN
# paste the value at the prompt
```

Or in the dashboard: **Workers & Pages → your Worker → Settings → Variables and
Secrets → Add → type `Secret`**, name `BRIDGE_TOKEN`, then **Deploy**.

Secrets are encrypted, never echoed back by `wrangler` or the dashboard, and never
appear in `git`. That value is the API key every client sends as
`Authorization: Bearer <token>`.

Rotate it later by repeating the same command; the old value stops working immediately.

### 6. Verify the deployment

```sh
BASE=https://cf-image-bridge.<your-subdomain>.workers.dev
TOKEN=<the value you just stored>

curl -s $BASE/v1/models
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/images/generations \
  -H 'content-type: application/json' -d '{"prompt":"x"}'          # 401

curl -s -X POST $BASE/v1/images/generations \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"a teal poster","size":"1024x1024"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.data[0].media_type,j.data[0].b64_json.length)})'
```

A working install prints the media type (`image/jpeg` for the bundled FLUX models) and
a non-zero base64 length. `GET /v1/models` stays public on purpose so a client can
discover models before its key is configured.

Live logs while testing:

```sh
npx wrangler tail
```

### 7. Optional: custom domain

A Worker on a custom domain is recommended over `*.workers.dev` for anything beyond
personal use. You need a zone already active on the same Cloudflare account.

```jsonc
{
  "workers_dev": false,
  "routes": [{ "pattern": "images.example.com", "custom_domain": true }]
}
```

```sh
npx wrangler deploy
```

Cloudflare creates the DNS record and the certificate; the hostname must not already
have a CNAME record. Adding a `routes` entry makes `workers_dev` default to `false`, so
set it explicitly to keep both hostnames. Custom domains support multiple stacked
hostnames and second-level subdomains.

The API base URL becomes `https://images.example.com/v1`.

### 8. Optional: separate environments

Bindings and variables are not inherited, so each environment repeats its own.
`BRIDGE_TOKEN` is a secret and is therefore set per environment:

```jsonc
{
  "name": "cf-image-bridge",
  "env": {
    "staging": { "name": "cf-image-bridge-staging" }
  }
}
```

```sh
npx wrangler deploy --env staging
npx wrangler secret put BRIDGE_TOKEN --env staging
```

Use a different token per environment so a leak in one does not unlock the other.

### 9. Update the model registry on a live deployment

`config/models.json` is bundled into the Worker at build time. Two ways to change it
without touching code:

**Per deployment, from the repository** — edit `config/models.json`, then
`npx wrangler deploy`. Validated at request time.

**Without a rebuild** — set the `MODELS_JSON` variable to the same JSON, as a single
line:

```sh
npx wrangler secret put MODELS_JSON     # or a plain-text [vars] entry, not sensitive
```

```jsonc
{
  "vars": {
    "MODELS_JSON": "{\"defaultModel\":\"flux-schnell\",\"models\":[{\"name\":\"flux-schnell\",\"id\":\"@cf/black-forest-labs/flux-1-schnell\",\"params\":{\"steps\":4}}]}"
  }
}
```

`MODELS_JSON` wins over the bundled file when set. An invalid value makes every request
return `500 misconfigured` with the exact problem list, including on `GET /v1/models`,
so a bad rollout is visible immediately. Delete the variable to fall back to the
bundled registry.

### 10. Operations

| Task | Command |
| --- | --- |
| Redeploy after a code or registry change | `npx wrangler deploy` |
| Watch live logs | `npx wrangler tail` |
| List recent deployments | `npx wrangler deployments list` |
| Roll back to the previous deployment | `npx wrangler rollback` |
| List configured secrets | `npx wrangler secret list` |
| Remove a secret | `npx wrangler secret delete BRIDGE_TOKEN` |
| Delete the Worker | `npx wrangler delete` |

Monitor neuron usage at **Workers AI → dashboard**, and errors under
**Workers & Pages → your Worker → Logs**.

### 11. Quotas and limits

| Limit | Value |
| --- | --- |
| Free allocation | 10 000 neurons/day, resets at 00:00 UTC |
| Paid overage (Workers Paid) | $0.011 per 1 000 neurons |
| Text-to-image rate limit | 720 requests/minute |

Exceeding the daily allocation makes Workers AI calls fail; the bridge turns that into
`502 upstream_error` with the provider message. Generating `n` images costs `n` calls,
so keep `maxImages` conservative if the bridge is shared.

### 12. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `500 misconfigured`, message mentions `BRIDGE_TOKEN` | Secret not set on this Worker (or on this environment). | `npx wrangler secret put BRIDGE_TOKEN`; check you used the right `--env`. |
| `500 misconfigured`, message mentions the registry | `MODELS_JSON` or `config/models.json` is invalid; the message lists each problem. | Fix the JSON; delete a stale `MODELS_JSON`. |
| `401 invalid_api_key` | Client sent no token, a wrong token, or the literal string `$BRIDGE_TOKEN` because the variable was unset in its shell. | Export the real value in the shell that launches the client. |
| `404 model_not_found` | Requested model is not a registry `name`. | `GET /v1/models` and use one of the returned ids. |
| `400 unsupported_parameter` | More `input_references` than `references.max`, or `n` above `maxImages`, or an edit on a model with `references.max: 0`. | Raise the limit in the registry or change the request. |
| `502 upstream_error` | Workers AI rejected the call (quota exhausted, model unavailable, bad params). | Read the message; check neuron usage and the model id. |
| `wrangler deploy` fails on a name mismatch | The dashboard Worker and `name` in `wrangler.jsonc` differ. | Align them, or delete the orphan Worker. |
| Deploy succeeds but the URL 404s | `workers_dev: false` and no route matched. | Add a `routes` entry or re-enable `workers_dev`. |

---

## Configuration reference

### Model registry

`config/models.json` is the single source of truth. It is validated on every request;
an invalid registry returns `500 misconfigured` with the list of problems instead of
half-working.

```jsonc
{
  "$schema": "./models.schema.json",
  "defaultModel": "flux-2-klein-4b",   // used when a request omits `model`
  "maxPromptLength": 2048,             // prompt characters accepted
  "maxImages": 4,                      // upper bound for OpenAI's `n`
  "models": [
    {
      "name": "flux-2-klein-4b",                       // exposed as the OpenAI model id
      "id": "@cf/black-forest-labs/flux-2-klein-4b",   // Workers AI model id
      "transport": "multipart",                        // "multipart" | "json"
      "size": { "min": 256, "max": 1920, "step": 16, "default": [1024, 1024] },
      "references": { "max": 4 },                      // 0 disables edits
      "params": {}                                     // merged into every request
    },
    {
      "name": "flux-schnell",
      "id": "@cf/black-forest-labs/flux-1-schnell",
      "transport": "json",
      "size": null,                                    // fixed-size model
      "references": { "max": 0 },
      "params": { "steps": 4 }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `transport` | `json` sends a JSON body, `multipart` sends FormData (required for any model that accepts references). |
| `size` | `null` = the model ignores `size`. Otherwise `min`/`max`/`step` clamp and round the requested size; `default` is `[width, height]`. |
| `size.format` | `"wh"` sends `width` + `height` (default); `"size"` sends one `"1024x1024"` field. Field names are configurable via `widthField`, `heightField`, `sizeField`. |
| `references.max` | Maximum input images. Images are posted as form fields named by `references.field`, which must contain `{index}` when `max > 1`. |
| `params` | Extra model parameters (`steps`, `guidance`, …) added to every request; multipart values are stringified. |

Adding a model is a config change only — no code edit:

```jsonc
{
  "name": "my-model",
  "id": "@cf/vendor/their-model",
  "transport": "multipart",
  "size": { "max": 1024, "step": 64, "format": "size", "sizeField": "resolution" },
  "references": { "max": 2, "field": "ref_{index}" },
  "params": { "guidance": 3.5 }
}
```

The full contract is described by `config/models.schema.json` (any JSON Schema validator
or editor with JSON Schema support will complete and check it).

### Request translation

| OpenAI request | Worker behaviour |
| --- | --- |
| `prompt` | Trimmed; required; `maxPromptLength` limit. |
| `model` | Matched against registry `name`; unknown names return `404 model_not_found`. |
| `size` | `"WxH"` or `[w, h]`, scaled to fit `max`, clamped to `min..max`, rounded up to `step`. Anything else (including `"auto"`) falls back to `default`. |
| `n` | Generates that many images (`1..maxImages`); each image is one Workers AI call. |
| `input_references` / `images` | OpenAI `image_url` objects or strings holding `data:` URLs (base64). Non-data URLs are rejected. |
| Rejected | Any model without reference support, more references than allowed, or an edit with no image. |

Responses follow the OpenAI Images shape plus a detected media type:

```json
{ "created": 1762345678, "data": [{ "b64_json": "/9j/4AAQ...", "media_type": "image/jpeg" }] }
```

Errors use `{ "error": { "message", "type", "code", "param"? } }` with
`400` / `401` / `404` / `405` / `500` / `502` statuses.

## Bundled models

The default registry ships two Workers AI models. Both contracts were verified against
the live API; they are examples, not requirements.

| Name | Workers AI id | Size control | Image edits |
| --- | --- | --- | --- |
| `flux-2-klein-4b` (default) | `@cf/black-forest-labs/flux-2-klein-4b` | 256–1920, stepped by 16 px | up to 4 references |
| `flux-schnell` | `@cf/black-forest-labs/flux-1-schnell` | none, always 1024×1024 | no |

Notes from the live API:

- `flux-1-schnell` rejects `width`, `height`, `seed` and `num_steps` with HTTP 400
  (`additionalProperties: false`); only `prompt` and `steps` are accepted.
- `flux-2-klein-4b` takes multipart form data even for prompt-only requests, honours
  `width`/`height`, and accepts `input_image_0..3`.
- Both return JPEG payloads; `media_type` reports the real container.

## Cost

Workers AI free plan: 10 000 neurons/day, no credit card.

| Model | Neurons per 1024² image | Images/day (approx.) |
| --- | --- | --- |
| `flux-schnell` @ 4 steps | ~58 | ~173 |
| `flux-2-klein-4b` | ~104 | ~96 |

An edit adds ~5.37 neurons per input tile on klein. Klein is the stronger model and
still cheap; use `flux-schnell` for quick layout placeholders (~2× cheaper, ~3× faster).

## Local development

`wrangler dev` runs the real Worker with the real Workers AI binding — Workers AI
requests reach your account and count against the quota even locally:

```sh
cp .dev.vars.example .dev.vars     # then set BRIDGE_TOKEN
npx wrangler dev                   # http://localhost:8787
```

`test/dev-server.mjs` runs the same Worker over plain HTTP with a stubbed Workers AI
binding that returns a generated PNG — no Cloudflare account, network or quota use:

```sh
npm run serve:stub                  # http://127.0.0.1:8898
# MODELS_JSON='{...}' npm run serve:stub    # exercise a custom registry
```

Point any OpenAI Images client at that `/v1` URL with
`Authorization: Bearer local-dev-token` (or your `BRIDGE_TOKEN`).

### Tests

```sh
npm test
```

The harness exercises the OpenAI request/response contract, size snapping and clamping,
JSON-vs-multipart dispatch, parameter merging, reference limits and field naming,
`n` handling, auth failures, registry validation, and `media_type` detection.

## Using it with omp

`~/.omp/agent/models.yml`:

```yaml
providers:
  cf-img:
    baseUrl: https://cf-image-bridge.<your-subdomain>.workers.dev/v1
    apiKey: BRIDGE_TOKEN          # env var name, not the value
    models:
      - id: flux-2-klein-4b
        api: openai-images
      - id: flux-schnell
        api: openai-images
```

`api: openai-images` is required per model — it is what selects the OpenAI Images
transport (`/images/generations`, `/images/edits`).

`~/.omp/agent/config.yml`:

```yaml
generate_image:
  enabled: true
modelRoles:
  image: cf-img/flux-2-klein-4b
```

The `id` values must match `name` entries in `config/models.json`. `BRIDGE_TOKEN` must be
exported in the shell that launches omp. An unset variable is not an error in omp: it
sends the literal string as the key and gets a `401`.

The same configuration works for any OpenAI-compatible Images client — set the base URL
to `.../v1` and the API key to your token.

## Security

- Never commit `.dev.vars`, real tokens, account ids or deployed Worker hostnames.
  `.gitignore` already excludes `.dev.vars`, `.wrangler/` and logs.
- `wrangler secret` values are encrypted and not readable after upload; prefer them over
  `[vars]` in `wrangler.jsonc`.
- Rotate the token with `npx wrangler secret put BRIDGE_TOKEN` and update your clients.
- The Worker holds no user data; images are generated per request and never stored.
- `GET /v1/models` is intentionally public. Everything else requires the bearer token.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: `npm test` must pass, models go
in `config/models.json`, and CI also validates the registry against its schema and checks
that the bundle inlines it.

## License

MIT
