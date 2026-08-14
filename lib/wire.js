/**
 * Legacy wire-format helpers — re-exported from {@link module:./gateways}.
 *
 * This module was the original per-model endpoint selection and URL builder.
 * It now delegates to the richer gateway-flavored {@link ./gateways} module,
 * keeping the old import paths working for external consumers.
 *
 * @module dsh-newapi-provider/wire
 */

export { DEFAULT_ENDPOINT_PRIORITY, endpointUrl, normalizeBaseURL, pickEndpoint, priorityOf } from "./gateways.js";

/**
 * Extract a provider error message from a non-2xx response body across the
 * supported wire formats' error shapes.
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
