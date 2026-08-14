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

/**
 * Known endpoint path suffixes each wire protocol is served under, used to
 * reduce a fully-qualified endpoint URL to the SDK base URL. The OpenAI SDK
 * (chat + responses) expects a base ending in `/v1` and appends the suffix
 * itself; the Anthropic SDK appends `/v1/messages`.
 */
const ENDPOINT_SUFFIXES = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages",
};

/** Trim a configured URL and strip one known endpoint suffix if present. */
function stripSuffix(url, suffix) {
  const s = String(url ?? "").trim().replace(/\/+$/, "");
  if (s.length === 0) return undefined;
  if (s.toLowerCase().endsWith(suffix)) return s.slice(0, -suffix.length).replace(/\/+$/, "") || undefined;
  return s;
}

/**
 * Derive the per-protocol facts from fully-qualified endpoint URLs
 * (`openaiURL` / `responsesURL` / `anthropicURL`). Unset URLs mean the
 * protocol is unavailable on this gateway ("没填的就是没有"): the returned
 * `availableTypes` is exactly the configured set.
 *
 * Each URL may be the complete endpoint address (`…/v1/chat/completions`),
 * an SDK base (`…/v1`), or — for anthropic — a bare host; the derivation
 * strips the known suffix and re-adds the version segment where the SDK
 * expects it.
 * @param urls - the gateway's protocol URL fields (any may be absent).
 * @returns `{ apiBases, availableTypes, catalogBase }` where apiBases maps
 *   pi-ai API id → SDK base URL, availableTypes lists gateway endpoint
 *   types, and catalogBase is the bare base for `/v1/models` discovery
 *   (null when no OpenAI-style URL is set); undefined when no URL is set.
 */
export function deriveProtocolURLs(urls) {
  if (urls === null || typeof urls !== "object") return undefined;
  const apiBases = {};
  const availableTypes = [];
  let catalogBase;

  const oc = stripSuffix(urls.openaiURL, ENDPOINT_SUFFIXES["openai-completions"]);
  if (oc !== undefined) {
    apiBases["openai-completions"] = /\/v\d+$/.test(oc) ? oc : `${oc}/v1`;
    availableTypes.push("openai");
  }
  const rs = stripSuffix(urls.responsesURL, ENDPOINT_SUFFIXES["openai-responses"]);
  if (rs !== undefined) {
    apiBases["openai-responses"] = /\/v\d+$/.test(rs) ? rs : `${rs}/v1`;
    availableTypes.push("openai-response");
  }
  // Anthropic: the SDK appends `/v1/messages` itself, so accept the full
  // endpoint URL, a base ending in `/v1`, or a bare host.
  const anRaw = String(urls.anthropicURL ?? "").trim().replace(/\/+$/, "");
  if (anRaw.length > 0) {
    const lower = anRaw.toLowerCase();
    const stripped = lower.endsWith(ENDPOINT_SUFFIXES["anthropic-messages"])
      ? anRaw.slice(0, -ENDPOINT_SUFFIXES["anthropic-messages"].length)
      : lower.endsWith("/v1") ? anRaw.slice(0, -"/v1".length) : anRaw;
    const an = stripped.replace(/\/+$/, "");
    if (an.length > 0) {
      apiBases["anthropic-messages"] = an;
      availableTypes.push("anthropic");
    }
  }
  if (availableTypes.length === 0) return undefined;
  for (const api of ["openai-completions", "openai-responses"]) {
    if (apiBases[api] !== undefined) { catalogBase = apiBases[api].replace(/\/v\d+$/, ""); break; }
  }
  return { apiBases, availableTypes, catalogBase: catalogBase ?? null };
}

/**
 * Intersect a model's advertised endpoint types with the protocols the
 * gateway actually has addresses for. Models that advertise nothing inherit
 * the full available set (the gateway's protocols define their fallback).
 * @param endpointTypes - protocols the model advertises (may be undefined).
 * @param availableTypes - configured protocols, or undefined = all allowed.
 * @returns the effective endpoint-type list, or null when the model cannot
 *   be served on any configured protocol (caller drops it).
 */
export function effectiveEndpointTypes(endpointTypes, availableTypes) {
  if (availableTypes === undefined) return endpointTypes;
  if (!Array.isArray(endpointTypes) || endpointTypes.length === 0) return availableTypes;
  const kept = endpointTypes.filter((t) => availableTypes.includes(t));
  return kept.length > 0 ? kept : null;
}

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
