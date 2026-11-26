/**
 * Declare scalar `llm-newapi` fields on the TUI settings screen (issue #5 P1).
 *
 * The seam is `ctx.tuiSettingsSections` from `@deepseek-harness-tui/dsh-tui`
 * (present in 0.16.1, same field kinds in 0.20.2). The TUI owns rendering,
 * staged editing, and the revision-fenced `settings.mutate` writes; this
 * module only describes WHAT is editable. A composition without the service
 * (headless, web, an older TUI) is a no-op — never a crash.
 *
 * Credential literals never appear in the section or the settings document:
 * a secret field is write-only, starts blank, and types through the
 * credentials seam under `secret.ref`. Extra gateways that still inherit the
 * default key get no secret field, so typing a key cannot overwrite the
 * default gateway's credential (issue #12).
 *
 * @module dsh-gateway-provider/tui-settings
 */

import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";

const DEFAULT_API_KEY_ENV = "NEWAPI_API_KEY";
const FLAVORS = ["newapi", "litellm", "higress", "openai-compatible", "custom"];
const CATALOG_MODES = ["auto", "v1", "management"];

const FLAVOR_LABELS = {
  newapi: { label: "NewAPI", zh: "NewAPI" },
  litellm: { label: "LiteLLM", zh: "LiteLLM" },
  higress: { label: "Higress", zh: "Higress" },
  "openai-compatible": { label: "OpenAI-compatible", zh: "OpenAI 兼容" },
  custom: { label: "Fully custom", zh: "完全自定义" },
};

const STORE_OPTIONS = [
  { value: "inherit", label: "Default (off for LiteLLM)", descriptions: { zh: "默认（LiteLLM 不发送）" } },
  { value: "false", label: "Don't send store", descriptions: { zh: "不发送 store" } },
  { value: "true", label: "Send store", descriptions: { zh: "发送 store" } },
];

