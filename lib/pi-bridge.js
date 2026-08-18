/**
 * Harness ↔ pi-ai conversion bridge.
 *
 * Pure functions extracted from the official `@deepseek-ai/dsh-llm-pi-ai`
 * adapter (its `context`, `stream`, and `replay` modules), so a gateway-based
 * provider can reuse the exact same pi-ai Context assembly and StreamChunk
 * translation as the catalog-backed official provider, without reimplementing
 * the wire formats itself.
 *
 * Three layers:
 * - `toPiContext(options, attachments?)` — harness GenerateOptions → pi-ai Context
 * - `toStreamChunks(events, contextWindow)` — pi-ai EventStream → harness StreamChunks
 * - `mapStopReason(message, contextWindow)` — pi-ai stopReason → harness FinishReason
 *
 * @module dsh-gateway-provider/pi-bridge
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { isContextOverflow } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// argument parsing (shared with the old adapter)
// ---------------------------------------------------------------------------

/** Parse tool-call argument JSON; tolerate model malformations with {}. */
export function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

/** Construct the zero usage value required by historical pi-ai messages. */
function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ---------------------------------------------------------------------------
// replay state (provider-native metadata for assistant history reconstruction)
// ---------------------------------------------------------------------------

/**
 * Project a successful pi-ai response into the minimal durable replay state.
 * Lifted verbatim from dsh-llm-pi-ai/replay.
 */
export function toPiReplayState(message) {
  return {
    kind: "pi-ai",
    version: 1,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...message.responseModel === void 0 ? {} : { responseModel: message.responseModel },
    ...message.responseId === void 0 ? {} : { responseId: message.responseId },
    stopReason: message.stopReason,
    blocks: message.content.map((block) => {
      switch (block.type) {
        case "text": return {
          type: "text",
          ...block.textSignature === void 0 ? {} : { textSignature: block.textSignature },
        };
        case "thinking": return {
          type: "reasoning",
          ...block.thinkingSignature === void 0 ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === void 0 ? {} : { redacted: block.redacted },
        };
        case "toolCall": return {
          type: "tool-call",
          ...block.thoughtSignature === void 0 ? {} : { thoughtSignature: block.thoughtSignature },
        };
      }
    }),
  };
}

function invalidReplay(message) {
  throw new LlmError(`invalid pi-ai replay state: ${message}`, "INVALID_REPLAY_STATE");
}

/** Validate the adapter-private state before it reaches pi-ai. */
function readReplayState(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay("expected an object");
  const state = value;
  if (state["kind"] !== "pi-ai") return invalidReplay("unknown state kind");
  if (state["version"] !== 1) return invalidReplay(`unsupported version ${String(state["version"])}`);
  for (const key of ["api", "provider", "model"]) {
    if (typeof state[key] !== "string" || state[key].length === 0) return invalidReplay(`${key} must be a non-empty string`);
  }
  if (!["stop", "length", "toolUse", "error", "aborted"].includes(String(state["stopReason"]))) return invalidReplay("unknown stopReason");
  if (state["responseModel"] !== void 0 && typeof state["responseModel"] !== "string") return invalidReplay("responseModel must be a string");
  if (state["responseId"] !== void 0 && typeof state["responseId"] !== "string") return invalidReplay("responseId must be a string");
  if (!Array.isArray(state["blocks"])) return invalidReplay("blocks must be an array");
  for (const [index, v] of state["blocks"].entries()) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return invalidReplay(`block ${index} must be an object`);
    const block = v;
    if (!["text", "reasoning", "tool-call"].includes(String(block["type"]))) return invalidReplay(`block ${index} has an unknown type`);
    for (const signature of ["textSignature", "thinkingSignature", "thoughtSignature"]) {
      if (block[signature] !== void 0 && typeof block[signature] !== "string") return invalidReplay(`block ${index} ${signature} must be a string`);
    }
    if (block["redacted"] !== void 0 && typeof block["redacted"] !== "boolean") return invalidReplay(`block ${index} redacted must be boolean`);
  }
  return state;
}

