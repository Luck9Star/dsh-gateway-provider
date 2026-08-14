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
 * @module dsh-newapi-provider/pi-provider
 */

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { DEFAULT_MAX_TOKENS, NO_COST } from "./catalog.js";
import { findPiModel } from "./thinking.js";

/** pi-ai protocol factories keyed by their API identifier. */
const PROTOCOLS = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

/** Map a gateway-advertised endpoint type onto a pi-ai API identifier. */
function apiOfEndpointType(type) {
  switch (type) {
    case "openai": return "openai-completions";
    case "openai-response": return "openai-responses";
    case "anthropic": return "anthropic-messages";
    case "gemini": return "google-generative-ai";
    default: return undefined;
  }
}

/**
 * Choose the pi-ai API for one model from its advertised endpoint types,
 * honoring the priority order (most-preferred first).
 * @param endpointTypes - protocols the model advertises (gateway vocabulary).
 * @param priority - ordered gateway endpoint types to try.
 * @returns the pi-ai API identifier, or "openai-completions" as fallback.
 */
export function pickModelApi(endpointTypes, priority) {
  const advertised = Array.isArray(endpointTypes) ? endpointTypes : [];
  if (advertised.length === 0) return "openai-completions";
  for (const preferred of priority ?? DEFAULT_ENDPOINT_PRIORITY) {
    if (advertised.includes(preferred)) {
      const api = apiOfEndpointType(preferred);
      if (api !== undefined) return api;
    }
  }
  // Fall back to any advertised type we recognize.
  for (const type of advertised) {
    const api = apiOfEndpointType(type);
    if (api !== undefined) return api;
  }
  return "openai-completions";
}

/** Default endpoint-type preference: prefer the modern Responses API. */
export const DEFAULT_ENDPOINT_PRIORITY = ["openai-response", "anthropic", "openai", "gemini"];

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
 * @param defaults - fallback capacities (contextWindow, maxTokens).
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
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    api,
    provider: providerId,
    baseUrl: sdkBaseURL(baseURL, api),
    reasoning: entry.reasoning ?? false,
    input: entry.input ?? ["text"],
    cost: piModel?.cost ?? NO_COST,
    contextWindow: override?.contextWindow ?? entry.contextWindow ?? defaults.contextWindow,
    maxTokens: override?.maxTokens ?? entry.maxTokens ?? defaults.maxTokens,
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
