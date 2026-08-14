/**
 * NewAPI model catalog: automatic model discovery and parameter control.
 *
 * The adapter never ships a static model list. Instead it interrogates the
 * gateway itself:
 *
 * 1. `GET {base}/v1/models` (OpenAI-compatible, same key as chat) — every
 *    entry advertises `supported_endpoint_types` (e.g. `["openai",
 *    "anthropic", "gemini"]`), which is exactly the per-model request-format
 *    metadata used to auto-construct the request URL later. When the gateway
 *    does not expose this route, falls back to the management API
 *    `GET /api/user/models` (flat id list).
 * 2. Each discovered model is enriched with models.dev parameters (context
 *    window, output cap, reasoning, family) via {@link fetchModelsDev}.
 *
 * Results are cached per base URL for `catalogTtlMs`; refresh is lazy (on
 * the next read after expiry). Non-chat models (image / speech / embedding /
 * rerank / …) are excluded from the picker by default but remain resolvable
 * if explicitly requested.
 *
 * @module dsh-newapi-provider/catalog
 */

import { LlmError } from "@deepseek-ai/dsh-llm";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { extractModelsDevParams, fetchModelsDev, matchModelsDev } from "./modelsdev.js";
import { baseModelId, variantLabel } from "./thinking.js";

/** Wire formats this adapter can actually speak, mapped to their endpoint types. */
export const IMPLEMENTED_ENDPOINTS = ["openai", "anthropic", "gemini"];
/** Endpoint types that indicate a chat-capable model on the gateway. */
const CHAT_ENDPOINTS = new Set(["openai", "openai-response", "anthropic", "gemini"]);
/** Default picker exclusions: non-chat model families exposed by newapi gateways. */
export const DEFAULT_EXCLUDE_PATTERNS = [
  "(^|/|-)image",
  "(^|/|-)speech",
  "(^|/|-)audio",
  "(^|/|-)video",
  "(^|/|-)embed",
  "(^|/|-)rerank",
  "(^|/)bge-",
  "(^|/)text-embedding",
  "(^|/|-)moderation",
  "(^|/|-)tts",
  "(^|/|-)stt",
  "(^|/|-)whisper",
  "nano-banana",
  "dall-e",
];

const DEFAULT_CATALOG_TTL_MS = 30 * 60 * 1000;

/** One cache slot per base URL. */
const slots = new Map();

function slotFor(baseURL) {
  let slot = slots.get(baseURL);
  if (slot === undefined) {
    slot = { at: 0, entries: undefined, error: undefined };
    slots.set(baseURL, slot);
  }
  return slot;
}

/** Normalize a bare endpoint-type list; `undefined` when the gateway disclosed none. */
function endpointTypesOf(model) {
  const types = model.supported_endpoint_types ?? model.supportedEndpoints;
  if (!Array.isArray(types)) return undefined;
  const clean = types.filter((t) => typeof t === "string" && t.length > 0);
  return clean.length > 0 ? clean : undefined;
}

/** Fetch the OpenAI-compatible model list. */
async function fetchV1Models(baseURL, apiKey, signal) {
  const res = await fetch(`${baseURL}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, ...attributionHeaders() },
    signal,
  });
  if (!res.ok) {
    throw new LlmError(`newapi model list failed (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? "AUTH" : `HTTP_${res.status}`, { status: res.status });
  }
  const body = await res.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  const entries = [];
  for (const model of data) {
    if (model === null || typeof model !== "object" || typeof model.id !== "string" || model.id.length === 0) continue;
    entries.push({
      id: model.id,
      ownedBy: typeof model.owned_by === "string" ? model.owned_by : undefined,
      endpointTypes: endpointTypesOf(model),
    });
  }
  return entries;
}

