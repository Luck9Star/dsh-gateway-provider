/**
 * Model thinking-level management, reusing the model directory and reasoning
 * machinery of `@earendil-works/pi-ai` (the library behind the official
 * `llm-pi-ai` adapter). The plugin pins its own copy, kept on the major
 * version the harness uses (1.x), so both see the same catalog.
 *
 * Instead of heuristically deriving reasoning levels, this module:
 *
 * 1. looks the model up in pi-ai's builtin catalog (about 1,190 model ids
 *    across 43 providers in pi-ai 1.5) by id — every entry carries `reasoning` plus a
 *    `thinkingLevelMap` that spells the provider-native wire value for each
 *    thinking level (`null` = unsupported, absent = supported with the level
 *    string itself as the wire value);
 * 2. derives the selectable levels with pi-ai's own
 *    {@link getSupportedThinkingLevels} (levels `off` / `minimal` / `low` /
 *    `medium` / `high` / `xhigh` / `max` with pi-ai's asymmetric defaulting:
 *    an absent key supports the base levels, while `xhigh`/`max` need an
 *    explicit value);
 * 3. hands the request model (its `reasoning` flag and `thinkingLevelMap`,
 *    see {@link reasoningSpec}) to pi-ai, whose protocol APIs spell the wire
 *    fields; this module serializes nothing itself. For openai-completions,
 *    `compat.thinkingFormat === "deepseek"` models get
 *    `thinking: {type: enabled|disabled}` (+ `reasoning_effort` unless
 *    `supportsReasoningEffort` is false); everything else gets OpenAI-style
 *    `reasoning_effort` mapped through `thinkingLevelMap`.
 *
 * Gateway model ids are first normalized to their base form (namespace prefix
 * and channel suffixes like `-highspeed` stripped) so variants such as
 * `glm-5.2-highspeed` resolve to `glm-5.2`; the same model advertised under
 * several providers is resolved to its first-party entry (native wire
 * semantics) rather than an arbitrary aggregator copy.
 *
 * Only when the pi-ai catalog misses a model (custom gateway entries) does the
 * module fall back to models.dev inference (`reasoning: true` + family; Off
 * is then sent as `"none"`), with
 * an optional `extended` mode that widens the fallback to the full normalized
 * level set for the user to choose explicitly.
 *
 * @module dsh-gateway-provider/thinking
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

/** Gateway channel-suffix markers stripped before a catalog lookup. */
const MODEL_VARIANT_SUFFIXES = ["highspeed", "high-speed", "lowspeed", "low-speed"];
const VARIANT_SUFFIX_RE = new RegExp(`-(${MODEL_VARIANT_SUFFIXES.join("|")})$`, "i");

/**
 * Normalize a gateway model id to its base form: lowercase, strip any
 * `provider/` namespace, and drop a trailing gateway channel suffix
 * (`-highspeed`, `-lowspeed`, ...). Variants like `glm-5.2-highspeed`
 * resolve to their catalog model `glm-5.2`. Variant identity is preserved
 * separately by {@link variantLabel} so pickers can tell them apart.
 * @param id - the gateway-advertised model id.
 * @returns the normalized base id, or "" when there is nothing usable.
 */
export function baseModelId(id) {
  const s = String(id ?? "").trim().toLowerCase();
  if (s.length === 0) return "";
  const bare = s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
  return bare.replace(VARIANT_SUFFIX_RE, "");
}

/**
 * The human-readable variant tag stripped by {@link baseModelId}, Title-Cased
 * (e.g. `glm-5.2-highspeed` → `Highspeed`, `gpt-5.5-lowspeed` → `Lowspeed`).
 * Returns "" for non-variant ids so the base model name is left untouched.
 * @param id - the gateway-advertised model id.
 */
