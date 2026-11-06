# AGENTS.md

Instructions for an AI coding agent installing, configuring or maintaining
**cf-image-bridge**: an OpenAI-compatible Images API (`/v1/images/generations`,
`/v1/images/edits`) in front of Cloudflare Workers AI.

Read this file fully before acting. The human-facing install notice is `README.md`.

## Ground rules

1. **Never print, echo, log or commit a secret.** `BRIDGE_TOKEN`, `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` and the deployed hostname are private. When you must show a
   command, use placeholders (`<token>`, `<account-id>`, `<name>`, `<your-subdomain>`).
2. **Never write a token into a tracked file.** `.dev.vars` is git-ignored and is the
   only place a local token may live. Deployed secrets go through `wrangler secret`.
3. **Ask before spending money or quota.** A real generation on a deployed Worker spends
   the account's daily neuron budget. Prefer the stub server (`npm run serve:stub`) for
   verification and ask the user before hitting the live Worker or `wrangler dev`.
4. **Do not invent model ids.** Workers AI model ids are `@cf/<vendor>/<model>` and are
   listed at <https://developers.cloudflare.com/workers-ai/models/>. If a requested
   model is unknown, say so instead of guessing a plausible id.
5. **Prefer configuration over code.** New models belong in `config/models.json`. Only
   change `src/worker.js` when a model needs behaviour the registry cannot express.

## Repository map

| Path | Role |
| --- | --- |
| `src/worker.js` | The Worker. Routes, auth, registry validation, request translation. |
| `config/models.json` | Model registry: the only place models are declared. |
| `config/models.schema.json` | JSON Schema for the registry. |
| `wrangler.jsonc` | Worker name, entry point, `AI` binding, `workers_dev`. |
| `test/harness.mjs` | Node test suite, stubbed `env.AI`. `npm test`. |
| `test/dev-server.mjs` | HTTP server with a stubbed AI binding, real Worker code. |
| `.dev.vars.example` | Template for local development variables. |
| `skills/cf-image-bridge/SKILL.md` | Client-configuration skill: wires a client to a deployed Worker and diagnoses response codes. Not part of the install. |

Interfaces the Worker depends on:

- `env.AI.run(modelId, input)` → an object with `.image`, raw bytes, a `ReadableStream`,
  a `Blob`, or a base64 string. The Worker normalizes all of these.
- `env.BRIDGE_TOKEN` → the bearer token clients must present. Absent means `500`.
- `env.MODELS_JSON` → optional registry override, a JSON string or object.

## Installation procedure

Run these steps in order. Stop and report if any step fails; do not "fix" it by
loosening auth or disabling validation.

### Step 1 — Preconditions

```sh
node --version        # must be >= 20
npm install
npm test              # must pass before touching Cloudflare
```

`npm test` is offline and free. If it fails, fix the code before deploying.

### Step 2 — Confirm the Cloudflare account

Ask the user which account to use if `npx wrangler whoami` shows more than one, then:

```sh
npx wrangler whoami
```

- If the user prefers an API token over interactive login, have them export
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` themselves. Never ask the user to
  paste a token into the chat.
- Do not run `npx wrangler login` in a non-interactive session: it opens a browser.
  Ask the user to run it in their terminal instead.

### Step 3 — Pick the Worker name

Inspect `wrangler.jsonc`. The `name` becomes `<name>.<your-subdomain>.workers.dev` and
must be ≤63 chars, alphanumerics and dashes only. Change it only if the user asks or the
name is already taken in that account.

### Step 4 — First deploy

```sh
npx wrangler deploy
```

The first deploy creates the Worker and therefore needs product-level Workers **Admin**.
The resulting `*.workers.dev` URL is private: record it for the user's configuration,
but never commit it.

### Step 5 — Set the token

`wrangler secret put` requires the Worker to exist, so this is strictly after Step 4.

```sh
npx wrangler secret put BRIDGE_TOKEN
```

This reads the value from a prompt. **Do not generate a token and echo it.** Ask the
user to run this command in their own terminal, or to let you run it if your session has
an interactive prompt — and never capture its output.

Afterwards the only acceptable verification is that it exists:

```sh
npx wrangler secret list      # shows the name, never the value
```

### Step 6 — Verify without spending quota

```sh
BASE=https://<name>.<your-subdomain>.workers.dev
curl -s $BASE/v1/models                                        # 200, public
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  $BASE/v1/images/generations -H 'content-type: application/json' \
  -d '{"prompt":"x"}'                                          # 401
