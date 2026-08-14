/**
 * models.dev catalog enrichment.
 *
 * Fetches https://models.dev/models.json (configurable via `modelsUrl`) once
 * per TTL and extracts per-model capability parameters used for automatic
 * model control: context window, output-token cap, reasoning support, and
 * family. The registry keys are namespaced
 * (`minimax/MiniMax-M3`, `deepseek/deepseek-v4-flash`), while the newapi
 * gateway advertises bare ids, so matching is a normalized suffix match.
 *
 * The enrichment is advisory: when the catalog is unreachable the adapter
 * keeps working with configured defaults instead of failing requests.
 *
 * @module dsh-gateway-provider/modelsdev
 */

const DEFAULT_MODELS_URL = "https://models.dev/models.json";
/** In-memory cache: one raw map per URL, refreshed after the TTL. */
let modelsDevCache = { url: undefined, at: 0, data: undefined };

/** Normalize a model id for fuzzy matching (case + whitespace + slash). */
function normalizeId(id) {
  return String(id).trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Match a gateway model id against the namespaced models.dev keys.
 * Exact key wins, then a case-insensitive suffix match after the last "/",
 * then any normalized suffix equality.
 * @param raw - the parsed models.dev map (id -> entry).
 * @param id - the gateway model id.
 * @returns the matched entry, or undefined.
 */
export function matchModelsDev(raw, id) {
  if (raw === undefined) return undefined;
  const direct = raw[id];
  if (direct !== undefined) return direct;
  const normalized = normalizeId(id);
  if (normalized.length === 0) return undefined;
  const bare = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
  for (const [key, entry] of Object.entries(raw)) {
    const keyNorm = normalizeId(key);
    const keyBare = keyNorm.includes("/") ? keyNorm.slice(keyNorm.lastIndexOf("/") + 1) : keyNorm;
    if (keyNorm === normalized || keyBare === bare) return entry;
  }
  return undefined;
}

/**
 * Fetch and cache the raw models.dev map.
 * @param modelsUrl - catalog URL (file: URLs work for offline mirrors).
 * @param signal - caller cancellation.
 * @param ttlMs - cache freshness window.
 * @returns the parsed map (id -> entry), or undefined when unavailable.
 */
export async function fetchModelsDev(modelsUrl = DEFAULT_MODELS_URL, signal, ttlMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  const cache = modelsDevCache;
  if (cache.url === modelsUrl && cache.data !== undefined && now - cache.at < ttlMs) {
    return cache.data;
  }
  try {
    const res = await fetch(modelsUrl, { signal });
    if (!res.ok) return cache.url === modelsUrl ? cache.data : undefined;
    const data = await res.json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
    modelsDevCache = { url: modelsUrl, at: Date.now(), data };
    return data;
  } catch {
    // Offline or transient failure: keep the last good snapshot when we have one.
    return cache.url === modelsUrl ? cache.data : undefined;
  }
}

/**
 * Extract the adapter-relevant parameters of one models.dev entry.
 * @param entry - a matched models.dev entry (may be undefined).
 * @returns a detached parameter object, all fields optional.
 */
export function extractModelsDevParams(entry) {
  if (entry === undefined || typeof entry !== "object" || entry === null) return {};
  const limit = typeof entry.limit === "object" && entry.limit !== null ? entry.limit : {};
  const modalities = typeof entry.modalities === "object" && entry.modalities !== null ? entry.modalities : {};
  const inputModalities = Array.isArray(modalities.input)
    ? modalities.input.filter((m) => typeof m === "string" && m.length > 0)
    : [];
  return {
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined,
    description: typeof entry.description === "string" && entry.description.length > 0 ? entry.description : undefined,
    family: typeof entry.family === "string" && entry.family.length > 0 ? entry.family : undefined,
    reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
    input: inputModalities.length > 0 ? inputModalities : undefined,
    attachment: typeof entry.attachment === "boolean" ? entry.attachment : undefined,
    contextWindow: Number.isFinite(limit.context) && limit.context > 0 ? limit.context : undefined,
    maxTokens: Number.isFinite(limit.output) && limit.output > 0 ? limit.output : undefined,
    releaseDate: normalizeReleaseDate(entry.release_date ?? entry.releaseDate),
  };
}

/**
 * Coerce a models.dev release date (YYYY-MM-DD, YYYY-MM, or YYYY) into a
 * lexicographically sortable YYYY-MM-DD string (missing month/day padded to
 * -01). Returns "" for anything else so callers can compare with `<`.
 */
function normalizeReleaseDate(value) {
  if (typeof value !== "string") return "";
  const parts = value.trim().split("-");
  if (parts.length < 1 || !/^\d{4}$/.test(parts[0])) return "";
  const y = parts[0];
  const m = parts.length > 1 && /^\d{2}$/.test(parts[1]) ? parts[1] : "01";
  const d = parts.length > 2 && /^\d{2}$/.test(parts[2]) ? parts[2] : "01";
  return `${y}-${m}-${d}`;
}
