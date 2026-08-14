# dsh-newapi-provider

**NewAPI (new-api gateway) model provider plugin for DeepSeek Harness** — registers
a `newapi` provider route on the harness LLM seam (`ctx.llm`). Pure ESM, zero
runtime dependencies (`fetch` only). No static model list — everything is
discovered and driven automatically:

1. **Automatic model discovery** — pulls the live model list from your gateway:
   - Primary: `GET {base}/v1/models` (OpenAI-compatible; every entry carries
     `supported_endpoint_types` — the per-model supported request formats);
   - Fallback: `GET {base}/api/user/models` (management API, flat id list).
2. **Automatic model control from models.dev** — enriches every model with
   <https://models.dev/models.json> parameters (`limit.context` / `limit.output` /
   `reasoning` / `family` / description) so context windows, output caps,
   reasoning levels, display names, and descriptions are real instead of
   one-size-fits-all. Namespaced keys (`minimax/MiniMax-M3`) are matched
   fuzzily; missing entries fall back to configured defaults.
3. **Per-model request URL auto-assembly** — for each request, the wire format
   is selected from the model's advertised `supported_endpoint_types` (intersected
   with the plugin's priority) and the matching gateway URL is constructed:
   - `openai` → `POST {base}/v1/chat/completions`
   - `anthropic` → `POST {base}/v1/messages`
   - `gemini` → `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`
4. **Thinking levels from the harness's own model directory** — the reasoning
   selector reuses DeepSeek Harness's pi-ai model catalog (the library behind
   the official `llm-pi-ai` adapter, installed with every deployment): each
   model's entry carries `reasoning` + a `thinkingLevelMap` spelling the
   provider-native wire value per thinking level, and the selectable levels
   are computed with pi-ai's own `getSupportedThinkingLevels` (`off` /
   `minimal` / `low` / `medium` / `high` / `xhigh` / `max`, with the catalog's
   per-level support matrix — e.g. GLM-5.2 declares `off` unsupported,
   GPT-5.5 exposes `xhigh`, Kimi K2.6 sends `thinking` only). Wire serialization
   mirrors pi-ai's openai-completions dispatch (`thinkingFormat === "deepseek"`
   → `thinking` + `reasoning_effort`, otherwise OpenAI-style `reasoning_effort`
   mapped through `thinkingLevelMap`); MiniMax keeps the gateway-verified
   `thinking: {type: adaptive|disabled}`. Gateway ids are first normalized
   (`provider/` prefix and `-highspeed`/`-lowspeed` channel suffixes stripped)
   and same-named models across providers resolve to their first-party entry
   (zai/deepseek/minimax/… before openrouter/opencode aggregators), so
   `glm-5.2-highspeed` normalizes to `glm-5.2`. Models the catalog misses fall
   back to models.dev inference (`reasoning: true` + family), whose family
   fallback defaults to off/low/medium/high unless `extendedReasoningLevels`
   widens it to the full off~max set.
5. **Operational hygiene** — model list is TTL-cached and lazily refreshed;
   non-chat models (image / speech / embedding / rerank / …) are excluded from
   the picker by default (`excludePatterns`); HTTP errors are mapped to stable
   harness codes (AUTH / RATE_LIMIT / QUOTA_EXCEEDED / CONTEXT_WINDOW_EXCEEDED /
   SERVER / TRANSPORT …) with `retry-after` and `x-request-id` support, plus a
   stream idle watchdog.

## Layout

```
dsh-newapi-provider/
├── index.js            # plugin entry: Config validation, provider registration, settings/credentials wiring
├── cordis.patch.yml    # dsh.bundle patch (makes the package installable via `dsh plugin add`)
├── lib/
│   ├── catalog.js      # gateway model discovery + models.dev merge + TTL cache + picker filter
│   ├── modelsdev.js    # models.dev fetch / fuzzy key match / parameter extraction
│   ├── wire.js         # endpoint selection + per-format URL assembly
│   ├── serialize.js    # harness messages → openai / anthropic / gemini request bodies
│   ├── translate.js    # three wire formats' SSE → harness StreamChunk
│   ├── sse.js          # zero-dependency SSE parser
│   └── adapter.js      # NewapiAdapter (LlmAdapter subclass)
├── test/smoke.mjs      # standalone integration smoke tests against a live gateway
└── scripts/link.sh     # link the harness profile node_modules (single-instance safety)
```

## Install

### On a DeepSeek Harness profile

The package declares a `dsh.bundle` manifest, so it joins the profile layer
stack the standard way:

```bash
# from anywhere: installs into the profile and activates the bundle patch
dsh plugin --profile web add dsh-newapi-provider
```

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