/** Fetch the management-API model list (flat id list; requires an access token). */
async function fetchManagementModels(baseURL, apiKey, userId, signal) {
  const res = await fetch(`${baseURL}/api/user/models`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "new-api-user": String(userId ?? "1"),
      ...attributionHeaders(),
    },
    signal,
  });
  if (!res.ok) {
    throw new LlmError(`newapi management model list failed (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? "AUTH" : `HTTP_${res.status}`, { status: res.status });
  }
  const body = await res.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  const entries = [];
  for (const id of data) {
    if (typeof id !== "string" || id.length === 0) continue;
    entries.push({ id, ownedBy: undefined, endpointTypes: undefined });
  }
  return entries;
}

/**
 * Discover the raw model list from the gateway.
 * `auto` mode prefers the OpenAI-compatible route and falls back to the
 * management route; explicit modes fail loud instead of falling back.
 */
async function fetchNewapiModels(connection, apiKey, signal) {
  const mode = connection.catalogMode ?? "auto";
  if (mode === "v1" || mode === "auto") {
    try {
      return await fetchV1Models(connection.baseURL, apiKey, signal);
    } catch (error) {
      if (mode === "v1" || mode === "auto" && (error?.failure?.code ?? error?.code) !== "AUTH") throw error;
      // AUTH on /v1/models (e.g. an access token that only the management API accepts): fall through.
    }
  }
  return fetchManagementModels(connection.baseURL, apiKey, connection.userId, signal);
}

/** Apply the picker filter (chat-only + exclude patterns). */
function filterEntries(entries, connection) {
  const patterns = (connection.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS).map((p) => {
    try {
      return new RegExp(p);
    } catch {
      return undefined;
    }
  }).filter((r) => r !== undefined);
  return entries.filter((entry) => {
    const types = entry.endpointTypes;
    if (connection.includeChatOnly !== false && types !== undefined && !types.some((t) => CHAT_ENDPOINTS.has(t))) return false;
    if (patterns.some((re) => re.test(entry.id))) return false;
    return true;
  });
}

/**
 * Build the enriched catalog entry for one raw model.
 * @returns a detached catalog entry with merged models.dev parameters.
 */
function enrichEntry(raw, modelsDev, connection) {
  const params = extractModelsDevParams(matchModelsDev(modelsDev, baseModelId(raw.id)));
  const variant = variantLabel(raw.id);
  // Variants inherit the base model's name but are told apart by their tag
  // (e.g. "GLM-5.2 Highspeed"); the base id itself is never collapsed, so
  // request routing stays on the exact gateway-advertised id.
  const baseName = params.name ?? raw.id;
  const name = variant.length === 0 ? baseName : `${baseName} ${variant}`;
  return {
    id: raw.id,
    ownedBy: raw.ownedBy,
    endpointTypes: raw.endpointTypes,
    name,
    description: params.description,
    family: params.family,
    reasoning: params.reasoning,
    contextWindow: params.contextWindow ?? connection.defaultContextWindow,
    maxTokens: params.maxTokens ?? connection.maxTokens,
  };
}

/**
 * Read the (cached, lazily refreshed) enriched catalog for one connection.
 * @returns the full enriched entry list (before picker filtering), or an
 *   empty array when discovery fails and no snapshot exists.
 */
export async function getCatalog(connection, apiKey, signal) {
  const slot = slotFor(connection.baseURL);
  const now = Date.now();
  const ttl = connection.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  if (slot.entries !== undefined && now - slot.at < ttl) return slot.entries;
  try {
    const raw = await fetchNewapiModels(connection, apiKey, signal);
    const modelsDev = connection.useModelsDev === false ? undefined : await fetchModelsDev(connection.modelsUrl, signal);
    const entries = raw.map((m) => enrichEntry(m, modelsDev, connection));
    slot.entries = entries;
    slot.at = Date.now();
    slot.error = undefined;
    return entries;
  } catch (error) {
    if (slot.entries !== undefined) return slot.entries; // stale-but-usable snapshot
    slot.error = error;
    throw error;
  }
}

/** The picker-facing model list (enriched + filtered). */
export async function listPickerModels(connection, apiKey, signal) {
  const entries = await getCatalog(connection, apiKey, signal);
  return filterEntries(entries, connection);
}

/**
 * Look up one exact model in the catalog. The result is advisory: requests
 * still go through for unlisted ids (with configured defaults).
 */
export async function lookupCatalogEntry(connection, apiKey, model, signal) {
  try {
    const entries = await getCatalog(connection, apiKey, signal);
    return entries.find((entry) => entry.id === model);
  } catch {
    return undefined;
  }
}
