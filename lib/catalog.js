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
 * Results are cached per gateway route + discovery settings + credential
 * (issue #12: two gateways on one URL with different keys must not share a
 * list) for `catalogTtlMs`; refresh is lazy (on
 * the next read after expiry). Non-chat models (image / speech / embedding /
 * rerank / …) are excluded from the picker by default but remain resolvable
 * if explicitly requested.
 *
 * @module dsh-gateway-provider/catalog
 */

import { createHash } from "node:crypto";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { extractModelsDevParams, fetchModelsDev, matchModelsDev } from "./modelsdev.js";
import { pickModelApi, endpointTypeOfApi, effectiveEndpointTypes } from "./protocols.js";
import { baseModelId, variantLabel } from "./thinking.js";

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
  "dall-e",
];

const DEFAULT_CATALOG_TTL_MS = 30 * 60 * 1000;
/** Upper bound for one model-list request: a stalled gateway must not hang the picker or a chat request. */
export const DEFAULT_CATALOG_TIMEOUT_MS = 15_000;

/** Pricing absence for models the catalog does not rate (harness never reads cost). */
export const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Fallback output-token cap for models without models.dev data. */
export const DEFAULT_MAX_TOKENS = 32768;
/** Fallback context window for models without models.dev data. */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * One cache slot per catalog identity (see {@link catalogIdentity}). Each slot
 * remembers the credential fingerprint it was filled with; a different key
 * for the same identity resets the slot instead of growing the map, so a key
 * rotation refreshes that gateway's list without touching any other gateway.
 */
const slots = new Map();

/**
 * Non-reversible fingerprint of an API key, used only as an in-memory cache
 * discriminator. The raw key never becomes part of a cache key.
 */
function credentialFingerprint(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return "";
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
}

/**
 * Everything (besides the credential) that changes what the catalog fetch or
 * enrichment returns: the route, the discovery base, the list source, and the
 * enrichment inputs. Two routes never share a slot, even on the same URL.
 */
function catalogIdentity(connection, base) {
  return JSON.stringify([
    connection.providerId ?? "",
    base,
    connection.catalogMode ?? "auto",
    connection.userId ?? "",
    connection.useModelsDev === false ? "" : connection.modelsUrl ?? "",
    connection.defaultContextWindow ?? "",
    connection.maxTokens ?? "",
  ]);
}

function slotFor(connection, base, apiKey) {
  const identity = catalogIdentity(connection, base);
  const credential = credentialFingerprint(apiKey);
  let slot = slots.get(identity);
  if (slot === undefined || slot.credential !== credential) {
    slot = { credential, at: 0, entries: undefined, error: undefined };
    slots.set(identity, slot);
  }
  return slot;
}

/** Drop every cached catalog (tests and explicit refresh paths). */
export function clearCatalogCache() {
  slots.clear();
}

/** Normalize a bare endpoint-type list; `undefined` when the gateway disclosed none. */
function endpointTypesOf(model) {
  const types = model.supported_endpoint_types ?? model.supportedEndpoints;
  if (!Array.isArray(types)) return undefined;
  const clean = types.filter((t) => typeof t === "string" && t.length > 0);
  return clean.length > 0 ? clean : undefined;
}

/**
 * GET one JSON document under the caller's cancellation plus a hard timeout
 * (covering the body read too). Abort and timeout surface as LlmError
 * ABORTED / TIMEOUT; a non-2xx status as AUTH / HTTP_<status>.
 */