3. Restart the profile (bundles are read at boot) and open **Settings → Models**:
   the **NewAPI (newapi)** provider appears, and every chat-capable gateway
   model (with models.dev parameters) becomes selectable.

### Local checkout (no restart needed)

The web profile hot-reloads its user patch layer, so a local checkout can be
mounted live:

1. `bash scripts/link.sh` — symlinks this package's `node_modules` to the
   profile's, so bare `@deepseek-ai/*` imports resolve to the exact module
   instances the harness process uses (single-copy `instanceof` safety).
2. Add a row to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: llm-newapi
         name: '<absolute-or-profile-relative path to>/index.js'
   ```

   After editing plugin sources, bump a query string on `name`
   (e.g. `index.js?v=3`) to force a fresh module import.

## Web configuration (Models page)

The official **Settings → Models** editor only knows the shipped `llm-deepseek`
and `llm-pi-ai` namespaces; a third-party provider namespace renders as a hint
with saving disabled. This package ships a small patch that teaches the Models
page the deepseek editor layout (API key + base URL + model catalog) for
`llm-newapi`:

```bash
node scripts/patch-web-ui.mjs apply     # patch the profile bundle (idempotent)
node scripts/patch-web-ui.mjs verify    # check state
node scripts/patch-web-ui.mjs restore   # revert
```

After `apply`, reload the browser: **Settings → Models → Edit NewAPI** shows the
API key field and (under 自定义设置) the base URL — saving writes
`llm-newapi:` to `$DSH_HOME/settings.yaml` (hot-reloaded) and the key to the
credential store.

> ⚠️ A DeepSeek Harness upgrade reinstalls the bundle and drops the patch —
> re-run `node scripts/patch-web-ui.mjs apply` after upgrading. This patch only
> touches your local profile installation; the published package itself is
> unmodified upstream code.

All other settings (`catalogMode`, `endpointPriority`, `excludePatterns`, …)
are edited in the `llm-newapi:` section of `$DSH_HOME/settings.yaml`.

## Configuration (`llm-newapi:` section of `$DSH_HOME/settings.yaml`)

| Field | Default | Description |
|-------|---------|-------------|
| `apiKeyEnv` | `NEWAPI_API_KEY` | Credential reference (environment variable name) |
| `baseURL` | env `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → `https://api.newapi.ai` | Gateway base URL |
| `modelsUrl` | `https://models.dev/models.json` | models.dev source (file: URLs work offline) |
| `useModelsDev` | `true` | Enrich gateway models with models.dev parameters |
| `extendedReasoningLevels` | `false` | Widen the unknown-model reasoning fallback to the full off~max set (default off/low/medium/high) |
| `catalogMode` | `auto` | `auto` / `v1` / `management` model-list source |
| `catalogTtlMs` | `1800000` | Model-list cache freshness window |
| `includeChatOnly` | `true` | Only expose chat-capable models to the picker |
| `excludePatterns` | image/speech/embed/… | Regex patterns excluding models from the picker |
| `endpointPriority` | `["openai","anthropic","gemini"]` | Wire-format preference order |
| `userId` | `1` | `New-Api-User` header for the management API |
| `maxTokens` | `32768` | Output cap fallback when models.dev lacks data |
| `defaultContextWindow` | `128000` | Context window fallback when models.dev lacks data |
| `streamIdleTimeoutMs` | `300000` | Stream idle watchdog |
| `retryPolicy` | standard | Same shape as `llm-deepseek` |

Example:

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  endpointPriority: [openai, anthropic, gemini]
  excludePatterns: ["(^|/|-)image", "(^|/|-)speech"]
```

## Testing

```bash
cd dsh-newapi-provider
node test/smoke.mjs            # all: catalog / openai × 2 / tool calling / anthropic / gemini
node test/smoke.mjs --only catalog
```

Environment resolution order for the smoke test: process environment →
plugin `.env` → `~/Documents/dev/Agents/dsh-newapi/.env` (override with
`NEWAPI_ENV_FILE`). Covered: gateway model discovery + picker filtering,
models.dev parameter merging (deepseek-v4-flash = 1M context / MiniMax-M3 =
512K), all three wire formats against a live gateway, and a tool-call round trip.

## Security notes

- The API key is only ever resolved through `$DSH_HOME/.credentials.yaml`
  (0600) or the environment; it is never written to logs, config, or chat.
  Credential-reference fields (`credential-ref`) are edited masked on the
  web Models page.
- The package declares no runtime `dependencies`; `peerDependencies` reuse
  the harness-installed `@deepseek-ai/*` packages, and `scripts/link.sh`
  guarantees single-instance loading for local checkouts.

## License

MIT