/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message) {
  const source = message.source.kind === "model" ? message.source : void 0;
  const content = [];
  for (const block of message.content) switch (block.type) {
    case "text":
      content.push({ type: "text", text: block.text });
      break;
    case "reasoning":
      content.push({ type: "thinking", thinking: block.text });
      break;
    case "tool-call":
      content.push({ type: "toolCall", id: block.id, name: block.name, arguments: parseArguments(block.arguments) });
      break;
    case "image": throw new LlmError("pi-ai chat history cannot represent structured assistant image output", "UNSUPPORTED_CONTENT");
    default: break;
  }
  return {
    role: "assistant",
    content,
    api: "dsh-foreign",
    provider: source?.provider ?? "dsh-foreign",
    model: source?.model ?? "dsh-foreign",
    usage: emptyPiUsage(),
    stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
  };
}

/** Recombine durable Harness content with validated pi-ai replay metadata. */
function replayedAssistant(message, source, rawState) {
  const state = readReplayState(rawState);
  if (state.provider !== source.provider) return invalidReplay("provider does not match assistant source");
  if (state.model !== source.model) return invalidReplay("model does not match assistant source");
  if (state.blocks.length !== message.content.length) return invalidReplay("block count does not match assistant content");
  return {
    role: "assistant",
    content: message.content.map((block, index) => {
      const replay = state.blocks[index];
      if (replay === void 0 || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`);
      switch (block.type) {
        case "text": return {
          type: "text",
          text: block.text,
          ...replay.type === "text" && replay.textSignature !== void 0 ? { textSignature: replay.textSignature } : {},
        };
        case "reasoning": return {
          type: "thinking",
          thinking: block.text,
          ...replay.type === "reasoning" && replay.thinkingSignature !== void 0 ? { thinkingSignature: replay.thinkingSignature } : {},
          ...replay.type === "reasoning" && replay.redacted !== void 0 ? { redacted: replay.redacted } : {},
        };
        case "tool-call": return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: parseArguments(block.arguments),
          ...replay.type === "tool-call" && replay.thoughtSignature !== void 0 ? { thoughtSignature: replay.thoughtSignature } : {},
        };
        default: return invalidReplay(`block ${index} has an unsupported Harness type`);
      }
    }),
    api: state.api,
    provider: state.provider,
    model: state.model,
    ...state.responseModel === void 0 ? {} : { responseModel: state.responseModel },
    ...state.responseId === void 0 ? {} : { responseId: state.responseId },
    usage: emptyPiUsage(),
    stopReason: state.stopReason,
    timestamp: 0,
  };
}

/**
 * Convert one durable Harness assistant message into pi-ai history.
 * Lifted verbatim from dsh-llm-pi-ai/context.
 */
function toPiAssistant(message) {
  const source = message.source;
  return source.kind !== "model" || source.replayState === void 0 ? foreignAssistant(message) : replayedAssistant(message, source, source.replayState);
}

// ---------------------------------------------------------------------------
// Context assembly (harness GenerateOptions → pi-ai Context)
// ---------------------------------------------------------------------------

/** Join the text blocks of a harness message. */
function flattenText(message) {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
  return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}

/** Convert user-content blocks; image blocks read through the attachment service. */
async function userContent(blocks, attachments) {
  const content = [];
  for (const block of blocks) switch (block.type) {
    case "text":
      if (block.text.length > 0) content.push({ type: "text", text: block.text });
      break;
    case "image": {
      const stored = await attachments.readImage(block.attachment);
      content.push({
        type: "image",
        data: Buffer.from(stored.data).toString("base64"),
        mimeType: stored.ref.mediaType,
      });
      break;
    }
    case "tool-result": {
      const nested = await userContent(block.content, attachments);
      if (typeof nested === "string") {
        if (nested.length > 0) content.push({ type: "text", text: nested });
      } else content.push(...nested);
      break;
    }
    default: break;
  }
  if (content.every((block) => block.type === "text")) return content.map((block) => block.text).join("");
  return content;
}

function toolsOf(options) {
  return options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** Assemble the request-level pi-ai context envelope shared by both paths. */
function piContext(options, messages) {
  const tools = toolsOf(options);
  return {
    ...options.system !== void 0 ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
  };
}

/** Text-only fast path (no attachment service needed). */
function textOnlyContext(options) {
  const toolNames = new Map();
  const messages = [];
  for (const message of options.messages) {
    if (contentHasImage(message.content)) throw new LlmError("pi-ai image conversion requires the durable attachment service", "UNSUPPORTED_CONTENT");
    if (message.role === "system") {
      messages.push({ role: "user", content: flattenText(message), timestamp: 0 });
      continue;
    }
    if (message.role === "assistant") {
      const assistant = toPiAssistant(message);
      for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
      messages.push(assistant);
      continue;
    }
    const text = flattenText(message);
    const results = message.content.filter((block) => block.type === "tool-result");
    if (text.length > 0 || results.length === 0) messages.push({ role: "user", content: text, timestamp: 0 });
    for (const result of results) messages.push({
      role: "toolResult",
      toolCallId: result.toolCallId,
      toolName: toolNames.get(result.toolCallId) ?? "unknown",
      content: [{ type: "text", text: toolResultText(result.content) || "(no output)" }],
      isError: result.isError ?? false,
      timestamp: 0,
    });
  }
  return piContext(options, messages);
}

/** Image-capable path (reads images through the attachment service). */
async function toPiContextWithImages(options, attachments) {
  const toolNames = new Map();
  const messages = [];
  for (const message of options.messages) {
    if (message.role === "system") {
      if (contentHasImage(message.content)) throw new LlmError("pi-ai cannot represent an image in an in-history system message", "UNSUPPORTED_CONTENT");
      messages.push({ role: "user", content: flattenText(message), timestamp: 0 });
      continue;
    }
    if (message.role === "assistant") {
      const assistant = toPiAssistant(message);
      for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
      messages.push(assistant);
      continue;
    }
    const content = await userContent(message.content.filter((block) => block.type !== "tool-result"), attachments);
    const results = message.content.filter((block) => block.type === "tool-result");
    if (content.length > 0 || results.length === 0) messages.push({ role: "user", content, timestamp: 0 });
    for (const result of results) {
      const resultContent = await userContent(result.content, attachments);
      messages.push({
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? "unknown",
        content: typeof resultContent === "string"
          ? [{ type: "text", text: resultContent || "(no output)" }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      });
    }
  }
  return piContext(options, messages);
}

/**
 * Convert a harness request into a pi-ai Context.
 * @param options - the harness GenerateOptions.
 * @param attachments - the attachment service, required only when the request carries images.
 * @returns the pi-ai Context for `provider.streamSimple()`.
 */
export function toPiContext(options, attachments) {
  return attachments === void 0 ? textOnlyContext(options) : toPiContextWithImages(options, attachments);
}

// ---------------------------------------------------------------------------
// Stream translation (pi-ai EventStream → harness StreamChunks)
// ---------------------------------------------------------------------------

/**
 * Classify a pi-ai error message into a harness error code.
 * Lifted from dsh-llm-pi-ai/stream (rc.7): the coarse codes matter because
 * the harness retry stack (dsh-llm-retry) retries exactly RATE_LIMIT /
 * SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE — a generic fallback code
 * would make gateway blips unretryable.
 */
function classifyPiAiError(text) {
  if (/\b(?:401|403)\b/.test(text)) return "AUTH";
  if (isQuotaExceededError(text)) return QUOTA_EXCEEDED_CODE;
  if (/\b429\b|rate.?limit/i.test(text)) return "RATE_LIMIT";
  if (/\b400\b|invalid.?request/i.test(text)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(text)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return "TIMEOUT";
  if (/stream ended (?:before|without)\b/i.test(text)) return "TRANSPORT";
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(text)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(text)
    || /\bterminated\b|premature close/i.test(text)) return "TRANSPORT";
  return "PI_AI_ERROR";
}

/** Map pi-ai usage (reasoning folded into output by pi-ai). */
function mapUsage(usage) {
  return {
    inputTokens: Math.max(0, usage.input),
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
    ...usage.reasoning > 0 ? { reasoningTokens: usage.reasoning } : {},
  };
}

/**
 * Map a pi-ai terminal message's stopReason into the harness FinishReason.
 * Lifted verbatim from dsh-llm-pi-ai/stream.
 */
export function mapStopReason(message, contextWindow) {
  const piAiOverflow = isContextOverflow(message, contextWindow);
  const harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
  if (piAiOverflow || harnessOverflow) return {
    kind: "error",
    failure: {
      message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
    },
  };
  switch (message.stopReason) {
    case "stop":
      if (message.content.length === 0) return {
        kind: "error",
        failure: {
          message: `model "${message.model}" returned a completed response with no content`,
          code: EMPTY_RESPONSE_CODE,
        },
      };
      return { kind: "stop" };
    case "length": return { kind: "max-tokens" };
    case "toolUse": return { kind: "tool-calls" };
    case "aborted": return {
      kind: "aborted",
      failure: { message: message.errorMessage ?? "pi-ai stream aborted", code: "ABORTED" },
    };
    case "error": {
      const text = message.errorMessage ?? "pi-ai stream error";
      return { kind: "error", failure: { message: text, code: classifyPiAiError(text) } };
    }
  }
}

/**
 * Translate the pi-ai event stream into harness StreamChunks.
 * Lifted verbatim from dsh-llm-pi-ai/stream.
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the harness chunks, ending with `usage` then `finish`.
 */
export async function* toStreamChunks(events, contextWindow) {
  const toolIds = new Map();
  for await (const event of events) switch (event.type) {
    case "start": break;
    case "text_start":
      yield { type: "block-start", index: event.contentIndex, blockType: "text" };
      break;
    case "text_delta":
      yield { type: "text-delta", index: event.contentIndex, text: event.delta };
      break;
    case "text_end":
      yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
      break;
    case "thinking_start":
      yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
      break;
    case "thinking_delta":
      yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
      break;
    case "thinking_end":
      yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
      break;
    case "toolcall_start": {
      const partial = event.partial.content[event.contentIndex];
      const id = partial?.type === "toolCall" ? partial.id : "";
      const name = partial?.type === "toolCall" ? partial.name : "";
      toolIds.set(event.contentIndex, { id, name });
      yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
      break;
    }
    case "toolcall_delta": {
      const known = toolIds.get(event.contentIndex);
      yield {
        type: "tool-call-delta",
        index: event.contentIndex,
        id: CallId(known?.id ?? ""),
        ...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
        argumentsDelta: event.delta,
      };
      break;
    }
    case "toolcall_end":
      yield {
        type: "block-end",
        index: event.contentIndex,
        block: {
          type: "tool-call",
          id: CallId(event.toolCall.id),
          name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments),
        },
      };
      break;
    case "done":
      yield { type: "usage", usage: mapUsage(event.message.usage) };
      yield { type: "finish", reason: mapStopReason(event.message, contextWindow), replayState: toPiReplayState(event.message) };
      return;
    case "error":
      yield { type: "usage", usage: mapUsage(event.error.usage) };
      yield { type: "finish", reason: mapStopReason(event.error, contextWindow) };
      return;
  }
  throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
export function requestHeaders(headers) {
  const attribution = attributionHeaders();
  const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  };
}
