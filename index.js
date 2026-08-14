/**
 * NewAPI model provider plugin for the DeepSeek Harness LLM seam.
 *
 * Registers the `newapi` provider route on `ctx.llm` with a
 * {@link NewapiAdapter} that:
 *
 * - auto-discovers the gateway model list (`/v1/models`, falling back to the
 *   management `/api/user/models`), including each model's
 *   `supported_endpoint_types`;
 * - enriches every model with models.dev parameters (context window, output
 *   cap, reasoning, family) so the harness picker and preflights get real
 *   capacities instead of one-size-fits-all defaults;
 * - per request, selects the model's wire format from its advertised
 *   endpoint types and assembles the matching gateway URL
 *   (`/v1/chat/completions`, `/v1/messages`, or
 *   `/v1beta/models/{model}:streamGenerateContent?alt=sse`).
 *
 * Connection facts resolve per request: the composition entry config is
 * layered under the optional `llm-newapi` user-settings section
 * (`ctx.settings`), and the API key resolves per request through the
 * credential seam (`ctx.credentials`, env ref `NEWAPI_API_KEY` by default),
 * so a changed base URL, catalog, or key reaches the very next request.
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
import { DEFAULT_EXCLUDE_PATTERNS } from "./lib/catalog.js";
import { DEFAULT_ENDPOINT_PRIORITY } from "./lib/wire.js";

export const name = "llm-newapi";
export const inject = ["llm"];

/** The single provider route this plugin owns. */
export const PROVIDER = "newapi";
/** User-settings namespace whose section overrides this entry. */
const NS = settingsNamespace("llm-newapi");

const DEFAULT_API_KEY_ENV = "NEWAPI_API_KEY";
const DEFAULT_BASE_URL_ENV = "NEWAPI_BASE_URL";
const ALT_BASE_URL_ENV = "NEWAPI_API_URL";
/** Public newapi.ai cloud gateway; a self-hosted instance overrides it. */
export const PUBLIC_BASE_URL = "https://api.newapi.ai";
export const DEFAULT_MODELS_URL = "https://models.dev/models.json";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_CATALOG_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

export const Config = z.object({
  /** Environment-variable name (credential ref) holding the gateway API key. */
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  /**
   * Gateway base URL. Optional: resolved from the `NEWAPI_BASE_URL` /
   * `NEWAPI_API_URL` launch environment, then the public cloud default.
   */
  baseURL: z.string(),
  /** models.dev catalog URL (any fetch-able URL; file: works for offline mirrors). */
  modelsUrl: z.string().default(DEFAULT_MODELS_URL),
  /** Enrich gateway models with models.dev parameters. */
  useModelsDev: z.boolean().default(true),
  /**
   * Widen the unknown-model reasoning fallback (models missing from both the
   * pi-ai and models.dev catalogs) from the OpenAI-standard off/low/medium/high
   * to the full normalized set off/minimal/low/medium/high/xhigh/max. Some
   * gateways reject the extended values, so this is an explicit opt-in.
   */
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
});

/**
 * Resolve raw config into validated connection facts. Programmatic
 * construction may bypass Schemastery normalization, so defaults and bounds
 * are re-judged here — for the composition entry at load (fail loud) and for
 * each settings snapshot at its first use.
 */
export function resolveAdapterOptions(config, environment) {
  const baseURL = config.baseURL
    ?? environment?.get(DEFAULT_BASE_URL_ENV)?.value
    ?? environment?.get(ALT_BASE_URL_ENV)?.value
    ?? PUBLIC_BASE_URL;
  if (typeof baseURL !== "string" || baseURL.length === 0) {
    throw new Error('llm-newapi: baseURL must be a non-empty string (set llm-newapi.baseURL in settings or export NEWAPI_BASE_URL)');
  }
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error("llm-newapi: defaultContextWindow must be a positive integer");
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error("llm-newapi: maxTokens must be a positive safe integer");
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-newapi: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  const catalogTtlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  if (!Number.isSafeInteger(catalogTtlMs) || catalogTtlMs < 1_000) {
    throw new Error("llm-newapi: catalogTtlMs must be an integer of at least 1000");
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: baseURL.replace(/\/+$/, ""),
    modelsUrl: config.modelsUrl ?? DEFAULT_MODELS_URL,
    useModelsDev: config.useModelsDev ?? true,
    extendedReasoningLevels: config.extendedReasoningLevels ?? false,
    sortModelsByRelease: config.sortModelsByRelease ?? true,
    catalogMode: config.catalogMode ?? "auto",
    catalogTtlMs,
    includeChatOnly: config.includeChatOnly ?? true,
    excludePatterns: config.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
    endpointPriority: config.endpointPriority ?? DEFAULT_ENDPOINT_PRIORITY,
    userId: config.userId ?? "1",
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-newapi: retryPolicy"),
  };
}

export function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error("llm-newapi: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

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
      `llm-newapi: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      "MISSING_CREDENTIAL",
    );
  };

  const adapter = new NewapiAdapter({ options, resolveApiKey });

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: "NewAPI",
    settingsNs: NS,
    settingsPath: [],
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts,
  });
}