/** Sanitize a gateway id the same way index.js routeIdOf does. */
function routeIdOf(id) {
  return String(id ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** An empty value (inherit) or a credential ref the host will accept. */
export function parseKeyEnv(text) {
  const value = String(text ?? "").trim();
  if (value.length === 0) return { kind: "clear" };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return undefined;
  return { kind: "set", value };
}

/** Empty clears; otherwise a trailing-slash-stripped http(s) URL, or reject. */
export function parseUrl(text) {
  const value = String(text ?? "").trim().replace(/\/+$/, "");
  if (value.length === 0) return { kind: "clear" };
  if (!/^https?:\/\/\S+$/i.test(value)) return undefined;
  return { kind: "set", value };
}

/** Empty clears; otherwise a positive integer within the timer cap, or reject. */
export function parseTimeout(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return { kind: "clear" };
  if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > MAX_TIMER_DELAY_MS) return undefined;
  return { kind: "set", value };
}

/** Empty / "inherit" clears (follow the gateway type); true/false set the flag. */
export function parseStore(text) {
  const value = String(text ?? "").trim();
  if (value === "" || value === "inherit") return { kind: "clear" };
  if (value === "false") return { kind: "set", value: false };
  if (value === "true") return { kind: "set", value: true };
  return undefined;
}

/** Draft text for a stored `compat.supportsStore` (unset = inherit). */
export function formatStore(value) {
  if (value === false) return "false";
  if (value === true) return "true";
  return "inherit";
}

function option(value, en, zh) {
  return { value, label: en, descriptions: { zh } };
}

function field(spec) {
  const next = {
    path: spec.path,
    label: spec.label,
    descriptions: { zh: spec.labelZh },
    kind: spec.kind,
  };
  if (spec.hint !== undefined) next.hint = spec.hint;
  if (spec.hintZh !== undefined) next.hintDescriptions = { zh: spec.hintZh };
  if (spec.group !== undefined) next.group = spec.group;
  if (spec.placeholder !== undefined) next.placeholder = spec.placeholder;
  if (spec.options !== undefined) next.options = spec.options;
  if (spec.parse !== undefined) next.parse = spec.parse;
  if (spec.format !== undefined) next.format = spec.format;
  if (spec.secret !== undefined) next.secret = spec.secret;
  return next;
}

function parseLabel(text) {
  const value = String(text ?? "").trim();
  return value.length === 0 ? { kind: "clear" } : { kind: "set", value };
}

function flavorOptions() {
  return FLAVORS.map((value) => option(value, FLAVOR_LABELS[value].label, FLAVOR_LABELS[value].zh));
}

function catalogOptions() {
  return CATALOG_MODES.map((value) => option(value, value, value));
}

/**
 * Scalar fields for one gateway. `root` is true for the default (legacy)
 * gateway, whose values live at the section root; extra gateways are
 * addressed as `gateways.<index>.*`.
 */
function gatewayFields(prefix, group, { includeTimeout, secretRef }) {
  const path = (...keys) => [...prefix, ...keys];
  const fields = [
    field({
      path: path("label"), group, kind: "text",
      label: "Display name", labelZh: "名称",
      hint: "Leave empty to use the default label", hintZh: "留空则使用默认名称",
      parse: parseLabel,
    }),
    field({
      path: path("baseURL"), group, kind: "text",
      label: "Base URL", labelZh: "基础地址",
      hint: "OpenAI-compatible gateway root, e.g. https://gw.example.com",
      hintZh: "OpenAI 兼容网关根地址，例如 https://gw.example.com",
      placeholder: "https://your-gateway.com",
      parse: parseUrl,
    }),
    field({
      path: path("flavor"), group, kind: "select",
      label: "Gateway type", labelZh: "网关类型",
      hint: "LiteLLM omits the store parameter unless you turn it back on",
      hintZh: "LiteLLM 默认不发送 store 参数，可再手动打开",
      options: flavorOptions(),
    }),
    field({
      path: path("apiKeyEnv"), group, kind: "text",
      label: "API key env var", labelZh: "API Key 变量名",
      hint: "Credential ref name (not the key itself). Letters, digits and _; empty inherits the default",
      hintZh: "凭据变量名（不是密钥本身）。只能用字母、数字和 _；留空则继承默认",
      placeholder: DEFAULT_API_KEY_ENV,
      parse: parseKeyEnv,
    }),
  ];
  if (typeof secretRef === "string" && secretRef.length > 0) {
    fields.push(field({
      path: path("apiKey"), group, kind: "text",
      label: "API key", labelZh: "API Key",
      hint: "Write-only; the stored value is never shown. Leave blank to keep the current key",
      hintZh: "只写，不会显示已保存的值；留空则保持现有 Key",
      secret: { ref: secretRef },
    }));
  }
  fields.push(field({
    path: path("catalogMode"), group, kind: "select",
    label: "Model-list source", labelZh: "模型列表来源",
    hint: "auto: prefer /v1/models, fall back to the management API on auth failure",
    hintZh: "auto：优先 /v1/models，鉴权失败时回退管理 API",
    options: catalogOptions(),
  }));
  if (includeTimeout) {
    fields.push(field({
      path: ["catalogTimeoutMs"], group, kind: "number",
      label: "Catalog timeout (ms)", labelZh: "拉模型列表超时（毫秒）",
      hint: "Cap on one model-list / models.dev request",
      hintZh: "单次拉模型列表 / models.dev 请求的超时上限",
      placeholder: "15000",
      parse: parseTimeout,
    }));
  }
  fields.push(
    field({
      path: path("compat", "supportsStore"), group, kind: "select",
      label: "Send store parameter", labelZh: "发送 store 参数",
      hint: "OpenAI chat-completions only. Default follows the gateway type (off for LiteLLM)",
      hintZh: "只对 OpenAI chat-completions 有效。默认跟随网关类型（LiteLLM 不发送）",
      options: STORE_OPTIONS,
      format: formatStore,
      parse: parseStore,
    }),
    field({
      path: path("openaiURL"), group, kind: "text",
      label: "OpenAI-compatible URL", labelZh: "OpenAI 兼容地址",
      hint: "Custom template: full /chat/completions URL (or up to /v1). Empty disables this protocol",
      hintZh: "完全自定义：完整 /chat/completions 地址（也可只填到 /v1）。留空则不启用该协议",
      parse: parseUrl,
    }),
    field({
      path: path("responsesURL"), group, kind: "text",
      label: "Responses URL", labelZh: "Responses 地址",
      hint: "Custom template: full /responses URL (or up to /v1). Empty disables this protocol",
      hintZh: "完全自定义：完整 /responses 地址（也可只填到 /v1）。留空则不启用该协议",
      parse: parseUrl,
    }),
    field({
      path: path("anthropicURL"), group, kind: "text",
      label: "Anthropic URL", labelZh: "Anthropic 地址",
      hint: "Custom template: full /v1/messages URL. Empty disables this protocol",
      hintZh: "完全自定义：完整 /v1/messages 地址。留空则不启用该协议",
      parse: parseUrl,
    }),
    field({
      path: path("geminiURL"), group, kind: "text",
      label: "Gemini URL", labelZh: "Gemini 地址",
      hint: "Custom template: host, …/v1beta, or …/v1beta/models. Empty disables this protocol",
      hintZh: "完全自定义：主机名、…/v1beta 或 …/v1beta/models。留空则不启用该协议",
      parse: parseUrl,
    }),
  );
  return fields;
}

/**
 * Build the TUI settings section for the current settings snapshot.
 * Extra gateways are addressed by their array index (the same path the host
 * walks for settingsPath). Entries with no usable id are skipped.
 *
 * @param {{ ns: string, config?: object }} spec
 * @returns a `TuiSettingsSection` (plain data + parse/format functions).
 */
export function buildTuiSettingsSection({ ns, config }) {
  const snapshot = config && typeof config === "object" ? config : {};
  const groups = [
    {
      id: "default",
      title: "Default gateway",
      descriptions: { zh: "默认网关" },
      mode: "inline",
    },
  ];
  const defaultRef = typeof snapshot.apiKeyEnv === "string" && snapshot.apiKeyEnv.length > 0
    ? snapshot.apiKeyEnv
    : DEFAULT_API_KEY_ENV;
  const fields = gatewayFields([], "default", {
    includeTimeout: true,
    secretRef: defaultRef,
  });

  const extra = Array.isArray(snapshot.gateways) ? snapshot.gateways : [];
  for (const [index, raw] of extra.entries()) {
    if (raw === null || typeof raw !== "object") continue;
    const id = routeIdOf(raw.id);
    if (id.length === 0) continue;
    const group = `gw-${index}`;
    const titleName = (typeof raw.label === "string" && raw.label.trim().length > 0)
      ? raw.label.trim()
      : (typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : id);
    groups.push({
      id: group,
      title: `Gateway: ${titleName}`,
      descriptions: { zh: `网关：${titleName}` },
      mode: "page",
    });
    const ownRef = typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.length > 0 ? raw.apiKeyEnv : undefined;
    fields.push(...gatewayFields(["gateways", String(index)], group, {
      includeTimeout: false,
      secretRef: ownRef,
    }));
  }

  return {
    ns,
    title: "Gateway Models",
    descriptions: { zh: "网关模型" },
    groups,
    fields,
  };
}

/** The tuiSettingsSections host, if this composition has one right now. */
function tuiSettingsApi(ctx) {
  // cordis throws on `ctx.<service>` a plugin does not inject; `ctx.get` is the optional lookup.
  const api = ctx.get("tuiSettingsSections");
  return typeof api?.register === "function" ? api : undefined;
}

/**
 * A stable identity for a section (paths, kinds, secret refs, groups).
 * Functions are excluded so a refresh can be skipped when only identity
 * is unchanged.
 */
function fingerprint(section) {
  return JSON.stringify({
    ns: section.ns,
    groups: section.groups,
    fields: section.fields.map((item) => ({
      path: item.path,
      kind: item.kind,
      group: item.group,
      secret: item.secret?.ref,
      options: item.options?.map((option) => option.value),
    })),
  });
}

/**
 * Register the section when the TUI seam exists, and keep it in sync with
 * settings updates (secret.ref follows apiKeyEnv; extra-gateway groups
 * follow the array). No-op — not a throw — when the service is missing.
 *
 * @param ctx - the plugin's cordis context.
 * @param {{ ns: string, getConfig: () => object }} options
 * @returns {{ refresh: () => void, dispose: () => void }}
 */
export function bindTuiSettings(ctx, { ns, getConfig }) {
  let unregister = () => {};
  let last;
  const refresh = () => {
    const api = tuiSettingsApi(ctx);
    if (api === undefined) return;
    let section;
    try {
      section = buildTuiSettingsSection({ ns, config: getConfig() });
    } catch (error) {
      ctx.logger?.error?.("llm-newapi: failed to build the TUI settings section");
      ctx.logger?.error?.(error);
      return;
    }
    const next = fingerprint(section);
    if (next === last) return;
    try {
      const previous = unregister;
      unregister = () => {};
      previous();
      const dispose = api.register(section);
      unregister = typeof dispose === "function" ? dispose : () => {};
      last = next;
    } catch (error) {
      last = undefined;
      ctx.logger?.error?.("llm-newapi: failed to register the TUI settings section");
      ctx.logger?.error?.(error);
    }
  };
  // Profile rows activate concurrently, and a reloaded host starts with an empty registry.
  ctx.on("internal/service", (name) => {
    if (name !== "tuiSettingsSections") return;
    last = undefined;
    refresh();
  });
  refresh();
  return {
    refresh,
    dispose() {
      unregister();
      unregister = () => {};
      last = undefined;
    },
  };
}