export function variantLabel(id) {
  const m = VARIANT_SUFFIX_RE.exec(String(id ?? ""));
  if (m === null) return "";
  const tag = m[1].replace(/-/g, "").toLowerCase();
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

/** Providers whose entries describe the model's native wire format. */
const FIRST_PARTY = new Set([
  "deepseek", "minimax", "minimax-cn", "zai", "zai-coding-cn",
  "moonshotai", "moonshotai-cn", "kimi-coding",
  "anthropic", "openai", "openai-codex", "google", "google-vertex", "xai",
  "mistral", "groq", "cerebras", "nvidia", "together", "xiaomi", "ant-ling",
]);

/** Preferred first-party provider per model family (the lab's native wire). */
const FAMILY_PROVIDER = [
  [/deepseek/, "deepseek"],
  [/glm|zai/, "zai"],
  [/kimi/, "moonshotai"],
  [/minimax/, "minimax"],
  [/gpt|chatgpt|\bo[1-9]/, "openai"],
  [/claude|anthropic/, "anthropic"],
  [/gemini|google/, "google"],
  [/grok/, "xai"],
  [/mistral|codestral/, "mistral"],
];

/**
 * Pick the most authoritative entry among several provider copies of one
 * model: the family's first-party provider wins, then any first-party entry,
 * then the original (stable) order.
 */
function preferEntry(entries, id) {
  if (entries.length === 1) return entries[0];
  const hint = FAMILY_PROVIDER.find(([re]) => re.test(id))?.[1];
  if (hint !== undefined) {
    const hit = entries.find((e) => e.provider === hint);
    if (hit !== undefined) return hit;
  }
  const firstParty = entries.find((e) => FIRST_PARTY.has(e.provider));
  return firstParty ?? entries[0];
}

/** One shared base-id → pi-ai model entry index over all built-in providers. */
let piIndex;
function indexPiModels() {
  if (piIndex !== undefined) return piIndex;
  const map = new Map();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      const key = baseModelId(model.id);
      if (key.length === 0) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(model);
    }
  }
  piIndex = map;
  return map;
}

/**
 * Look up a gateway model id in the harness's builtin pi-ai catalog, resolving
 * namespace/suffix variants and provider copies to the authoritative entry.
 */
export function findPiModel(id) {
  const key = baseModelId(id);
  if (key.length === 0) return undefined;
  const entries = indexPiModels().get(key);
  return entries === undefined ? undefined : preferEntry(entries, key);
}

/**
 * The reasoning family of one model, used for fallback and MiniMax handling.
 * The family comes from models.dev metadata when present, else from the model
 * id prefix, else from the pi-ai provider.
 */
export function reasoningFamilyOf(entry, model, piModel) {
  const id = String(model ?? piModel?.id ?? entry?.id ?? "").toLowerCase();
  const family = typeof entry?.family === "string" ? entry.family.toLowerCase() : "";
  const provider = typeof piModel?.provider === "string" ? piModel.provider.toLowerCase() : "";
  if (family.startsWith("deepseek") || id.startsWith("deepseek") || provider === "deepseek") return "deepseek";
  if (family.startsWith("minimax") || id.startsWith("minimax") || provider.startsWith("minimax")) return "minimax";
  return "generic";
}

function capitalize(level) {
  return level.length === 0 ? level : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

const effort = (level) => ({ id: ReasoningEffortId(level), name: capitalize(level) });

/** The normalized thinking-level vocabulary ReasoningEffortId accepts. */
const KNOWN_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Build a selectable effort set from an explicit user override (the per-model
 * `reasoningLevels` array). Unknown / duplicate entries are dropped; an empty
 * result means the caller should fall back to catalog inference.
 */
export function effortsFromLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const seen = new Set();
  const clean = [];
  for (const raw of levels) {
    const level = String(raw ?? "").toLowerCase();
    if (!KNOWN_LEVELS.has(level) || seen.has(level)) continue;
    seen.add(level);
    clean.push(effort(level));
  }
  return clean;
}

/** Native DeepSeek reasoning set (off / high / max). */
const DEEPSEEK_EFFORTS = [effort("off"), effort("high"), effort("max")];
/** MiniMax has a two-state wire (`adaptive|disabled`): off + one "on" level. */
const MINIMAX_EFFORTS = [effort("off"), effort("high")];
/** OpenAI-standard generic set, safe for unknown reasoning models. */
const GENERIC_EFFORTS = [effort("off"), effort("low"), effort("medium"), effort("high")];
/** Full normalized set, offered only under the explicit `extended` opt-in. */
const EXTENDED_EFFORTS = [effort("off"), effort("minimal"), effort("low"), effort("medium"), effort("high"), effort("xhigh"), effort("max")];

/**
 * The selectable reasoning efforts for one model.
 *
 * With a pi-ai catalog hit the level set is pi-ai's own answer for that exact
 * model (including its per-level support matrix), except MiniMax, which is
 * collapsed to its real two-state wire. Without a hit, models.dev inference
 * falls back to family heuristics; `extended` widens the generic fallback to
 * the full normalized set for explicit user choice.
 */
