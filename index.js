/**
 * Gateway model provider plugin for DeepSeek Harness.
 *
 * Registers one or more `gateway:*` provider routes on `ctx.llm`, each backed
 * by an OpenAI-compatible `/v1/models` gateway (newapi, LiteLLM, or any
 * generic gateway). Backwards-compatible with the original single-connection
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
 * @module dsh-newapi-provider
 */

import z from "@deepseek-ai/schemastery";
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { NewapiAdapter } from "./lib/adapter.js";
import { DEFAULT_EXCLUDE_PATTERNS, DEFAULT_MAX_TOKENS, DEFAULT_CONTEXT_WINDOW } from "./lib/catalog.js";
import { DEFAULT_ENDPOINT_PRIORITY } from "./lib/pi-provider.js";

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

/** Schema for one model-level override on a gateway (all fields optional). */
const ModelOverrideSchema = z.object({
  /** Model id exactly as the gateway accepts it. */
  id: z.string(),
  /** Display name override. */
  name: z.string(),
  /** Hide this model from the picker. */
  disabled: z.boolean(),
  /** Force the wire protocol for this model (openai/anthropic/gemini/…). */
  protocol: z.union(["openai","openai-response","anthropic","gemini"]),
  /** Override the context window. */
  contextWindow: z.number().step(1).min(1),
  /** Override the output-token cap. */
  maxTokens: z.number().step(1).min(1),
  /** Reasoning level set (e.g. ["off","low","medium","high"]). */
  reasoningLevels: z.array(z.string()),
});

/**
 * Schema for one gateway in the `gateways` array (id and baseURL required;
 * the rest fall back to the shared defaults at resolution time).
 */
const GatewaySchema = z.object({
  /** Short stable id; becomes the provider route suffix (`gateway:<id>`). */
  id: z.string().required(),
  /** Human-readable gateway name. */
  label: z.string(),
  /** Gateway base URL. */
  baseURL: z.string().required(),
  /** Environment-variable name (credential ref) holding the API key. */
  apiKeyEnv: z.string().role("credential-ref"),
  /** Gateway type label (informational only — protocol dispatch is driven by each model's `supported_endpoint_types` via the pi-ai SDK). */
  flavor: z.union(["newapi","litellm","openai-compatible"]),
  /** Model-list source: `auto` (prefer /v1/models), `v1`, or `management`. */
  catalogMode: z.union(["auto", "v1", "management"]),
  /** User id sent to the management API when it is used. */
  userId: z.string(),
  /** Per-model overrides and custom models. */
  models: z.array(ModelOverrideSchema),
  /** Wire-format preference order for this gateway. */
  endpointPriority: z.array(z.string()),
});

export const Config = z.object({
  // ---- Legacy single-connection fields (build the default `newapi` route) ----
  /** Environment-variable name (credential ref) holding the default gateway API key. */
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  /** Default gateway base URL; resolved from NEWAPI_BASE_URL / NEWAPI_API_URL then the public cloud default. */
  baseURL: z.string(),
  /** Gateway type label shown in the UI (informational; does not affect protocol dispatch). */
  flavor: z.union(["newapi","litellm","openai-compatible"]).default("newapi"),
  /** models.dev catalog URL (any fetch-able URL; file: works for offline mirrors). */
  modelsUrl: z.string().default(DEFAULT_MODELS_URL),
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
  excludePatterns: z.array(z.string()).default(DEFAULT_EXCLUDE_PATTERNS),
  /** Wire-format preference order, intersected with each model's supported types. */
  endpointPriority: z.array(z.string()).default(DEFAULT_ENDPOINT_PRIORITY),
  /** User id sent to the management API when it is used. */
  userId: z.string().default("1"),
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
 * Per-gateway fields fall back to the shared defaults.
 */
function gatewayConnection(gw, defaults, provider, label) {
  const apiKeyEnv = gw.apiKeyEnv ?? defaults.apiKeyEnv;
  const flavor = gw.flavor ?? defaults.flavor ?? "openai-compatible";
  return {
    providerId: provider,
    displayName: label,
    apiKeyEnv: typeof apiKeyEnv === "string" ? credentialRef(apiKeyEnv) : defaults.apiKeyEnv,
    baseURL: gw.baseURL ?? defaults.baseURL,
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
  const baseURL = config.baseURL
    ?? environment?.get(DEFAULT_BASE_URL_ENV)?.value
    ?? environment?.get(ALT_BASE_URL_ENV)?.value
    ?? PUBLIC_BASE_URL;
  if (typeof baseURL !== "string" || baseURL.length === 0) {
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
    { provider: PROVIDER, id: "default", label: defaultLabel, connection: gatewayConnection({ baseURL: defaults.baseURL, models: config.models ?? [] }, defaults, PROVIDER, defaultLabel) },
  ];
  // Additional gateways from the array.
  for (const gw of config.gateways ?? []) {
    const id = routeIdOf(gw.id);
    if (id.length === 0) continue;
    if (gw.baseURL === undefined || gw.baseURL.length === 0) continue;
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
    const facts = gateways.map((g) => `${g.provider}:${g.connection.baseURL}:${g.label}`);
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
    const connection = { ...gw.connection, baseURL: (request.baseURL ?? gw.connection.baseURL).replace(/\/+$/, "") };
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
