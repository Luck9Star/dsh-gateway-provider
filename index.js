/**
 * Gateway model provider plugin for DeepSeek Harness.
 *
 * Registers one or more `gateway:*` provider routes on `ctx.llm`, each backed
 * by an OpenAI-compatible `/v1/models` gateway (newapi, LiteLLM, Higress, or
 * any generic gateway), or by a fully-custom gateway whose per-protocol
 * endpoint URLs (`openaiURL` / `responsesURL` / `anthropicURL`) are written
 * out in full. Backwards-compatible with the original single-connection
 * `newapi` route: the legacy flat fields (`baseURL`, `apiKeyEnv`, …) build a
 * default gateway, while the `gateways` array adds more.
 *
 * Per gateway:
 * - auto-discovers the model list (`/v1/models`, falling back to the
 *   management `/api/user/models`), including each model's
 *   `supported_endpoint_types`;
 * - enriches every model with models.dev parameters (context window, output
 *   cap, reasoning, family, release date, input modalities);
 * - picks each model's wire protocol from its advertised endpoint types (or an
 *   explicit per-model override) and dispatches through the pi-ai SDK's
 *   protocol layer (openai-completions / openai-responses / anthropic-messages
 *   / google-generative-ai).
 *
 * Per model (in the gateway config) the user can: disable it (hide from
 * picker), override its context/maxTokens/reasoning, force a protocol, or add a
 * custom model the gateway does not advertise.
 *
 * @module dsh-gateway-provider
 */

import z from "@deepseek-ai/schemastery";
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { NewapiAdapter } from "./lib/adapter.js";
import { DEFAULT_EXCLUDE_PATTERNS, DEFAULT_MAX_TOKENS, DEFAULT_CONTEXT_WINDOW } from "./lib/catalog.js";
import { DEFAULT_ENDPOINT_PRIORITY, deriveProtocolURLs } from "./lib/protocols.js";

export const name = "llm-newapi";
export const inject = ["llm"];

/** User-settings namespace whose section overrides this entry. */
const NS = settingsNamespace("llm-newapi");
/** The legacy single provider route (kept for backwards compatibility). */
export const PROVIDER = "newapi";
/** Prefix for additional gateway routes. */
export const GATEWAY_PREFIX = "gateway:";

const DEFAULT_API_KEY_ENV = "NEWAPI_API_KEY";
const DEFAULT_BASE_URL_ENV = "NEWAPI_BASE_URL";
const ALT_BASE_URL_ENV = "NEWAPI_API_URL";
/** Public newapi.ai cloud gateway; a self-hosted instance overrides it. */
export const PUBLIC_BASE_URL = "https://api.newapi.ai";
export const DEFAULT_MODELS_URL = "https://models.dev/models.json";

// Idle cap on waiting for the next stream chunk: a gateway that stays silent
// for this long (long reasoning / buffered thinking phases) is treated as hung.
// 10 minutes is generous enough for very long streaming responses.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_CATALOG_TTL_MS = 30 * 60 * 1000;

/**
 * String field tolerant of hand-edited YAML scalars. `settings.yaml` is a
 * user-editable document parsed with YAML 1.2 core semantics: an unquoted
 * `true` / `false` / `True` / `FALSE` round-trips as a boolean and an
 * unquoted digit run as a number, long before the value reaches a strict
 * `z.string()` — and because the settings seam refuses to register a
 * namespace whose stored section fails its schema, one such scalar anywhere
 * in the section bricks the whole namespace (the web UI then reports every
 * write as `settings-rejected: settings namespace "llm-newapi" is not
 * registered`). Booleans and finite numbers coerce to their string form;
 * anything else still fails loud with schemastery's own union diagnostic.
 */
const coercedString = () => z.union([
  z.string(),
  z.transform(z.boolean(), (value) => String(value)),
  z.transform(z.number(), (value) => String(value)),
]);

/** Schema for one model-level override on a gateway (all fields optional). */
const ModelOverrideSchema = z.object({
  /** Model id exactly as the gateway accepts it. */
  id: coercedString().required(),
  /** Display name override. */
  name: coercedString(),
  /** Hide this model from the picker. */
  disabled: z.boolean(),
  /** Force the wire protocol for this model (openai/anthropic/gemini/…). */
  protocol: z.union(["openai","openai-response","anthropic","gemini"]),
  /** Override the context window. */
  contextWindow: z.number().step(1).min(1),
  /** Override the output-token cap. */
  maxTokens: z.number().step(1).min(1),
  /** Reasoning level set (e.g. ["off","low","medium","high"]). */
  reasoningLevels: z.array(coercedString()),
});

