# dsh-gateway-provider

> 中文文档：[README.zh.md](README.zh.md)

**Generic LLM gateway model provider plugin for DeepSeek Harness** — registers
one or more gateway provider routes (the default `newapi` route plus optional
`gateway:<id>` routes) on the harness LLM seam (`ctx.llm`). Supports newapi /
LiteLLM / any OpenAI-compatible gateway. Pure ESM. No static model list —
everything is discovered and driven automatically:

1. **Multiple gateways at once** — the legacy single-connection fields
   (`baseURL` / `apiKeyEnv` / …) always seed the default `newapi` route (fully
   backwards compatible); the new `gateways` array mounts more gateways, each
   becoming its own `gateway:<id>` provider route with an independent catalog cache.
2. **Per-model wire protocol via pi-ai SDK** — each model's
   `supported_endpoint_types` (advertised by the gateway) are mapped to pi-ai
   API identifiers (`openai-completions` / `openai-responses` /
   `anthropic-messages` / `google-generative-ai`) and dispatched through the
   official `@earendil-works/pi-ai` protocol layer. No hand-written SSE or
   request-body serialization — the SDK speaks every wire format natively.
3. **Automatic model discovery** — pulls the live model list from each gateway:
   - Primary: `GET {base}/v1/models` (OpenAI-compatible; every entry carries
     `supported_endpoint_types` — the per-model supported request formats);
   - Fallback: `GET {base}/api/user/models` (management API, flat id list).
4. **Automatic model control from models.dev** — enriches every model with
   <https://models.dev/models.json> parameters (`limit.context` / `limit.output` /
   `reasoning` / `family` / `release_date`) so context windows, output caps,
   reasoning levels, and release dates are real instead of one-size-fits-all.
5. **Per-model toggle / override / custom-add** — a self-built "Gateway Models"
   settings page (independent of the shipped Models page, which only knows
   `llm-deepseek`/`llm-pi-ai`) with:
   - gateway-type **templates** (newapi / LiteLLM / Higress / OpenAI-compatible
     / fully custom) shaping the add-gateway form — the custom template takes
     fully-qualified per-protocol endpoint URLs (`openaiURL` / `responsesURL` /
     `anthropicURL`); a protocol left empty stays disabled and models are
     served only through configured protocols;
   - gateway config forms prefilled from current values, dirty tracking,
     http(s) URL validation, and clear-means-inherit semantics (label /
     apiKeyEnv / flavor / catalogMode per gateway);
   - a per-model override editor (display name, protocol, context window,
     output cap, reasoning levels) with discovered values as placeholders
     (`128K`-formatted hints) and save/cancel instead of write-on-keystroke;
   - model search + hidden/custom filters with counts, custom-model add &
     delete, connection test, and a "synced N models" feedback badge.
6. **Thinking levels from the harness's own model directory** — the reasoning
   selector reuses DeepSeek Harness's pi-ai model catalog: each model carries
   `reasoning` + a `thinkingLevelMap`, and selectable levels are computed with
   pi-ai's `getSupportedThinkingLevels`. Gateway ids are first normalized
   (`provider/` prefix and `-highspeed`/`-lowspeed` channel suffixes stripped)
   and same-named models across providers resolve to their first-party entry
   (zai/deepseek/minimax/… before aggregators), so `glm-5.2-highspeed`
   normalizes to `glm-5.2` but keeps a distinct display name.
7. **Release-date sorting** — the picker orders models newest-first by
   models.dev `release_date` (unknown dates sort first); opt out with
   `sortModelsByRelease: false`.
8. **Operational hygiene** — model lists are TTL-cached and lazily refreshed;
   non-chat models are excluded from the picker by default (`excludePatterns`);
   HTTP errors are mapped to stable harness codes with `retry-after` support.

## Architecture: pi-ai protocol layer

The adapter delegates all wire-format concerns to `@earendil-works/pi-ai`
(the same SDK the official `dsh-llm-pi-ai` adapter uses). The conversion
chain on each request is:

```
harness GenerateOptions
  → toPiContext()         (lib/pi-bridge.js — harness messages → pi-ai Context)
  → models.streamSimple()  (pi-ai SDK — dispatches by model.api)
  → toStreamChunks()       (lib/pi-bridge.js — pi-ai events → harness chunks)
```

Each discovered model is built with a `buildModel()` that stamps its `api`
field from the gateway's advertised `supported_endpoint_types`, honoring the
configured `endpointPriority`. The pi-ai `createProvider()` receives an `api`
**map** (not a single factory) so each model routes to its own protocol
implementation — OpenAI Responses models through `openai-responses`,
Anthropic models through `anthropic-messages`, etc.

