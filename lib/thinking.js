/**
 * Model thinking-level management, reusing the DeepSeek Harness's own model
 * directory and reasoning machinery from `@earendil-works/pi-ai` (the library
 * behind the official `llm-pi-ai` adapter, always installed with the harness).
 *
 * Instead of heuristically deriving reasoning levels, this module:
 *
 * 1. looks the model up in pi-ai's builtin catalog (1100+ models across 37
 *    providers) by id — every entry carries `reasoning` plus a
 *    `thinkingLevelMap` that spells the provider-native wire value for each
 *    thinking level (`null` = unsupported, absent = supported with the level
 *    string itself as the wire value);
 * 2. derives the selectable levels with pi-ai's own
 *    {@link getSupportedThinkingLevels} (levels `off` / `minimal` / `low` /
 *    `medium` / `high` / `xhigh` / `max` with pi-ai's asymmetric defaulting:
 *    an absent key supports the base levels, while `xhigh`/`max` need an
 *    explicit value);
 * 3. serializes the thinking parameters following pi-ai's openai-completions
 *    branches: `compat.thinkingFormat === "deepseek"` models get
 *    `thinking: {type: enabled|disabled}` (+ `reasoning_effort` unless
 *    `supportsReasoningEffort` is false), everything else gets OpenAI-style
 *    `reasoning_effort` mapped through `thinkingLevelMap`.
 *
 * Gateway model ids are first normalized to their base form (namespace prefix
 * and channel suffixes like `-highspeed` stripped) so variants such as
 * `glm-5.2-highspeed` resolve to `glm-5.2`; the same model advertised under
 * several providers is resolved to its first-party entry (native wire
 * semantics) rather than an arbitrary aggregator copy.
 *
 * Only when the pi-ai catalog misses a model (custom gateway entries) does the
 * module fall back to models.dev inference (`reasoning: true` + family), with
 * an optional `extended` mode that widens the fallback to the full normalized
 * level set for the user to choose explicitly.
 *
 * @module dsh-newapi-provider/thinking
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

/** Map a level through the model's thinkingLevelMap (absent → the level itself). */
function mappedWire(tlm, level) {
  if (tlm === undefined || tlm === null) return level;
  const value = tlm[level];
  return value === undefined ? level : value;
}

/**
 * OpenAI-route thinking fields, mirroring pi-ai's openai-completions dispatch:
 * `thinkingFormat === "deepseek"` → `thinking: {type}` (+ `reasoning_effort`
 * unless the model declares `supportsReasoningEffort: false`); every other
 * reasoning model → OpenAI-style `reasoning_effort` mapped through
 * `thinkingLevelMap`. MiniMax keeps the gateway-verified two-state
 * `thinking: {type: adaptive|disabled}` (its OpenAI-compatible layer rejects
 * `enabled` and has no `reasoning_effort`).
 */
export function thinkingFieldsOpenAI(options, entry, piModel) {
  const effort = options.reasoningEffort;
  if (effort === undefined) return {};
  if (reasoningFamilyOf(entry, options.model, piModel) === "minimax") {
    if (effort === "off") return { thinking: { type: "disabled" } };
    return { thinking: { type: "adaptive" } };
  }
  const tlm = piModel?.thinkingLevelMap;
  const compat = piModel?.compat;
  if (compat?.thinkingFormat === "deepseek") {
    if (effort !== "off") {
      return {
        thinking: { type: "enabled" },
        ...compat.supportsReasoningEffort === false ? {} : { reasoning_effort: mappedWire(tlm, effort) },
      };
    }
    return tlm?.off === null ? {} : { thinking: { type: "disabled" } };
  }
  if (effort === "off") {
    const offWire = tlm?.off;
    return offWire === undefined || offWire === null ? {} : { reasoning_effort: offWire };
  }
  return { reasoning_effort: mappedWire(tlm, effort) };
}

/** Anthropic-route thinking fields: enabled + budget_tokens, budgeted by level. */
export function thinkingFieldsAnthropic(options, entry) {
  const effort = options.reasoningEffort;
  if (effort === undefined) return {};
  if (reasoningFamilyOf(entry, options.model) !== "generic") return {};
  if (effort === "off") return { thinking: { type: "disabled" } };
  const budgetTokens = budgetFor(effort, 1024, 4096, 8192, 16384);
  return { thinking: { type: "enabled", budget_tokens: budgetTokens } };
}

/** Gemini-route thinking config: thinkingBudget, budgeted by level. */
export function thinkingFieldsGemini(options, entry) {
  const effort = options.reasoningEffort;
  if (effort === undefined) return {};
  if (reasoningFamilyOf(entry, options.model) !== "generic") return {};
  if (effort === "off") return {};
  return { thinkingConfig: { thinkingBudget: budgetFor(effort, 1024, 4096, 16384, 32768) } };
}

/** Budget mapping for the two budget-style formats. */
function budgetFor(effort, lowBudget, mediumBudget, highBudget, maxBudget) {
  switch (effort) {
    case "minimal":
    case "low":
      return lowBudget;
    case "medium":
      return mediumBudget;
    case "xhigh":
    case "max":
      return maxBudget;
    default:
      return highBudget;
  }
}