export function thinkingEffortsOf(entry, piModel, opts = {}) {
  const extended = opts.extended === true;
  if (piModel !== undefined) {
    if (piModel.reasoning !== true) return undefined;
    if (reasoningFamilyOf(entry, undefined, piModel) === "minimax") return { efforts: MINIMAX_EFFORTS };
    const levels = getSupportedThinkingLevels(piModel);
    if (levels.length === 0 || levels.length === 1 && levels[0] === "off") return undefined;
    return { efforts: levels.map((level) => ({ id: ReasoningEffortId(level), name: capitalize(level) })) };
  }
  if (entry === undefined || entry.reasoning !== true) return undefined;
  switch (reasoningFamilyOf(entry)) {
    case "deepseek":
      return { efforts: DEEPSEEK_EFFORTS };
    case "minimax":
      return { efforts: MINIMAX_EFFORTS };
    default:
      return { efforts: extended ? EXTENDED_EFFORTS : GENERIC_EFFORTS };
  }
}

/** pi-ai's level order (models.js EXTENDED_THINKING_LEVELS). */
const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/**
 * Wire value pi-ai sends for an explicit Off on OpenAI-style APIs
 * (`reasoning_effort` / `reasoning.effort`); "none" is the OpenAI-standard
 * "no reasoning" effort that OpenAI-compatible gateways pass through.
 */
export const OFF_WIRE_VALUE = "none";
/** Level maps this module synthesized (see {@link requestModel}). */
const synthesizedMaps = new WeakSet();

/** A thinkingLevelMap that makes exactly `efforts` sendable (off → "none"). */
function synthesizedMap(efforts) {
  const ids = new Set(efforts.map((e) => e.id));
  const map = Object.fromEntries(LEVEL_ORDER.map((level) => [level, ids.has(level) ? (level === "off" ? OFF_WIRE_VALUE : level) : null]));
  synthesizedMaps.add(map);
  return map;
}

/** An effort list worth showing: at least one level besides Off. */
const selectable = (efforts) => efforts !== undefined && efforts.some((e) => e.id !== "off") ? efforts : undefined;

/**
 * The one source of truth for a model's reasoning: the efforts the picker
 * advertises AND the pi-ai `reasoning` / `thinkingLevelMap` the request is
 * built with, so every advertised level is one pi-ai will actually send.
 *
 * - An explicit per-model `reasoningLevels` override wins.
 * - A pi-ai catalog hit keeps pi-ai's native map; advertised levels are
 *   limited to those pi-ai can send for it.
 * - Otherwise the models.dev inference is turned into a synthesized map.
 * @param entry - the enriched catalog entry (may be undefined).
 * @param piModel - the pi-ai catalog hit (may be undefined).
 * @param override - the per-model settings override (may be undefined).
 * @param opts - `{ extended }` widens the unknown-model fallback.
 * @returns `{ reasoning, thinkingLevelMap, efforts }`; efforts undefined = no Effort row.
 */
export function reasoningSpec(entry, piModel, override, opts = {}) {
  const overridden = effortsFromLevels(override?.reasoningLevels);
  if (overridden.length > 0) {
    const efforts = selectable(overridden);
    return { reasoning: efforts !== undefined, thinkingLevelMap: synthesizedMap(overridden), efforts };
  }
  if (piModel !== undefined) {
    const native = { reasoning: piModel.reasoning === true, thinkingLevelMap: piModel.thinkingLevelMap };
    const sendable = new Set(getSupportedThinkingLevels(native));
    const efforts = selectable(thinkingEffortsOf(entry, piModel, opts)?.efforts.filter((e) => sendable.has(e.id)));
    return { ...native, efforts };
  }
  const wanted = thinkingEffortsOf(entry, undefined, opts)?.efforts;
  if (wanted === undefined) return { reasoning: false, thinkingLevelMap: undefined, efforts: undefined };
  return { reasoning: true, thinkingLevelMap: synthesizedMap(wanted), efforts: wanted };
}

/**
 * The model to send one request with. pi-ai treats "no effort" as Off and
 * would send a synthesized map's Off value; a request without a chosen
 * effort keeps the gateway's own default instead, as before.
 */
export function requestModel(model, effort) {
  if (effort !== undefined || !synthesizedMaps.has(model.thinkingLevelMap)) return model;
  return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } };
}
