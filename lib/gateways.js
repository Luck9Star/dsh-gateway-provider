/**
 * Protocol URL templates and per-model endpoint selection.
 *
 * Each gateway flavor names the request path for every wire protocol it
 * speaks, and may default the endpoint priority. A model can override its
 * gateway's default protocol (forcing e.g. `anthropic` for one model on an
 * OpenAI-compatible gateway), and a gateway can override the default flavor.
 *
 * @module dsh-newapi-provider/gateways
 */

/**
 * Built-in gateway flavors: each maps a wire protocol to the path appended to
 * the gateway base URL. `{model}` is substituted with the URL-encoded model id
 * (Gemini embeds it in the path). Unknown protocols fall back to the
 * OpenAI-compatible chat-completions path.
 */
export const GATEWAY_FLAVORS = {
  /** new-api: the original target, OpenAI-compatible with extra protocol routes. */
  newapi: {
    label: "NewAPI / new-api",
    protocols: {
      "openai": "/v1/chat/completions",
      "openai-response": "/v1/responses",
      "anthropic": "/v1/messages",
      "gemini": "/v1beta/models/{model}:streamGenerateContent?alt=sse",
    },
    defaultPriority: ["openai", "anthropic", "gemini"],
  },
  /** LiteLLM proxy: OpenAI-compatible; Anthropic/Gemini routes depend on its config. */
  litellm: {
    label: "LiteLLM Proxy",
    protocols: {
      "openai": "/v1/chat/completions",
      "openai-response": "/v1/responses",
      "anthropic": "/v1/messages",
      "gemini": "/v1beta/models/{model}:streamGenerateContent?alt=sse",
    },
    defaultPriority: ["openai", "anthropic", "gemini"],
  },
  /** Generic OpenAI-compatible gateway (only the chat-completions route is safe). */
  "openai-compatible": {
    label: "OpenAI-Compatible (generic)",
    protocols: {
      "openai": "/v1/chat/completions",
      "openai-response": "/v1/responses",
    },
    defaultPriority: ["openai"],
  },
};

/** All wire protocols this adapter can serialize, in display order. */
export const KNOWN_PROTOCOLS = ["openai", "openai-response", "anthropic", "gemini"];

/** Default format preference when a model supports several. */
export const DEFAULT_ENDPOINT_PRIORITY = ["openai", "anthropic", "gemini"];

/**
 * Resolve a flavor's protocol-path map, falling back to openai-compatible.
 * A custom flavor carries its own `protocols` object keyed by protocol name.
 */
export function protocolsOf(flavor) {
  if (typeof flavor === "object" && flavor !== null) {
    return flavor.protocols ?? GATEWAY_FLAVORS["openai-compatible"].protocols;
  }
  return (GATEWAY_FLAVORS[flavor] ?? GATEWAY_FLAVORS["openai-compatible"]).protocols;
}

/**
 * Resolve a flavor's default endpoint priority.
 */
export function priorityOf(flavor) {
  if (typeof flavor === "object" && flavor !== null) {
    return flavor.defaultPriority ?? ["openai"];
  }
  return (GATEWAY_FLAVORS[flavor] ?? GATEWAY_FLAVORS["openai-compatible"]).defaultPriority;
}

/** Strip a trailing slash so URL assembly never doubles separators. */
export function normalizeBaseURL(baseURL) {
  return String(baseURL ?? "").trim().replace(/\/+$/, "");
}

/**
 * Assemble the request URL for one model and protocol.
 * @param baseURL - gateway base.
 * @param protocol - wire protocol (openai / openai-response / anthropic / gemini).
 * @param model - exact model id (Gemini embeds it in the path).
 * @param flavor - gateway flavor (named or custom object), supplying the path map.
 * @param protocolPaths - per-protocol overrides from the gateway config (optional).
 * @returns the absolute request URL.
 */
export function endpointUrl(baseURL, protocol, model, flavor, protocolPaths) {
  const base = normalizeBaseURL(baseURL);
  const paths = { ...protocolsOf(flavor), ...(protocolPaths ?? {}) };
  const path = paths[protocol] ?? paths["openai"] ?? "/v1/chat/completions";
  return `${base}${path.replace("{model}", encodeURIComponent(model ?? ""))}`;
}

/**
 * Select the wire protocol for one model from its advertised endpoint types
 * and any explicit override, honoring the gateway's priority order.
 * @param endpointTypes - protocols the model advertises (from the gateway list).
 * @param priority - adapter-owned format preference, most preferred first.
 * @param override - explicit protocol override from the model config (optional).
 * @returns the chosen protocol, or undefined when none is usable.
 */
export function pickEndpoint(endpointTypes, priority, override) {
  if (override !== undefined && override.length > 0) return override;
  const advertised = Array.isArray(endpointTypes) ? endpointTypes : [];
  if (advertised.length === 0) {
    // Gateway disclosed no per-model formats: OpenAI route is the universal default.
    return "openai";
  }
  for (const preferred of priority ?? DEFAULT_ENDPOINT_PRIORITY) {
    if (!KNOWN_PROTOCOLS.includes(preferred)) continue;
    if (advertised.includes(preferred)) return preferred;
  }
  return undefined;
}
