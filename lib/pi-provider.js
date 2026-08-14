/**
 * Construct a pi-ai `Provider` for one newapi gateway.
 *
 * The gateway advertises models over `GET /v1/models` (with per-model
 * `supported_endpoint_types`). This module maps each discovered model into a
 * pi-ai `Model` whose `api` field names the wire protocol pi-ai's protocol
 * layer should speak for it, then builds the provider with
 * `createProvider({ id, baseUrl, auth, models, api })`.
 *
 * The gateway's endpoint-type vocabulary (openai / openai-response /
 * anthropic / gemini) maps onto pi-ai's API identifiers:
 *
 * | gateway endpoint type | pi-ai api              |
 * |----------------------|------------------------|
 * | openai               | openai-completions     |
 * | openai-response      | openai-responses       |
 * | anthropic            | anthropic-messages     |
 * | gemini               | google-generative-ai   |
 *
 * A model advertising several types picks the first that matches the gateway's
 * configured priority (default openai-responses → anthropic → openai → gemini).
 *
 * @module dsh-gateway-provider/pi-provider
 */

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { DEFAULT_MAX_TOKENS, NO_COST } from "./catalog.js";
import { findPiModel } from "./thinking.js";
import { apiOfEndpointType, pickModelApi, DEFAULT_ENDPOINT_PRIORITY } from "./protocols.js";

// Re-exported for existing importers; the mapping itself lives in protocols.js.
export { apiOfEndpointType, pickModelApi, DEFAULT_ENDPOINT_PRIORITY };

/** pi-ai protocol factories keyed by their API identifier. */
const PROTOCOLS = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

/**
 * Normalize the gateway base URL for one pi-ai API.
 *
 * The OpenAI Node SDK (used by pi-ai for openai-completions / openai-responses)
 * expects the baseURL to already include `/v1` — its default is
 * `https://api.openai.com/v1`, and `responses.create()` only appends
 * `/responses`. A gateway baseURL without `/v1` makes the SDK request
 * `{base}/responses`, which the gateway answers with its HTML UI (HTTP 200,
 * content-type text/html) instead of an SSE stream, so the SDK receives zero
 * events. Anthropic and Google protocols build their own full paths, so they
 * need no `/v1` appended.
 * @param baseURL - the gateway base URL as configured.
 * @param api - the pi-ai API identifier the model will use.
 * @returns the baseURL the OpenAI SDK should point at.
 */
function sdkBaseURL(baseURL, api) {
  const trimmed = String(baseURL ?? "").replace(/\/+$/, "");
  if (api === "openai-completions" || api === "openai-responses") {
    if (!/\/v\d+$/.test(trimmed)) return `${trimmed}/v1`;
  }
  return trimmed;
}

/**
 * Build one pi-ai `Model` from a discovered gateway entry, enriched with
 * models.dev parameters and the user's per-model overrides.
 * @param entry - the enriched catalog entry (id, name, contextWindow, …).
 * @param providerId - the provider route key (becomes `model.provider`).
 * @param baseURL - the gateway base URL (becomes `model.baseUrl`).
 * @param priority - endpoint-type preference order.
 * @param defaults - fallback capacities (contextWindow, maxTokens); when it
 *   carries `apiBases` (protocol URL fields configured), that entry wins for
 *   the model's API instead of deriving from `baseURL`.
 * @param override - per-model override object from settings (may be undefined).
 * @returns the pi-ai Model object.
 */
export function buildModel(entry, providerId, baseURL, priority, defaults, override) {
  const api = pickModelApi(entry.endpointTypes, priority);
  // Cost comes from the pi-ai builtin catalog when the model resolves there;
  // models without a pi-ai match (custom gateway entries, internal-test ids)
  // carry NO_COST — the harness only reads cost for usage accounting and
  // tolerates zero values gracefully.
  const piModel = findPiModel(entry.id);
  // A gateway with protocol URL fields (custom template) carries exact SDK
  // bases per API; otherwise derive from the single base URL.
  const apiBase = defaults?.apiBases?.[api];
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    api,
    provider: providerId,
    baseUrl: apiBase !== undefined ? apiBase : sdkBaseURL(baseURL, api),
    reasoning: entry.reasoning ?? false,
    input: entry.input ?? ["text"],
    cost: piModel?.cost ?? NO_COST,
    contextWindow: override?.contextWindow ?? entry.contextWindow ?? defaults?.defaultContextWindow ?? defaults?.contextWindow,
    maxTokens: override?.maxTokens ?? entry.maxTokens ?? defaults?.maxTokens,
    ...entry.thinkingLevelMap !== undefined ? { thinkingLevelMap: entry.thinkingLevelMap } : {},
    ...piModel?.thinkingLevelMap !== undefined ? { thinkingLevelMap: piModel.thinkingLevelMap } : {},
    ...piModel?.compat !== undefined ? { compat: piModel.compat } : {},
    ...entry.compat !== undefined ? { compat: entry.compat } : {},
  };
}

/**
 * Construct the pi-ai Provider for one gateway connection.
 *
 * The provider carries every discovered model. `api` is passed as a **map**
 * keyed by pi-ai API identifier (openai-completions / openai-responses /
 * anthropic-messages / google-generative-ai): pi-ai's `createProvider` then
 * dispatches each model to the protocol its `model.api` field names. Passing a
 * single ProviderStreams instead would force every model through one protocol
 * regardless of its `api` field.
 *
 * @param spec - the resolved gateway facts.
 * @returns the pi-ai Provider registered into the adapter's Models collection.
 */
export function buildProvider(spec) {
  return createProvider({
    id: spec.providerId,
    name: spec.displayName,
    baseUrl: spec.baseURL,
    auth: { apiKey: gatewayAuth(spec.displayName) },
    models: spec.models,
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
      "google-generative-ai": googleGenerativeAIApi(),
    },
  });
}

/** Api-key auth resolved from the harness credential the adapter holds. */
function gatewayAuth(name) {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
      source: name,
    }),
  };
}