The `sdkBaseURL()` helper appends `/v1` for OpenAI-protocol models (the
OpenAI Node SDK expects `/v1` in `baseURL` and appends `/responses` itself)
while leaving Anthropic/Google baseURLs unchanged (those SDKs build their own
full paths).

## Layout

```
dsh-gateway-provider/
├── index.js            # plugin entry: multi-gateway Config, provider registration, settings/credentials
├── cordis.patch.yml    # dsh.bundle patch (auto-mounts via `dsh plugin add` or link dependency)
├── lib/
│   ├── adapter.js      # NewapiAdapter: pi-ai-backed LlmAdapter (multi-gateway, per-provider connection)
│   ├── pi-provider.js  # gateway → pi-ai Provider: buildModel / buildProvider / pickModelApi / sdkBaseURL
│   ├── pi-bridge.js    # harness ↔ pi-ai conversion: toPiContext / toStreamChunks / mapStopReason / replay
│   ├── catalog.js      # gateway model discovery + models.dev merge + model override/custom + TTL cache
│   ├── modelsdev.js    # models.dev fetch / fuzzy key match / parameter extraction
│   ├── thinking.js     # pi-ai thinking levels + variant normalization (baseModelId/variantLabel/findPiModel)
│   └── client.js       # client half: self-built "Gateway Models" settings page (settings.section)
├── test/smoke.mjs      # standalone integration smoke tests against a live gateway
└── scripts/link.sh     # link the harness profile node_modules (single-instance safety)
```

## Install

### On a DeepSeek Harness profile

The package declares a `dsh.bundle` manifest, so it joins the profile layer
stack the standard way:

```bash
# from anywhere: installs into the profile and activates the bundle patch
dsh plugin --profile web add dsh-gateway-provider
```

The `dsh.bundle.patch` field in `package.json` points to `cordis.patch.yml`,
which inserts the `id: llm-newapi` loader row at the **bundle layer** — dsh
reads it at boot, so no manual `cordis.patch.yml` editing is needed.

Then:

1. **Credential** — store the gateway key in `$DSH_HOME/.credentials.yaml`
   (0600; the web Models page writes it too; hot-reloaded):

   ```yaml
   NEWAPI_API_KEY: sk-REPLACE_WITH_YOUR_KEY
   ```

   Or export `NEWAPI_API_KEY` in the launching environment.

2. **Base URL** — resolved per request from `llm-newapi.baseURL` settings,
   then `NEWAPI_BASE_URL` / `NEWAPI_API_URL` environment, then the public
   default `https://api.newapi.ai`.

3. Restart the profile (bundles are read at boot) and open **Settings →
   Gateway Models**: the provider appears, and every chat-capable gateway
   model (with models.dev parameters) becomes selectable.

### Local checkout (install by package name)

Mount the checkout the way every working third-party plugin on this machine is
mounted — as a **package-name** link dependency. The bundle's own
`cordis.patch.yml` handles the loader-row insert at the bundle layer, so you
only need to register the dependency.

1. `bash scripts/link.sh` — symlinks this package's `node_modules` to the
   profile's, so bare `@deepseek-ai/*` imports resolve to the exact module
   instances the harness process uses (single-copy `instanceof` safety).
2. Register the checkout as a profile link dependency and install it:

   ```bash
   cd "$DSH_HOME/profiles/web"
   # add to package.json dependencies:
   #   "dsh-gateway-provider": "link:/absolute/path/to/dsh-gateway-provider"
   # then add "dsh-gateway-provider" to the bundles list in the same file
   pnpm install
   ```

3. Restart the profile. The bundle layer auto-inserts the `id: llm-newapi`
   row (from `cordis.patch.yml`), so **Settings → Gateway Models** appears
   alongside the official Models page.

> ⚠️ Do **not** also insert `id: llm-newapi` in the profile's
> `cordis.patch.yml` (user patch layer) — the bundle layer already mounts it,
> and a duplicate causes a `duplicate loader entry id` error on boot.

Client-bundle edits hot-apply after a browser reload (the bundle's `rev` is its
content hash); host-half edits need a profile restart.

## Configuration (`llm-newapi:` section of `$DSH_HOME/settings.yaml`)

