# dsh-gateway-provider

[![gitleaks](https://github.com/Luck9Star/dsh-gateway-provider/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/Luck9Star/dsh-gateway-provider/actions/workflows/gitleaks.yml)

> 中文文档：[docs/README.zh.md](docs/README.zh.md)

Use **all the models behind your LLM gateway** — newapi, LiteLLM, Higress,
or any OpenAI-compatible endpoint — directly in DeepSeek Harness.

Install the plugin, paste your API key, and every gateway model shows up in
dsh's model picker with its **real** parameters (context window, output cap,
reasoning support) fetched from [models.dev](https://models.dev). Requests
go out over each model's own native protocol — OpenAI, Anthropic, or Gemini
— so tool calls and streaming behave the way that model's maker intended.

## Why this exists

dsh ships one adapter per official provider. If your models live behind a
gateway, the manual alternative is a hand-maintained static model list with
guessed context windows and output caps. This plugin mounts the gateway
itself instead:

- **Nothing to maintain by hand** — the model list is read from the gateway
  (`GET /v1/models`, with a management-API fallback for newapi); add a model
  on the gateway side and it appears in dsh, no re-deploy.
- **Real numbers, not guesses** — models.dev data fills context window,
  output cap, reasoning levels, release date; config defaults only fill gaps.
- **Every wire format, one plugin** — each model routes over its own
  protocol (OpenAI chat completions / OpenAI responses / Anthropic messages
  / Gemini), handled by the same
  [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) SDK the
  official dsh adapter uses.
- **Multiple gateways at once** — a default `newapi` route plus one
  `gateway:<id>` route per extra gateway, each with its own cache and key.
- **A settings page instead of YAML** — **Settings → Gateway Models**: add
  gateways from templates (NewAPI / LiteLLM / Higress / OpenAI-compatible /
  fully custom), test connections, sync models, hide or override any model,
  add custom models.

## Requirements

- DeepSeek Harness (dsh) with a `web` profile (the settings page is a web-UI
  extension; the provider itself works in any profile).
- A gateway API key (e.g. a newapi token).

## Install

```sh
# 1. Install the plugin (dsh plugin add runs pnpm add under the hood)
dsh plugin --profile web add dsh-gateway-provider

# 2. Store your key — pick ONE of:
#    a) the dsh credentials file (recommended; created with mode 0600, hot-reloaded)
echo "NEWAPI_API_KEY: sk-REPLACE_WITH_YOUR_KEY" >> ~/.dsh/.credentials.yaml
#    b) or export it in the shell you launch dsh from:
#       export NEWAPI_API_KEY=sk-REPLACE_WITH_YOUR_KEY

# 3. Restart and open the settings page
dsh --profile web
# → Settings → Gateway Models
```

**Expected result:** the model picker gains a "NewAPI" route listing your
gateway's chat models, newest first. Click **Test** on the gateway card —
it should answer `✓ Connected — N models`. Not using the public newapi
cloud? Set **Base URL** on the card (or `baseURL` in config) to your own
gateway address first.

## Daily use

Everything lives in **Settings → Gateway Models**:

- **Add more gateways** — "Add Gateway", pick a template (LiteLLM, Higress,
  OpenAI-compatible, or fully custom with per-protocol URLs), point it at
  the base URL, name its key env var, Test, Sync. Each gateway becomes its
  own route in the picker.
- **Tame the model list** — non-chat models (image / speech / embedding /
  rerank …) are excluded by default regexes; hide or rename any model; add
  a custom model by hand if the gateway hides it; per-model protocol,
  context window, output cap, and reasoning levels are all editable.
- **Keys live in dsh's credential store** — the settings page shows a badge
  (`✓ Key set · NEWAPI_API_KEY` / `⚠ No key set`) and can write the key
  there for you.

## Configuration reference

Optional — everything below has a working default. Config lives in the
`llm-newapi:` section of `~/.dsh/settings.yaml` (the settings page edits
the same keys). The frequently used ones:

| Key | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://api.newapi.ai` | Your gateway's base URL. Env fallbacks: `NEWAPI_BASE_URL`, `NEWAPI_API_URL`. |
| `apiKeyEnv` | `NEWAPI_API_KEY` | Which env/credential variable holds the key. |
| `label` | `NewAPI` | Route label shown in the picker. |
| `flavor` | `newapi` | Template label only (`newapi` / `litellm` / `higress` / `openai-compatible` / `custom`). |
| `gateways` | — | Array of extra gateways: `{ id, baseURL, apiKeyEnv, label, … }`, each becoming a `gateway:<id>` route. |
| `models` | — | Per-model overrides: `{ id, name, disabled, protocol, contextWindow, maxTokens, reasoningLevels }`. |
| `useModelsDev` / `modelsUrl` | `true` / models.dev | Parameter enrichment source (supports `file:` URLs for offline). |
| `excludePatterns` | image/speech/… | Regex list of model ids to keep out of the picker. |
| `sortModelsByRelease` | `true` | Newest models first. |
| `catalogMode` | `auto` | `v1` (`/v1/models` only) / `management` (newapi user API) / `auto`. |
| `endpointPriority` | responses → anthropic → openai → gemini | Which protocol to prefer when a model supports several. |
| `openaiURL` / `responsesURL` / `anthropicURL` | — | Fully-custom gateways only: per-protocol endpoint URLs; unset = that protocol off. |
| `maxTokens` / `defaultContextWindow` | `32768` / `128000` | Fallbacks when models.dev has no data. |
| `streamIdleTimeoutMs` | `600000` | Idle timeout while streaming. |
| `headers` | — | Extra HTTP headers sent to the gateway. |

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| Picker route exists but zero models | The plugin can't read your model list. Check the gateway base URL; try `catalogMode: "management"` for newapi gateways that restrict `/v1/models`. |
| `401` / auth errors on every request | Key missing or wrong: check the badge in Settings → Gateway Models, or `NEWAPI_API_KEY` in `~/.dsh/.credentials.yaml`. |
| A model's context window looks wrong | models.dev had no match. Edit the model on the settings page (or a `models:` override). |
| Wrong format answers / tool calls flaky for one model | That model is routed over a protocol it handles poorly. Pin `protocol` on the model (`openai`, `openai-response`, `anthropic`, `gemini`). |
| Custom gateway with separate endpoints | Use `flavor: "custom"` and set `openaiURL` / `responsesURL` / `anthropicURL` explicitly. |

## How it works (one minute version)

At startup the plugin registers one provider route per gateway, pulls the
model list from the gateway, and fuzzy-matches each model id against
models.dev to fill in real parameters. When you pick a model, dsh's request
is translated to the pi-ai SDK's format and sent over that model's native
protocol; the streamed reply is translated back into dsh chunks. Catalogs
are cached (30 min by default) per gateway. No hand-written protocol code —
the bridge is lifted from the official `dsh-llm-pi-ai` adapter.

## Development

```sh
git clone https://github.com/Luck9Star/dsh-gateway-provider
cd dsh-gateway-provider
npm run link              # symlink into your dsh profile (single instanceof safety)
npm run test:client       # settings-UI render, both locales
npm run test:urls         # URL/derivation units
npm run smoke             # live gateway round-trip (needs a real key)
```

Developing from a checkout: point the profile's `package.json` at
`"dsh-gateway-provider": "link:/abs/path"` and re-run `pnpm install` in the
profile. Do **not** also add an `id: llm-newapi` row to the profile's own
`cordis.patch.yml` — the bundle patch already provides it (duplicate row =
loader error).

## References & credits

- [pi-ai SDK](https://www.npmjs.com/package/@earendil-works/pi-ai) — all
  four wire protocols; the bridge reuses the official `dsh-llm-pi-ai`
  adapter's translation layer.
- [models.dev](https://models.dev) — the parameter catalog (context
  windows, output caps, reasoning, release dates).
- [new-api](https://github.com/QuantumNous/new-api), 
  [LiteLLM](https://github.com/BerriAI/litellm),
  [Higress](https://github.com/alibaba/higress) — the gateways this plugin
  is tested against (any OpenAI-compatible endpoint works).

## Security

Keys live in dsh's credential store or the launching environment — never in
settings YAML. The repo runs [gitleaks](https://github.com/gitleaks/gitleaks)
in CI and pre-commit to keep secrets out.

## License

[MIT](LICENSE)