async function fetchJson(url, headers, signal, timeoutMs, what) {
  const ms = timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(ms);
  const bounded = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let res;
  try {
    res = await fetch(url, { headers, signal: bounded });
    if (res.ok) return await res.json();
  } catch (error) {
    if (signal?.aborted) throw new LlmError(`${what} aborted by caller`, "ABORTED", { cause: error });
    if (timeout.aborted) throw new LlmError(`${what} timed out after ${ms}ms`, "TIMEOUT", { cause: error });
    throw error;
  }
  await res.body?.cancel();
  throw new LlmError(`${what} failed (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? "AUTH" : `HTTP_${res.status}`, { status: res.status });
}

/** Authorization header for a key; none at all without one (never `Bearer undefined`). */
function bearer(apiKey) {
  return typeof apiKey === "string" && apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {};
}

/** Fetch the OpenAI-compatible model list. */
async function fetchV1Models(baseURL, apiKey, signal, timeoutMs) {
  const body = await fetchJson(`${baseURL}/v1/models`, { ...bearer(apiKey), ...attributionHeaders() }, signal, timeoutMs, "newapi model list");
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
async function fetchManagementModels(baseURL, apiKey, userId, signal, timeoutMs) {
  const body = await fetchJson(`${baseURL}/api/user/models`, {
    ...bearer(apiKey),
    "new-api-user": String(userId ?? "1"),
    ...attributionHeaders(),
  }, signal, timeoutMs, "newapi management model list");
  const data = Array.isArray(body?.data) ? body.data : [];
  const entries = [];
  for (const id of data) {
    if (typeof id !== "string" || id.length === 0) continue;
    entries.push({ id, ownedBy: undefined, endpointTypes: undefined });
  }
  return entries;
}

/**
 * Strip trailing slashes and a trailing version segment (`/v1`, `/v2`, and
 * the Gemini-style `/v1beta`) from a gateway base URL. The catalog always
 * appends its own full paths (`/v1/models`, `/api/user/models`), so a
 * user-supplied base that already carries a version (the SDK conventions,
 * which the chat path also accepts) must not leak through as
 * `/v1/v1/models` or `/v1beta/v1/models`. Mirrors the derivation the custom
 * (protocol-URL) template performs in `protocols.js`.
 */
function stripVersion(baseURL) {
  return String(baseURL ?? "").replace(/\/+$/, "").replace(/\/v\d+(?:beta)?$/i, "");
}

/**
 * The base URL model discovery fetches `/v1/models` against. Gateways with
 * protocol URL fields (custom template) derive it from their OpenAI-style
 * URL; `null` means discovery is impossible (e.g. only an Anthropic address
 * is configured) and the catalog is exactly the user-declared models.
 * The returned base is version-stripped: the catalog suffixes below always
 * append the version segment themselves.
 */
function discoveryBase(connection) {
  const base = connection.catalogBase !== undefined ? connection.catalogBase : connection.baseURL;
  if (typeof base !== "string" || base.length === 0) return null;
  const stripped = stripVersion(base);
  return stripped.length > 0 ? stripped : null;
}

/**
 * Discover the raw model list from the gateway.
 * `auto` mode prefers the OpenAI-compatible route and falls back to the
 * management route; explicit modes fail loud instead of falling back.
 * Returns [] without any network call when no discovery base exists.
 */
async function fetchNewapiModels(connection, apiKey, signal) {
  const base = discoveryBase(connection);
  if (base === null) return [];
  const mode = connection.catalogMode ?? "auto";
  if (mode === "v1" || mode === "auto") {
    try {
      return await fetchV1Models(base, apiKey, signal, connection.catalogTimeoutMs);
    } catch (error) {
      if (mode === "v1" || mode === "auto" && (error?.failure?.code ?? error?.code) !== "AUTH") throw error;
      // AUTH on /v1/models (e.g. an access token that only the management API accepts): fall through.
    }
  }
  return fetchManagementModels(base, apiKey, connection.userId, signal, connection.catalogTimeoutMs);
}

/** Apply the picker filter (chat-only + exclude patterns, matched case-insensitively). */
function filterEntries(entries, connection) {
  const patterns = (connection.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS).map((p) => {
    try {
      return new RegExp(p, "i");
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
  const reasoning = params.reasoning ?? false;
  return {
    id: raw.id,
    ownedBy: raw.ownedBy,
    endpointTypes: raw.endpointTypes,
    name,
    description: params.description,
    family: params.family,
    reasoning,
    // A reasoning model exposes the standard off/low/medium/high levels; the
    // adapter's thinking helper refines this per-family when known.
    ...reasoning ? { thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" } } : {},
    input: normalizeInputModalities(params.input),
    contextWindow: params.contextWindow ?? connection.defaultContextWindow,
    maxTokens: params.maxTokens ?? connection.maxTokens,
    releaseDate: params.releaseDate,
  };
}

/**
 * Normalize a raw models.dev input-modality list into the harness-compatible
 * set. Always includes "text"; maps unknown formats to "text" only. Gateway
 * models without a models.dev hit default to ["text"].
 */
function normalizeInputModalities(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return ["text"];
  const set = new Set(["text"]);
  for (const m of raw) {
    const lower = String(m).toLowerCase();
    if (lower === "image" || lower === "vision") set.add("image");
  }
  return [...set];
}

/**
 * Read the (cached, lazily refreshed) enriched catalog for one connection.
 * @returns the full enriched entry list (before picker filtering), or an
 *   empty array when discovery fails and no snapshot exists.
 */
export async function getCatalog(connection, apiKey, signal) {
  const base = discoveryBase(connection);
  if (base === null) return []; // no discovery endpoint: declared models only
  const slot = slotFor(connection, base, apiKey);
  const now = Date.now();
  const ttl = connection.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  if (slot.entries !== undefined && now - slot.at < ttl) return slot.entries;
  try {
    const raw = await fetchNewapiModels(connection, apiKey, signal);
    const modelsDev = connection.useModelsDev === false ? undefined : await fetchModelsDev(connection.modelsUrl, signal, undefined, connection.catalogTimeoutMs);
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

/**
 * Sort the picker list newest-first by release date. Entries without a known
 * release date sort first (treated as the newest), then by name for stable
 * ordering. Returns a new array; the input is not mutated.
 */
function sortByRelease(entries) {
  return [...entries].sort((a, b) => {
    const da = a.releaseDate ?? "";
    const db = b.releaseDate ?? "";
    if (da === db) return (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);
    if (da.length === 0) return -1; // unknown → newest
    if (db.length === 0) return 1;
    return db.localeCompare(da); // YYYY-MM-DD, descending
  });
}

/** The picker-facing model list (enriched + filtered + sorted + overridden). */
export async function listPickerModels(connection, apiKey, signal) {
  const entries = await getCatalog(connection, apiKey, signal);
  const overridden = applyModelConfig(mergeCustomModels(entries, connection.modelOverrides), connection.modelOverrides);
  // Protocol availability: with URL-addressed gateways (custom template) only
  // the configured protocols are servable. An explicit per-model protocol
  // override pins the types first, mirroring the adapter's provider build —
  // so the picker never lists a model requests would drop.
  const pinnedTypes = (id) => {
    const p = connection.modelOverrides?.[id]?.protocol;
    return typeof p === "string" && p.length > 0 ? [p] : Array.isArray(p) ? p : undefined;
  };
  const served = overridden.filter((e) => effectiveEndpointTypes(pinnedTypes(e.id) ?? e.endpointTypes, connection.availableTypes) !== null);
  const filtered = filterEntries(served, connection);
  return connection.sortModelsByRelease === false ? filtered : sortByRelease(filtered);
}

/**
 * Apply per-model overrides: drop disabled models, override name/context/
 * maxTokens. Returns a new array; the input is not mutated.
 */
function applyModelConfig(entries, overrides) {
  if (overrides === undefined || Object.keys(overrides).length === 0) return entries;
  return entries
    .filter((e) => overrides[e.id]?.disabled !== true)
    .map((e) => {
      const ov = overrides[e.id];
      if (ov === undefined) return e;
      return {
        ...e,
        ...typeof ov.name === "string" && ov.name.length > 0 ? { name: ov.name } : {},
        ...Number.isFinite(ov.contextWindow) && ov.contextWindow > 0 ? { contextWindow: ov.contextWindow } : {},
        ...Number.isFinite(ov.maxTokens) && ov.maxTokens > 0 ? { maxTokens: ov.maxTokens } : {},
      };
    });
}

/**
 * Merge custom models (declared in config but absent from the gateway list)
 * into the entry list so they appear in the picker. Custom models inherit no
 * endpoint types, so they default to the OpenAI protocol unless overridden.
 */
function mergeCustomModels(entries, overrides) {
  if (overrides === undefined) return entries;
  const present = new Set(entries.map((e) => e.id));
  const merged = [...entries];
  for (const [id, ov] of Object.entries(overrides)) {
    if (present.has(id)) continue; // override of an existing model, not a custom add
    if (ov === undefined || ov.disabled === true) continue;
    merged.push({
      id,
      ownedBy: undefined,
      endpointTypes: undefined,
      name: ov.name ?? id,
      description: undefined,
      family: undefined,
      reasoning: undefined,
      contextWindow: ov.contextWindow,
      maxTokens: ov.maxTokens,
      releaseDate: "",
    });
  }
  return merged;
}

/**
 * Discover the raw model list from one gateway, returned in the harness
 * `LlmDiscoveredModel` shape for the web UI's "Fetch available models".
 * @returns id/name/contextWindow/maxTokens/protocol/reasoning per model, where
 *   protocol is the endpoint type auto-pickModelApi would select (informational
 *   for the settings UI) and reasoning flags models.dev reasoning support.
 */
export async function discoverGatewayModels(connection, apiKey, signal) {
  const raw = await fetchNewapiModels(connection, apiKey, signal);
  const modelsDev = connection.useModelsDev === false ? undefined : await fetchModelsDev(connection.modelsUrl, signal, undefined, connection.catalogTimeoutMs);
  // Reuse enrichEntry so the discovery surface shows the same names as the
  // picker — including variant tags (e.g. "GLM-5.2 Highspeed") that a bare
  // models.dev lookup would collapse to the base name.
  return raw
    .filter((m) => effectiveEndpointTypes(endpointTypesOf(m), connection.availableTypes) !== null)
    .map((m) => {
      const entry = enrichEntry(m, modelsDev, connection);
      return {
        id: entry.id,
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
        protocol: endpointTypeOfApi(pickModelApi(effectiveEndpointTypes(entry.endpointTypes, connection.availableTypes), connection.endpointPriority)),
        reasoning: entry.reasoning === true,
      };
    });
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
