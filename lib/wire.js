/**
 * Per-model wire-format selection and request URL construction.
 *
 * The newapi gateway serves every model behind multiple protocol-compatible
 * endpoints (OpenAI / Anthropic / Gemini), and its model list discloses the
 * exact set per model via `supported_endpoint_types`. This module picks the
 * best supported format (by adapter priority) and assembles the endpoint URL
 * for it — the "auto URL construction" step of the adapter.
 *
 * @module dsh-newapi-provider/wire
 */

import { IMPLEMENTED_ENDPOINTS } from "./catalog.js?v=1786670133342";

/** Default format preference when a model supports several. */
export const DEFAULT_ENDPOINT_PRIORITY = ["openai", "anthropic", "gemini"];

/**
 * Select the wire format for one model.
 * @param entry - the catalog entry for the model (may be undefined for unlisted ids).
 * @param priority - adapter-owned format preference, most preferred first.
 * @returns the chosen endpoint type, or undefined when the model supports none.
 */
export function pickEndpoint(entry, priority = DEFAULT_ENDPOINT_PRIORITY) {
  const advertised = entry?.endpointTypes;
  if (advertised === undefined || advertised.length === 0) {
    // Gateway disclosed no per-model formats: the OpenAI route is universal on newapi.
    return "openai";
  }
  for (const preferred of priority) {
    if (!IMPLEMENTED_ENDPOINTS.includes(preferred)) continue;
    if (advertised.includes(preferred)) return preferred;
  }
  return undefined;
}

/** Strip a trailing slash so URL assembly never doubles separators. */
export function normalizeBaseURL(baseURL) {
  return String(baseURL).replace(/\/+$/, "");
}

/**
 * Assemble the request URL for one model and wire format.
 * @param baseURL - gateway base (e.g. `https://gateway.example.com`).
 * @param endpoint - wire format selected by {@link pickEndpoint}.
 * @param model - the exact model id (Gemini embeds it in the path).
 * @returns the absolute request URL.
 */
export function endpointUrl(baseURL, endpoint, model) {
  const base = normalizeBaseURL(baseURL);
  switch (endpoint) {
    case "openai":
      return `${base}/v1/chat/completions`;
    case "anthropic":
      return `${base}/v1/messages`;
    case "gemini":
      return `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    default:
      throw new Error(`llm-newapi: no request URL for unsupported endpoint type "${endpoint}"`);
  }
}

/**
 * Extract a provider error message from a non-2xx response body across the
 * three wire formats' error shapes.
 * @param body - parsed JSON body, when available.
 * @returns the human-readable message, or undefined.
 */
export function providerErrorMessage(body) {
  if (body === null || typeof body !== "object") return undefined;
  const error = body.error;
  if (typeof error === "string") return error;
  if (error === null || typeof error !== "object") return undefined;
  if (typeof error.message === "string" && error.message.length > 0) return error.message;
  return undefined;
}