/** Gateway-type templates the settings UI offers (informational labels). */
const FLAVORS = ["newapi", "litellm", "higress", "openai-compatible", "custom"];

/**
 * Schema for one gateway in the `gateways` array (id required; either
 * `baseURL` or at least one protocol URL must be set — the rest falls back
 * to the shared defaults at resolution time).
 */
const GatewaySchema = z.object({
  /** Short stable id; becomes the provider route suffix (`gateway:<id>`). */
  id: coercedString().required(),
  /** Human-readable gateway name. */
  label: coercedString(),
  /** Gateway base URL (unused when protocol URL fields are set). */
  baseURL: coercedString(),
  /** Full chat-completions endpoint URL (custom template). */
  openaiURL: coercedString(),
  /** Full Responses endpoint URL (custom template). */
  responsesURL: coercedString(),
  /** Full Anthropic messages endpoint URL (custom template). */
  anthropicURL: coercedString(),
  /** Environment-variable name (credential ref) holding the API key. */
  apiKeyEnv: coercedString().role("credential-ref"),
  /** Gateway type label (newapi/litellm/higress/openai-compatible/custom). */
  flavor: z.union(FLAVORS),
  /** Model-list source: `auto` (prefer /v1/models), `v1`, or `management`. */
  catalogMode: z.union(["auto", "v1", "management"]),
  /** User id sent to the management API when it is used. */
  userId: coercedString(),
  /** Per-model overrides and custom models. */
  models: z.array(ModelOverrideSchema),
  /** Wire-format preference order for this gateway. */
  endpointPriority: z.array(coercedString()),
});

export const Config = z.object({
  // ---- Legacy single-connection fields (build the default `newapi` route) ----
  /** Display name of the default gateway route (defaults to "NewAPI"). */
  label: coercedString(),
  /** Environment-variable name (credential ref) holding the default gateway API key. */
  apiKeyEnv: coercedString().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  /** Default gateway base URL; resolved from NEWAPI_BASE_URL / NEWAPI_API_URL then the public cloud default. */
  baseURL: coercedString(),
  /** Full chat-completions endpoint URL (custom template for the default gateway). */
  openaiURL: coercedString(),
  /** Full Responses endpoint URL (custom template for the default gateway). */
  responsesURL: coercedString(),
  /** Full Anthropic messages endpoint URL (custom template for the default gateway). */
  anthropicURL: coercedString(),
  /** Gateway type label shown in the UI (newapi/litellm/higress/openai-compatible/custom). */
  flavor: z.union(FLAVORS).default("newapi"),
  /** models.dev catalog URL (any fetch-able URL; file: works for offline mirrors). */
  modelsUrl: coercedString().default(DEFAULT_MODELS_URL),
  /** Enrich gateway models with models.dev parameters. */
  useModelsDev: z.boolean().default(true),
  /** Widen the unknown-model reasoning fallback to the full off~max set. */
  extendedReasoningLevels: z.boolean().default(false),
  /** Sort the picker newest-first by release date (unknown dates first). */
  sortModelsByRelease: z.boolean().default(true),
  /** Model-list source: `auto` (prefer /v1/models), `v1`, or `management`. */
  catalogMode: z.union(["auto", "v1", "management"]).default("auto"),
  /** Model-list cache freshness window. */
  catalogTtlMs: z.number().step(1).min(1_000).default(DEFAULT_CATALOG_TTL_MS),
  /** Exclude non-chat model families from the picker. */
  includeChatOnly: z.boolean().default(true),
  /** Regex patterns excluding models from the picker. */
  excludePatterns: z.array(coercedString()).default(DEFAULT_EXCLUDE_PATTERNS),
  /** Wire-format preference order, intersected with each model's supported types. */
  endpointPriority: z.array(coercedString()).default(DEFAULT_ENDPOINT_PRIORITY),
  /** User id sent to the management API when it is used. */
  userId: coercedString().default("1"),
  /**
   * Extra HTTP headers sent with every provider request to the default
   * gateway (name → value). Reserved attribution headers (user-agent) are
   * filtered out at request time; per-request values are unaffected.
   */
  headers: z.dict(coercedString()),
  /** Fallback output-token cap for models without models.dev data. */
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  /** Fallback context window for models without models.dev data. */
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  /** Per-model overrides for the default (legacy) gateway. */
  models: z.array(ModelOverrideSchema).default([]),
  // ---- Additional gateways ----
  /** Additional gateways; each becomes a `gateway:<id>` provider route. */
  gateways: z.array(GatewaySchema).default([]),
});

