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
 * Only when the pi-ai catalog misses a model (custom gateway entries) does the
 * module fall back to models.dev inference (`reasoning: true` + family).
 *
 * @module dsh-newapi-provider/thinking
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

/** One shared id → pi-ai model index over all built-in providers. */
let piIndex;
function indexPiModels() {
  if (piIndex !== undefined) return piIndex;
  const map = new Map();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      if (!map.has(model.id)) map.set(model.id, model);
    }
  }
  piIndex = map;
  return map;
}

/** Look up a gateway model id in the harness's builtin pi-ai catalog. */
export function findPiModel(id) {
  return indexPiModels().get(id);
}

/** The reasoning family of one model, used for fallback and MiniMax handling. */
export function reasoningFamilyOf(entry, model) {
  const id = String(model ?? entry?.id ?? "").toLowerCase();
  const family = typeof entry?.family === "string" ? entry.family.toLowerCase() : "";
  if (family.startsWith("deepseek") || id.startsWith("deepseek")) return "deepseek";
  if (family.startsWith("minimax") || id.startsWith("minimax")) return "minimax";
  return "generic";
}

function capitalize(level) {
  return level.length === 0 ? level : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

const DEEPSEEK_FALLBACK_EFFORTS = [
  { id: ReasoningEffortId("off"), name: "Off" },
  { id: ReasoningEffortId("high"), name: "High" },
  { id: ReasoningEffortId("max"), name: "Max" },
];
const GENERIC_FALLBACK_EFFORTS = [
  { id: ReasoningEffortId("off"), name: "Off" },
  { id: ReasoningEffortId("low"), name: "Low" },
  { id: ReasoningEffortId("medium"), name: "Medium" },
  { id: ReasoningEffortId("high"), name: "High" },
];

/**
 * The selectable reasoning efforts for one model.
 *
 * With a pi-ai catalog hit the level set is pi-ai's own answer for that exact
 * model (including its per-level support matrix). Without one, the models.dev
 * inference falls back to the family heuristics.
 */
export function thinkingEffortsOf(entry, piModel) {
  if (piModel !== undefined) {
    if (piModel.reasoning !== true) return undefined;
    const levels = getSupportedThinkingLevels(piModel);
    if (levels.length === 0 || levels.length === 1 && levels[0] === "off") return undefined;
    return { efforts: levels.map((level) => ({ id: ReasoningEffortId(level), name: capitalize(level) })) };
  }
  if (entry === undefined || entry.reasoning !== true) return undefined;
  switch (reasoningFamilyOf(entry)) {
    case "deepseek":
    case "minimax":
      return { efforts: DEEPSEEK_FALLBACK_EFFORTS };
    default:
      return { efforts: GENERIC_FALLBACK_EFFORTS };
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
  if (reasoningFamilyOf(entry, options.model) === "minimax") {
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
