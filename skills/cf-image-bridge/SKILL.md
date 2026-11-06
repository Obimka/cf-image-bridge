---
name: cf-image-bridge
description: Configure an OpenAI-compatible image client (omp models.yml, or any OpenAI Images client) against a self-hosted cf-image-bridge Worker on Cloudflare Workers AI, and diagnose 401/404/400/502 responses.
---

# cf-image-bridge

A self-hosted Worker exposing an OpenAI-compatible Images API
(`POST /v1/images/generations`, `POST /v1/images/edits`) in front of Cloudflare
Workers AI. The user deploys it themselves; this skill wires a client to it and
debugs the result.

**This skill configures a client. It does not deploy the Worker.** Deployment is
`AGENTS.md` in the repository.

## What you need from the user

Ask for these; never guess them:

| Value | Where it comes from |
| --- | --- |
| Base URL | `https://<name>.<subdomain>.workers.dev/v1`, or a custom domain ending in `/v1` |
| Token | The `BRIDGE_TOKEN` value they set with `wrangler secret put` |
| Model ids | The `name` fields in the deployment's `config/models.json` |

Never ask the user to paste the token into the conversation. Have them export it
in their own shell, then reference the variable name.

## Configure omp

`~/.omp/agent/models.yml`:

```yaml
providers:
  cf-img:
    baseUrl: https://<name>.<subdomain>.workers.dev/v1
    apiKey: BRIDGE_TOKEN      # env var NAME, resolved at request time
    models:
      - id: <model-name>
        api: openai-images
      - id: <second-model-name>
        api: openai-images
```

`~/.omp/agent/config.yml`:

```yaml
generate_image:
  enabled: true
modelRoles:
  image: cf-img/<model-name>
```

Rules that are easy to get wrong:

- `api: openai-images` is required. Workers AI is not reachable through
  `openai-completions` for image generation.
- `id` must equal a registry `name`, **not** the Workers AI `@cf/...` id.
- `apiKey` takes an environment variable name, not a literal secret.
- `generate_image.enabled` defaults to `false`; without it the tool never appears.
- Multiple models need one `- id:` entry each; the role chain picks `modelRoles.image`.

Verify without spending quota:

```sh
curl -s <base-url>/models            # 200, lists the registry names
```

Then, if the user accepts the neuron cost, a single small generation.

## Other clients

Anything speaking the OpenAI Images API:

```sh
export OPENAI_BASE_URL=https://<host>/v1
export OPENAI_API_KEY=$BRIDGE_TOKEN
curl -s $OPENAI_BASE_URL/images/generations \
  -H "authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"<model-name>","prompt":"a teal poster","size":"1024x1024"}'
```

The response carries `data[].b64_json` plus `media_type`, because Workers AI
models return JPEG even when the client expects PNG. Name files by `media_type`.

## Diagnose

| Response | Cause | Fix |
| --- | --- | --- |
| `500 misconfigured` mentioning `BRIDGE_TOKEN` | Secret unset on that Worker or environment | `wrangler secret put BRIDGE_TOKEN [--env <env>]` |
| `500 misconfigured` mentioning the registry | `config/models.json` or `MODELS_JSON` invalid; message lists problems | Fix the registry, or delete a stale `MODELS_JSON` |
| `401 invalid_api_key` | No token, wrong token, or a literal `$BRIDGE_TOKEN` because the variable was unset | Export the real value in the shell launching the client |
| `404 model_not_found` | `id` is not a registry `name` | `GET /v1/models`; use a returned id |
| `400 unsupported_parameter` | Too many `input_references`, `n` > `maxImages`, or an edit on a model with `references.max: 0` | Change the request or raise the registry limit |
| `400` with `param: "input_references"` | Reference is not a `data:` URL, or an edit sent no image | Send base64 `data:` URLs; edits need at least one |
| `502 upstream_error` | Workers AI rejected the call: quota exhausted, model unavailable, bad params | Read the message; check the 10 000 neurons/day free allocation |
| `404` on every path | `workers_dev: false` with no matching route | Add a `routes` entry or re-enable `workers_dev` |
| Tool absent entirely | `generate_image.enabled` false, or `modelRoles.image` unset/unresolvable | Set both; restart the session |

`GET /v1/models` is public by design — a 401 there means the URL is wrong, not
the token.

## Boundaries

- Do not deploy, redeploy, or run `wrangler delete` from this skill unless the
  user explicitly asks; that belongs to `AGENTS.md`.
- Do not add a model id the user did not name. Workers AI ids are
  `@cf/<vendor>/<model>` and must exist in the deployment's registry.
- Do not weaken auth or disable the token check to make a request succeed.
- Live generations spend the account's daily quota; ask first.
