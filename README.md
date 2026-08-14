# dsh-gateway-provider

[![gitleaks](https://github.com/Luck9Star/dsh-gateway-provider/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/Luck9Star/dsh-gateway-provider/actions/workflows/gitleaks.yml)

> 中文文档：[README.zh.md](README.zh.md)

Bring any LLM gateway — **newapi, LiteLLM, Higress, or any OpenAI-compatible
endpoint** — into DeepSeek Harness. The plugin discovers the gateway's model
list automatically, enriches every model with real parameters from
[models.dev](https://models.dev), and serves each model over its native wire
protocol (OpenAI / Anthropic / Gemini) through the pi-ai SDK.

## Why this exists

DeepSeek Harness ships first-party adapters (`llm-deepseek`, `llm-pi-ai`) that
each speak for one provider. If your models live behind a gateway, the
alternative is a hand-maintained static model list with guessed context
windows and output caps.

This plugin mounts the gateway itself: **N gateways become N provider
routes, with zero static model lists.** Every model keeps its true
parameters, and adding a model on the gateway side is enough — nothing to
re-deploy.

## What you get

- **Multiple gateways** — a default `newapi` route plus one `gateway:<id>`
  route per extra gateway, each with its own catalog cache.
- **Automatic discovery** — `GET {base}/v1/models` first (including each
  model's supported request formats), management API fallback second.
- **Real parameters** — models.dev data fills context window, output cap,
  reasoning levels, and release date; config defaults are only a fallback.
- **Every wire format** — each model routes to its own protocol
  (`openai-completions` / `openai-responses` / `anthropic-messages` /
  `google-generative-ai`); no hand-written SSE or request serialization.
- **A settings page** — **Settings → Gateway Models**: add and edit gateways
  from templates, test connections, hide / override / custom-add models —
  no YAML editing required.
- **A clean picker** — newest-first release-date sorting, chat-only filtering,
  and regex excludes for non-chat models.

## Requirements

- A DeepSeek Harness installation with a profile (`dsh`)
- A reachable gateway: newapi / LiteLLM / Higress / any OpenAI-compatible endpoint
- An API key for that gateway

## Quickstart

1. Install the plugin into your profile — straight from GitHub, no clone needed:

   ```bash
   dsh plugin --profile web add git+https://github.com/Luck9Star/dsh-gateway-provider.git
   ```

   `dsh plugin add` forwards to `pnpm add` in the profile directory, so any
   pnpm spec works (`github:Luck9Star/dsh-gateway-provider`, a local path, …).
   The bundle patch (`cordis.patch.yml`) then mounts the `llm-newapi` loader
   row automatically — no manual patch editing. The bare package name will
   resolve once the package is published to npm.

2. Store your gateway key in `$DSH_HOME/.credentials.yaml` (mode 0600,
   hot-reloaded):

   ```yaml
   NEWAPI_API_KEY: sk-REPLACE_WITH_YOUR_KEY
   ```

   Or export `NEWAPI_API_KEY` in the launching environment.

3. Restart the profile, then open **Settings → Gateway Models**.

**Success looks like:** the gateway appears with a "synced N models" badge,
and every chat-capable model is selectable with its real context window.
The base URL resolves from `llm-newapi.baseURL` settings →
`NEWAPI_BASE_URL` / `NEWAPI_API_URL` env → the public default
`https://api.newapi.ai`.

## Add more gateways

Extra gateways live in the `gateways` array — each becomes its own
`gateway:<id>` provider route:

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  gateways:
    - id: litellm-prod
      label: LiteLLM Prod
      baseURL: https://litellm.example.com
      apiKeyEnv: LITELLM_API_KEY
      flavor: litellm            # form template: newapi / litellm / higress / openai-compatible / custom

    # Fully-custom gateway: complete per-protocol endpoint URLs, no shared
    # base. A protocol left empty stays disabled.
    - id: edge
      label: Edge GW
      flavor: custom
      openaiURL: https://edge.example.com/openai/v1/chat/completions
      responsesURL: https://edge.example.com/openai/v1/responses
      anthropicURL: https://edge.example.com/anthropic/v1/messages
      apiKeyEnv: EDGE_API_KEY
```

You can also add gateways from the settings page (with the same templates)
instead of editing YAML.

## Control the model list per gateway

Hide models, fix wrong metadata, or add models the gateway does not list:

```yaml
llm-newapi:
  models:
    - id: glm-5.2
      disabled: true              # hide from picker
    - id: glm-5.2-highspeed
      contextWindow: 1000000      # override discovered value
      protocol: openai            # force protocol (openai/anthropic/gemini/openai-response)
    - id: my-internal-model       # custom model the gateway does not list
      name: My Internal Model
      contextWindow: 200000
```

The **Gateway Models** page exposes the same operations with a UI: search,
hidden/custom filters with counts, a per-model override editor (placeholders
show discovered values), connection test, and save/cancel semantics.

## Configuration reference

Section `llm-newapi:` of `$DSH_HOME/settings.yaml`. The flat fields
(`baseURL` / `apiKeyEnv` / …) seed the default `newapi` route; gateways in
the `gateways` array support most of the same fields per gateway
(`label` / `apiKeyEnv` / `flavor` / `catalogMode` / `endpointPriority` / …).

| Field | Default | Description |
|-------|---------|-------------|
| `label` | `NewAPI` | Display name of the default gateway route |
| `apiKeyEnv` | `NEWAPI_API_KEY` | Credential reference (environment variable name) |
| `baseURL` | env `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → `https://api.newapi.ai` | Gateway base URL (unused when protocol URLs are set) |
| `flavor` | `newapi` | Gateway template: `newapi` / `litellm` / `higress` / `openai-compatible` / `custom` |
| `openaiURL` | – | Full chat-completions endpoint URL (custom template; empty = protocol disabled) |
| `responsesURL` | – | Full Responses endpoint URL (custom template; empty = protocol disabled) |
| `anthropicURL` | – | Full Anthropic messages endpoint URL (custom template; empty = protocol disabled) |
| `modelsUrl` | `https://models.dev/models.json` | models.dev source (`file:` URLs work offline) |
| `useModelsDev` | `true` | Enrich gateway models with models.dev parameters |
| `extendedReasoningLevels` | `false` | Widen the unknown-model reasoning fallback to off~max (default off/low/medium/high) |
| `sortModelsByRelease` | `true` | Sort the picker newest-first by release date (unknown dates first) |
| `catalogMode` | `auto` | Model-list source: `auto` / `v1` / `management` |
| `catalogTtlMs` | `1800000` | Model-list cache freshness window |
| `includeChatOnly` | `true` | Only expose chat-capable models to the picker |
| `excludePatterns` | image/speech/embed/… | Regex patterns excluding models from the picker |
| `endpointPriority` | `["openai-response","anthropic","openai","gemini"]` | Wire-format preference order (first match wins per model) |
| `userId` | `1` | `New-Api-User` header for the management API |
| `maxTokens` | `32768` | Output cap fallback when models.dev lacks data |
| `defaultContextWindow` | `128000` | Context window fallback when models.dev lacks data |
| `streamIdleTimeoutMs` | `300000` | Stream idle watchdog |
| `retryPolicy` | standard | Same shape as `llm-deepseek` |

## How it works

All wire-format concerns are delegated to
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
— the same SDK the official `dsh-llm-pi-ai` adapter uses. Per request:

```
harness GenerateOptions
  → toPiContext()          lib/pi-bridge.js   harness messages → pi-ai Context
  → models.streamSimple()  pi-ai SDK          dispatches by each model's `api`
  → toStreamChunks()       lib/pi-bridge.js   pi-ai events → harness chunks
```

Each discovered model is built with an `api` field mapped from the gateway's
advertised `supported_endpoint_types`, honoring `endpointPriority`; the
pi-ai provider receives an api *map*, so every model routes to its own
protocol implementation. `sdkBaseURL()` appends `/v1` for OpenAI-protocol
models and leaves Anthropic/Google bases untouched.

```
dsh-gateway-provider/
├── index.js            # plugin entry: Config, provider registration, settings/credentials
├── cordis.patch.yml    # dsh.bundle patch (auto-mounts via `dsh plugin add`)
├── lib/                # adapter, pi-provider, pi-bridge, catalog, modelsdev, thinking, client
├── test/               # smoke (live gateway) + offline units + settings-UI render
└── scripts/link.sh     # link profile node_modules for local checkouts
```

## Develop from a checkout

1. `bash scripts/link.sh` — symlink this package's `node_modules` to the
   profile's so bare `@deepseek-ai/*` imports resolve to the exact module
   instances the harness process uses (single-copy `instanceof` safety).
2. Register the checkout as a profile link dependency and install:

   ```bash
   cd "$DSH_HOME/profiles/web"
   # package.json dependencies: "dsh-gateway-provider": "link:/absolute/path/to/dsh-gateway-provider"
   # and add "dsh-gateway-provider" to the bundles list in the same file
   pnpm install
   ```

3. Restart the profile.

> ⚠️ Do **not** also insert `id: llm-newapi` into the profile's own
> `cordis.patch.yml` — the bundle layer already mounts it, and a duplicate
> raises `duplicate loader entry id` at boot.

Client-bundle edits hot-apply after a browser reload; host-half edits need a
profile restart.

### Tests

```bash
node test/smoke.mjs            # live gateway: catalog / openai × 2 / tools / anthropic / gemini / custom-urls
node test/smoke.mjs --only custom-urls
node test/protocol-urls.mjs    # offline: URL derivation + gateway resolution
node test/client-render.mjs    # offline: settings-UI render tree (zh + en)
```

Smoke-test credentials resolve from: process environment → plugin `.env` →
`$NEWAPI_ENV_FILE` (plus a legacy author-local fallback path).

## Security

- The API key is only resolved through `$DSH_HOME/.credentials.yaml` (0600)
  or the environment — never written to logs, config, or chat.
  Credential fields are edited masked on the web UI.
- No runtime `dependencies`; `peerDependencies` reuse the harness-installed
  `@deepseek-ai/*` packages and `@earendil-works/pi-ai`. Commits are gated
  by gitleaks locally (pre-commit) and in CI.

## License

MIT
