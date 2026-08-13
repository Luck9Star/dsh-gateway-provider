/**
 * Wire SSE → harness StreamChunk translation for the three gateway formats.
 *
 * Every translator consumes the SSE `data` payloads produced by
 * {@link sse.parseSse} and emits the harness streaming protocol
 * (`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` /
 * `block-end` / `usage` / `finish`). Terminal conventions differ per format:
 *
 * - OpenAI: `[DONE]` is required; EOF before it is a truncated stream.
 * - Anthropic: `message_stop` terminates; EOF before it is a truncation.
 * - Gemini: EOF is the legal terminal (`streamGenerateContent` has no sentinel).
 *
 * @module dsh-newapi-provider/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from "@deepseek-ai/dsh-llm";

// ---------------------------------------------------------------------------
// shared block machinery
// ---------------------------------------------------------------------------

/** Map a wire finish reason to the harness FinishReason. */
function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return { kind: "stop" };
    case "tool_calls":
    case "tool_use":
      return { kind: "tool-calls" };
    case "length":
    case "max_tokens":
      return { kind: "max-tokens" };
    default:
      return { kind: "error", failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } };
  }
}

function closeBlock(block) {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return { type: "tool-call", id: CallId(block.callId ?? ""), name: block.name ?? "", arguments: block.text };
  }
}

function createBlockState() {
  return {
    nextIndex: 0,
    order: [],
    open(kind) {
      const block = { index: this.nextIndex++, kind, text: "" };
      this.order.push(block);
      return block;
    },
  };
}

function* finishOrEmpty(state, reason) {
  if (reason.kind === "stop" && state.order.length === 0) {
    yield {
      type: "finish",
      reason: {
        kind: "error",
        failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
      },
    };
    return;
  }
  yield { type: "finish", reason };
}

/** Emit block-end for every open block, in opening order. */
function* closeAllBlocks(state) {
  for (const block of state.order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
}

// ---------------------------------------------------------------------------
// OpenAI chat-completions
// ---------------------------------------------------------------------------

/**
 * Translate OpenAI SSE payloads (`[DONE]`-terminated). Mirrors the harness
 * DeepSeek adapter: reasoning deltas open reasoning blocks, content opens
 * text blocks, tool-call deltas keyed by wire index open tool blocks; usage
 * and finish are deferred to `[DONE]`.
 */
export async function* translateOpenAI(payloads) {
  const state = createBlockState();
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  let pendingFinish;
  let pendingUsage;
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      yield* closeAllBlocks(state);
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      yield* finishOrEmpty(state, pendingFinish ?? { kind: "stop" });
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = state.open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = state.open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = state.open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== undefined) block.callId = call.id;
        if (call.function?.name !== undefined) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        };
      }
      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsageOpenAI(chunk.usage);
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

/** Map OpenAI usage into disjoint harness counts (cache reads subtracted). */
function mapUsageOpenAI(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Math.max(0, usage.prompt_tokens - (cacheRead ?? 0)),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

/**
 * Translate Anthropic Messages SSE events. Block indexes come from the wire
 * (`content_block_start`/`content_block_stop`), usage from `message_start`
 * (input) and `message_delta` (output), and the finish from `message_stop`.
 */
export async function* translateAnthropic(payloads) {
  const state = createBlockState();
  const blocks = new Map();
  let pendingFinish;
  let pendingUsage;
  let sawStop = false;
  for await (const payload of payloads) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    switch (event.type) {
      case "message_start": {
        const usage = event.message?.usage;
        if (usage) pendingUsage = mapUsageAnthropicInput(usage);
        break;
      }
      case "content_block_start": {
        const index = event.index;
        const block = event.content_block;
        if (block?.type === "tool_use") {
          const opened = state.open("tool-call");
          opened.callId = block.id;
          opened.name = block.name;
          blocks.set(index, opened);
          yield { type: "block-start", index: opened.index, blockType: "tool-call" };
        } else if (block?.type === "text") {
          const opened = state.open("text");
          blocks.set(index, opened);
          yield { type: "block-start", index: opened.index, blockType: "text" };
        }
        break;
      }
      case "content_block_delta": {
        let block = blocks.get(event.index);
        const delta = event.delta;
        if (delta?.type === "text_delta") {
          if (!block) {
            block = state.open("text");
            blocks.set(event.index, block);
            yield { type: "block-start", index: block.index, blockType: "text" };
          }
          block.text += delta.text ?? "";
          yield { type: "text-delta", index: block.index, text: delta.text ?? "" };
        } else if (delta?.type === "input_json_delta") {
          if (!block) {
            block = state.open("tool-call");
            blocks.set(event.index, block);
            yield { type: "block-start", index: block.index, blockType: "tool-call" };
          }
          const fragment = delta.partial_json ?? "";
          block.text += fragment;
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: CallId(block.callId ?? ""),
            ...block.name !== undefined ? { name: block.name } : {},
            argumentsDelta: fragment,
          };
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(event.index);
        if (block) {
          yield { type: "block-end", index: block.index, block: closeBlock(block) };
          blocks.delete(event.index);
        }
        break;
      }
      case "message_delta": {
        if (typeof event.delta?.stop_reason === "string") pendingFinish = mapFinishReason(event.delta.stop_reason);
        if (event.usage?.output_tokens !== undefined) {
          pendingUsage = { ...pendingUsage, outputTokens: event.usage.output_tokens };
        }
        break;
      }
      case "message_stop": {
        sawStop = true;
        yield* closeAllBlocks(state);
        if (pendingUsage) yield { type: "usage", usage: pendingUsage };
        yield* finishOrEmpty(state, pendingFinish ?? { kind: "stop" });
        return;
      }
      default:
        break; // ping / unknown event types are ignored
    }
  }
  if (!sawStop) throw new LlmError("SSE stream ended without message_stop", "STREAM_CLOSED");
}