| Field | Default | Description |
|-------|---------|-------------|
| `label` | `NewAPI` | Display name of the default gateway route (editable in the settings UI) |
| `apiKeyEnv` | `NEWAPI_API_KEY` | Credential reference (environment variable name) |
| `baseURL` | env `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → `https://api.newapi.ai` | Gateway base URL (unused when protocol URLs are set) |
| `flavor` | `newapi` | Gateway template label: `newapi` / `litellm` / `higress` / `openai-compatible` / `custom` |
| `openaiURL` | – | Full chat-completions endpoint URL (custom template; empty = protocol disabled) |
| `responsesURL` | – | Full Responses endpoint URL (custom template; empty = protocol disabled) |
| `anthropicURL` | – | Full Anthropic messages endpoint URL (custom template; empty = protocol disabled) |
| `modelsUrl` | `https://models.dev/models.json` | models.dev source (file: URLs work offline) |
| `useModelsDev` | `true` | Enrich gateway models with models.dev parameters |
| `extendedReasoningLevels` | `false` | Widen the unknown-model reasoning fallback to the full off~max set (default off/low/medium/high) |
| `sortModelsByRelease` | `true` | Sort the picker newest-first by release date (models with an unknown date sort first) |
| `catalogMode` | `auto` | `auto` / `v1` / `management` model-list source |
| `catalogTtlMs` | `1800000` | Model-list cache freshness window |
| `includeChatOnly` | `true` | Only expose chat-capable models to the picker |
| `excludePatterns` | image/speech/embed/… | Regex patterns excluding models from the picker |
| `endpointPriority` | `["openai-response","anthropic","openai","gemini"]` | Wire-format preference order (first match wins per model) |
| `userId` | `1` | `New-Api-User` header for the management API |
| `maxTokens` | `32768` | Output cap fallback when models.dev lacks data |
| `defaultContextWindow` | `128000` | Context window fallback when models.dev lacks data |
| `streamIdleTimeoutMs` | `300000` | Stream idle watchdog |
| `retryPolicy` | standard | Same shape as `llm-deepseek` |

Example (single gateway, backwards compatible):

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  flavor: newapi
  endpointPriority: [openai-response, anthropic, openai, gemini]
  excludePatterns: ["(^|/|-)image", "(^|/|-)speech"]
```

Multiple gateways + model-level overrides:

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  flavor: newapi
  # Model-level overrides for the default gateway (hide / override / custom-add)
  models:
    - id: glm-5.2
      disabled: true              # hide from picker
    - id: glm-5.2-highspeed
      contextWindow: 1000000      # override context
      protocol: openai            # force protocol (openai/anthropic/gemini/openai-response)
    - id: my-internal-model       # custom model the gateway does not list
      name: My Internal Model
      contextWindow: 200000
  # Additional gateways: each becomes a gateway:<id> route
  gateways:
    - id: litellm-prod
      label: LiteLLM Prod
      baseURL: https://litellm.example.com
      apiKeyEnv: LITELLM_API_KEY
      flavor: litellm
    - id: custom-gw
      label: Custom Gateway
      baseURL: https://custom.example.com
      apiKeyEnv: CUSTOM_API_KEY
      endpointPriority: [openai-response, openai]  # per-gateway override
    # Fully-custom gateway: complete endpoint URLs, no shared base. Empty
    # protocols are disabled; discovery uses the OpenAI-style URL's base, or
    # nothing (declared models only) when only anthropicURL is set.
    - id: edge
      label: Edge GW
      flavor: custom
      openaiURL: https://edge.example.com/openai/v1/chat/completions
      responsesURL: https://edge.example.com/openai/v1/responses
      anthropicURL: https://edge.example.com/anthropic/v1/messages
      apiKeyEnv: EDGE_API_KEY
```

## Testing

```bash
cd dsh-gateway-provider
node test/smoke.mjs            # all: catalog / openai × 2 / tool calling / anthropic / gemini / custom-urls
node test/smoke.mjs --only custom-urls
node test/protocol-urls.mjs    # offline: URL derivation + gateway resolution units
node test/client-render.mjs    # offline: settings-UI render tree (zh + en)
```

Environment resolution order for the smoke test: process environment →
plugin `.env` → `~/Documents/dev/Agents/dsh-newapi/.env` (override with
`NEWAPI_ENV_FILE`). Covered: gateway model discovery + picker filtering,
models.dev parameter merging (deepseek-v4-flash = 1M context / MiniMax-M3 =
512K), all four pi-ai protocols against a live gateway, and a tool-call round trip.

## Security notes

- The API key is only ever resolved through `$DSH_HOME/.credentials.yaml`
  (0600) or the environment; it is never written to logs, config, or chat.
  Credential-reference fields (`credential-ref`) are edited masked on the
  web Models page.
- The package declares no runtime `dependencies`; `peerDependencies` reuse
  the harness-installed `@deepseek-ai/*` packages and `@earendil-works/pi-ai`,
  and `scripts/link.sh` guarantees single-instance loading for local checkouts.

## License

MIT
