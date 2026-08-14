/**
 * Shared endpoint-type ↔ pi-ai protocol vocabulary.
 *
 * The gateway advertises per-model endpoint types (openai / openai-response /
 * anthropic / gemini); pi-ai identifies wire protocols by API id
 * (openai-completions / openai-responses / anthropic-messages /
 * google-generative-ai). This module owns the mapping and the priority-based
 * selection so both the catalog (discovery preview) and the pi-provider
 * (request dispatch) share one source of truth without importing each other.
 *
 * @module dsh-newapi-provider/protocols
 */

/** Default endpoint-type preference: prefer the modern Responses API. */
export const DEFAULT_ENDPOINT_PRIORITY = ["openai-response", "anthropic", "openai", "gemini"];

/** Gateway endpoint type → pi-ai API identifier. */
export function apiOfEndpointType(type) {
  switch (type) {
    case "openai": return "openai-completions";
    case "openai-response": return "openai-responses";
    case "anthropic": return "anthropic-messages";
    case "gemini": return "google-generative-ai";
    default: return undefined;
  }
}

/** pi-ai API identifier → gateway endpoint type (inverse mapping). */
export function endpointTypeOfApi(api) {
  switch (api) {
    case "openai-completions": return "openai";
    case "openai-responses": return "openai-response";
    case "anthropic-messages": return "anthropic";
    case "google-generative-ai": return "gemini";
    default: return api;
  }
}

/**
 * Choose the pi-ai API for one model from its advertised endpoint types,
 * honoring the priority order (most-preferred first).
 * @param {string[]} endpointTypes - protocols the model advertises (gateway vocabulary).
 * @param {string[]} priority - ordered gateway endpoint types to try.
 * @returns {string} the pi-ai API identifier, or "openai-completions" as fallback.
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