function mapUsageAnthropicInput(usage) {
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  return {
    inputTokens: Math.max(0, usage.input_tokens - (cacheRead ?? 0)),
    outputTokens: 0,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {},
  };
}

// ---------------------------------------------------------------------------
// Gemini generateContent
// ---------------------------------------------------------------------------

/** Gemini finish reasons → harness finish. */
function mapGeminiFinish(reason) {
  switch (reason) {
    case "STOP":
      return { kind: "stop" };
    case "MAX_TOKENS":
      return { kind: "max-tokens" };
    default:
      return { kind: "error", failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } };
  }
}

/**
 * Translate Gemini `streamGenerateContent` SSE payloads. Each payload is a
 * partial GenerateContentResponse; the stream ends at EOF (no sentinel).
 * `usageMetadata` on the final chunk carries cumulative totals.
 */
export async function* translateGemini(payloads) {
  const state = createBlockState();
  let textBlock;
  let toolCallCount = 0;
  const toolBlocks = [];
  let pendingFinish;
  let pendingUsage;
  for await (const payload of payloads) {
    let resp;
    try {
      resp = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const candidate of resp.candidates ?? []) {
      if (typeof candidate.finishReason === "string") pendingFinish = mapGeminiFinish(candidate.finishReason);
      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === "string" && part.text.length > 0) {
          if (!textBlock) {
            textBlock = state.open("text");
            yield { type: "block-start", index: textBlock.index, blockType: "text" };
          }
          textBlock.text += part.text;
          yield { type: "text-delta", index: textBlock.index, text: part.text };
        }
        if (part.functionCall !== undefined && part.functionCall !== null) {
          const block = state.open("tool-call");
          block.callId = `gemini-call-${toolCallCount}`;
          block.name = part.functionCall.name;
          const args = part.functionCall.args;
          block.text = typeof args === "string" ? args : JSON.stringify(args ?? {});
          toolBlocks.push(block);
          toolCallCount += 1;
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
      }
    }
    if (resp.usageMetadata) pendingUsage = mapUsageGemini(resp.usageMetadata);
  }
  // EOF is the legal terminal for streamGenerateContent.
  yield* closeAllBlocks(state);
  if (pendingUsage) yield { type: "usage", usage: pendingUsage };
  const reason = toolBlocks.length > 0 ? { kind: "tool-calls" } : pendingFinish ?? { kind: "stop" };
  yield* finishOrEmpty(state, reason);
}

function mapUsageGemini(usage) {
  const cacheRead = usage.cachedContentTokenCount;
  return {
    inputTokens: Math.max(0, usage.promptTokenCount - (cacheRead ?? 0)),
    outputTokens: usage.candidatesTokenCount ?? 0,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
  };
}

// ---------------------------------------------------------------------------

/** Dispatch to the endpoint-specific translator. */
export function translateByEndpoint(endpoint, payloads) {
  switch (endpoint) {
    case "openai":
      return translateOpenAI(payloads);
    case "anthropic":
      return translateAnthropic(payloads);
    case "gemini":
      return translateGemini(payloads);
    default:
      throw new Error(`llm-newapi: cannot translate unsupported endpoint type "${endpoint}"`);
  }
}