/**
 * Normalize one gateway entry into the connection facts the adapter needs.
 * Per-gateway fields fall back to the shared defaults. Protocol URL fields
 * (`openaiURL` / `responsesURL` / `anthropicURL`, the "custom" template)
 * redefine the gateway's protocol surface: each configured URL becomes the
 * exact SDK base for its wire protocol, unconfigured protocols are
 * unavailable, and the plain `baseURL` is no longer inherited from the
 * shared defaults (nothing may silently point at another gateway).
 */
function gatewayConnection(gw, defaults, provider, label) {
  const apiKeyEnv = gw.apiKeyEnv ?? defaults.apiKeyEnv;
  const flavor = gw.flavor ?? defaults.flavor ?? "openai-compatible";
  const proto = deriveProtocolURLs(gw);
  const ownBase = typeof gw.baseURL === "string" && gw.baseURL.length > 0 ? gw.baseURL.replace(/\/+$/, "") : "";
  const baseURL = proto !== undefined ? ownBase : (ownBase || defaults.baseURL);
  return {
    providerId: provider,
    displayName: label,
    apiKeyEnv: typeof apiKeyEnv === "string" ? credentialRef(apiKeyEnv) : defaults.apiKeyEnv,
    baseURL,
    apiBases: proto?.apiBases,
    availableTypes: proto?.availableTypes,
    catalogBase: proto !== undefined ? (proto.catalogBase ?? (ownBase || null)) : baseURL,
    flavor,
    modelsUrl: defaults.modelsUrl,
    useModelsDev: defaults.useModelsDev,
    extendedReasoningLevels: defaults.extendedReasoningLevels,
    sortModelsByRelease: defaults.sortModelsByRelease,
    catalogMode: gw.catalogMode ?? defaults.catalogMode,
    catalogTtlMs: defaults.catalogTtlMs,
    includeChatOnly: defaults.includeChatOnly,
    excludePatterns: defaults.excludePatterns,
    endpointPriority: gw.endpointPriority ?? defaults.endpointPriority,
    userId: gw.userId ?? defaults.userId,
    modelOverrides: indexModelOverrides(gw.models ?? []),
    headers: defaults.headers,
    maxTokens: defaults.maxTokens,
    defaultContextWindow: defaults.defaultContextWindow,
    streamIdleTimeoutMs: defaults.streamIdleTimeoutMs,
    retryPolicy: defaults.retryPolicy,
  };
}

/** Index a model-override array into an id → override map (disabled excluded). */
function indexModelOverrides(models) {
  const map = {};
  if (!Array.isArray(models)) return map;
  for (const m of models) {
    if (m === null || typeof m !== "object" || typeof m.id !== "string" || m.id.length === 0) continue;
    map[m.id] = m;
  }
  return map;
}

