# Contributing

Thanks for taking a look. This is a small, deliberately boring project: one Worker,
one JSON registry, one test harness. Please keep it that way.

## Ground rules

- **No model hardcoded in `src/worker.js`.** Model behaviour belongs in
  `config/models.json`, described by `config/models.schema.json`. If a model needs
  something the registry cannot express, extend the schema first and explain why in the
  PR.
- **No second configuration mechanism.** `config/models.json` plus `MODELS_JSON` is the
  whole contract. No YAML, no per-model environment variables, no constants in code.
- **Never weaken auth or validation to make something pass.** A failing token check or a
  rejected registry is a correct outcome.
- **Never commit secrets.** `.dev.vars` is ignored; deployed secrets go through
  `wrangler secret put`.

## Setup

```sh
npm install
npm test
```

`npm test` is offline: the harness stubs `env.AI`. No Cloudflare account is needed to
develop or to run the suite.

To exercise the Worker over HTTP:

```sh
npm run serve:stub        # http://127.0.0.1:8898, stubbed AI binding
cp .dev.vars.example .dev.vars && npx wrangler dev    # real binding, spends quota
```

## What a pull request needs

| Change | Required |
| --- | --- |
| Worker behaviour | `npm test` passes, plus a harness assertion for the changed path. |
| Registry / schema | Schema and bundled JSON stay in sync; the CI schema job passes. |
| New model | A registry entry only, plus a note on what was verified against the live API. |
| Docs | Keep `README.md` (humans), `AGENTS.md` (agents installing) and the skill in sync where they overlap. |

Run these before pushing; they are what CI runs:

```sh
npm test
npx wrangler deploy --dry-run --outdir dist
npx ajv-cli@5 validate --spec=draft2020 -s config/models.schema.json -d config/models.json --strict=false
```

## Tests

`test/harness.mjs` is a plain ESM script with its own `check()` helper — no test
framework, no config. Add assertions in the same style and keep them deterministic and
offline. Do not test incidental details (exact prose, internal helper shapes); test
observable contract behaviour: status codes, error `code`/`param`, request shape sent to
`env.AI`, and response bodies.

## Reporting a bug

Include the response body, the status code, the relevant `config/models.json` entry, and
whether it reproduces against `npm run serve:stub`. Redact your `BRIDGE_TOKEN`, your
account id, and your `*.workers.dev` hostname.