```

`GET /v1/models` returning 200 and an unauthenticated POST returning 401 proves routing,
registry loading and auth are correct. Both are free.

A real generation spends neurons: do it only if the user asks. When they do, never echo
the base64 payload — print the media type and byte length.

### Step 7 — Hand off the client configuration

Give the user the values for their client; the omp form is:

```yaml
providers:
  cf-img:
    baseUrl: https://<name>.<your-subdomain>.workers.dev/v1
    apiKey: BRIDGE_TOKEN          # env var name, not the value
    models:
      - id: <model name from config/models.json>
        api: openai-images
```

`api: openai-images` is required per model; a provider-level `api: openai-completions`
does not apply to image generation. Model ids in the client must equal `name` entries in
`config/models.json`, not the Workers AI `@cf/...` ids.

`skills/cf-image-bridge/SKILL.md` in this repository is the fuller client-side guide: it
covers omp plus generic OpenAI Images clients and maps each error response to its cause.
Install it with a symlink into the agent's skills directory if the user wants it
available in later sessions.

## Adding or changing a model

1. Read the model's Workers AI page. Record: id, whether it needs multipart, whether it
   honours `width`/`height`, how many input images it accepts, and its fixed parameters.
2. Add or edit an entry in `config/models.json`. Follow the field table in `README.md`
   and validate against `config/models.schema.json`.
3. Keep `defaultModel` pointing at an existing `name`.
4. `npm test`, then `npx wrangler deploy` if the user wants it live.

Constraints enforced at request time (an invalid registry fails every request, including
`GET /v1/models`, with `500 misconfigured`):

- `models` is non-empty, `name` unique, `id` non-empty.
- `references.max > 0` requires `transport: "multipart"`.
- `references.field` must contain `{index}` when `max > 1`.
- `size.min <= size.max`, `step` positive, `default` is `[width, height]`.
- `defaultModel` must exist.

`MODELS_JSON` overrides the bundled file per deployment; it is validated identically.
Prefer editing `config/models.json` for anything that should survive a redeploy.

## Verifying changes

| Change | Verification |
| --- | --- |
| `src/worker.js` | `npm test`, then `npm run serve:stub` + a curl for the changed path. |
| `config/models.json` | `npm test`; the harness validates the bundled registry. |
| `test/*` | `npm test`. |
| `wrangler.jsonc` | `npx wrangler deploy --dry-run` (free, no upload). |
| Deployed behaviour | Step 6 checks first; a live generation only with permission. |

Tests must stay offline and deterministic. The harness stubs `env.AI`; keep it that way.

## Failure playbook

| Error | Meaning | Action |
| --- | --- | --- |
| `500 misconfigured` / `BRIDGE_TOKEN` | Secret missing on this Worker or environment. | `npx wrangler secret put BRIDGE_TOKEN [--env <env>]`. |
| `500 misconfigured` / registry | `config/models.json` or `MODELS_JSON` invalid. | Fix the JSON; delete a stale `MODELS_JSON`. The message lists every problem. |
| `401 invalid_api_key` | Client sent no token, a wrong token, or a literal `$VAR`. | Export the real value in the client's shell. |
| `404 model_not_found` | Name not in the registry. | `GET /v1/models`; align the client id. |
| `400 unsupported_parameter` | Too many references, `n` too large, or edit on a reference-less model. | Change the request or raise the registry limit. |
| `502 upstream_error` | Workers AI rejected the call. | Read the message; check the daily neuron quota and the model id. |
| `wrangler deploy` name mismatch | Dashboard Worker and `name` differ. | Align them; do not delete a Worker without asking. |
| URL 404s after deploy | `workers_dev: false` with no matching route. | Add a `routes` entry or re-enable `workers_dev`. |

Never resolve an auth failure by removing the token check or making `BRIDGE_TOKEN`
optional. That turns a private bridge into an open one that spends the owner's quota.

## What not to do

- Do not commit `.dev.vars`, tokens, account ids or real `*.workers.dev` / custom
  hostnames.
- Do not add a second configuration mechanism (env-var-per-model, YAML, code constants).
  `config/models.json` plus `MODELS_JSON` is the whole contract.
- Do not hardcode model behaviour in `src/worker.js`; extend the registry schema instead.
- Do not weaken or delete tests to make a change pass. Update them when the contract
  genuinely changed, and say so.
- Do not run `npx wrangler delete`, `wrangler rollback` or `secret delete` without
  explicit confirmation.