/** Sanitize a gateway id into a stable provider-route suffix. */
function routeIdOf(id) {
  return String(id ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Build the gateway list and provider-route map from the resolved config. */
export function resolveGateways(config, environment) {
  const rootProto = deriveProtocolURLs(config);
  const explicitBase = config.baseURL
    ?? environment?.get(DEFAULT_BASE_URL_ENV)?.value
    ?? environment?.get(ALT_BASE_URL_ENV)?.value;
  // Root protocol URLs (custom template) replace the base entirely; without
  // them the base keeps its env / public-cloud fallback chain.
  const baseURL = rootProto !== undefined ? (explicitBase ?? "") : (explicitBase ?? PUBLIC_BASE_URL);
  if ((typeof baseURL !== "string" || baseURL.length === 0) && rootProto === undefined) {
    throw new Error('llm-newapi: baseURL must be a non-empty string (set llm-newapi.baseURL in settings or export NEWAPI_BASE_URL)');
  }
  const defaults = {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: baseURL.replace(/\/+$/, ""),
    flavor: config.flavor ?? "newapi",
    modelsUrl: config.modelsUrl ?? DEFAULT_MODELS_URL,
    useModelsDev: config.useModelsDev ?? true,
    extendedReasoningLevels: config.extendedReasoningLevels ?? false,
    sortModelsByRelease: config.sortModelsByRelease ?? true,
    catalogMode: config.catalogMode ?? "auto",
    catalogTtlMs: config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS,
    includeChatOnly: config.includeChatOnly ?? true,
    excludePatterns: config.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
    endpointPriority: config.endpointPriority ?? DEFAULT_ENDPOINT_PRIORITY,
    userId: config.userId ?? "1",
    headers: config.headers,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-newapi: retryPolicy"),
  };
  // The legacy `newapi` route is always the first gateway, built from flat fields.
  const defaultLabel = config.label ?? "NewAPI";
  const gateways = [
    { provider: PROVIDER, id: "default", label: defaultLabel, connection: gatewayConnection({
      baseURL,
      models: config.models ?? [],
      openaiURL: config.openaiURL,
      responsesURL: config.responsesURL,
      anthropicURL: config.anthropicURL,
    }, defaults, PROVIDER, defaultLabel) },
  ];
  // Additional gateways from the array.
  for (const gw of config.gateways ?? []) {
    const id = routeIdOf(gw.id);
    if (id.length === 0) continue;
    const hasBase = typeof gw.baseURL === "string" && gw.baseURL.length > 0;
    if (!hasBase && deriveProtocolURLs(gw) === undefined) continue;
    const provider = `${GATEWAY_PREFIX}${id}`;
    const label = gw.label ?? provider;
    gateways.push({
      provider,
      id,
      label,
      connection: gatewayConnection(gw, defaults, provider, label),
    });
  }
  return gateways;
}

export function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let resolved = null;
  /** Resolve (and cache) the gateway list from the current config snapshot. */
  const resolve = () => {
    const raw = current();
    if (raw === lastRaw && resolved !== null) return resolved;
    try {
      const next = resolveGateways(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      resolved = next;
      return next;
    } catch (error) {
      if (resolved === null) throw error;
      lastRaw = raw;
      ctx.logger.error("llm-newapi: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return resolved;
    }
  };
  resolve();

  /** Adapter config: resolve the connection for one provider route. */
  const options = (provider) => {
    const gateways = resolve();
    const gw = gateways.find((g) => g.provider === provider);
    return (gw ?? gateways[0]).connection;
  };
  const providerInfo = (provider) => {
    const gateways = resolve();
    const gw = gateways.find((g) => g.provider === provider) ?? gateways[0];
    return { id: gw.provider, name: gw.label };
  };
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined) return assertUsableApiKey(hit.value, "llm-newapi", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-newapi", ref);
    }
    throw new LlmError(
      `llm-newapi: no API key for gateway credential ref "${ref}"; store it through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      "MISSING_CREDENTIAL",
    );
  };

  const adapter = new NewapiAdapter({
    options,
    resolveApiKey,
    providerInfo,
    providerCache: new Map(),
    resolveAttachments: () => ctx.get("attachments"),
  });

  /** Re-register the directory + adapter whenever the gateway list changes. */
  let directory = undefined;
  let registration = undefined;
  let directoryFacts = undefined;
  const ensureRegistration = () => {
    const gateways = resolve();
    // Include the per-protocol bases: URL-addressed (custom) gateways may
    // share an empty plain baseURL, and URL-only edits must re-register.
    const facts = gateways.map((g) => `${g.provider}:${g.connection.baseURL}:${g.label}:${g.connection.apiBases ? JSON.stringify(g.connection.apiBases) : ""}`);
    if (deepEqualJson(facts, directoryFacts)) return;
    const entries = gateways.map((g, i) => ({
      provider: g.provider,
      displayName: g.label,
      settingsNs: NS,
      settingsPath: i === 0 ? [] : ["gateways", String(g.id)],
      declared: i > 0,
    }));
    const routes = gateways.map((g) => g.provider);
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries);
    else directory.replace(entries);
    if (registration === undefined) registration = ctx.llm.registerAdapter(routes, adapter);
    else registration.replace(routes);
    directoryFacts = facts;
  };
  ensureRegistration();

  /** Expose model discovery so the web UI can fetch a gateway's model list. */
  ctx.llm.registerModelDiscovery(NS, async (request) => {
    const env = launchEnvironmentOf(ctx);
    const gateways = resolve();
    const gw = request.provider !== undefined ? gateways.find((g) => g.provider === request.provider) : gateways[0];
    if (gw === undefined) return [];
    // An explicit baseURL override (the settings UI's test/fetch path) wins
    // for discovery; empty strings count as absent.
    const reqBase = typeof request.baseURL === "string" && request.baseURL.length > 0
      ? request.baseURL.replace(/\/+$/, "")
      : undefined;
    const connection = reqBase !== undefined
      ? { ...gw.connection, baseURL: reqBase, catalogBase: reqBase }
      : gw.connection;
    const apiKey = request.apiKey ?? await resolveApiKey(gw.connection).catch(() => undefined);
    const { discoverGatewayModels } = await import("./lib/catalog.js");
    try {
      return await discoverGatewayModels(connection, apiKey, request.signal);
    } catch {
      return [];
    }
  });

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistration,
  });
}
