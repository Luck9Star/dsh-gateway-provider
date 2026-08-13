/**
 * Harness → wire serialization for the three gateway wire formats.
 *
 * Each serializer converts the harness conversation (system text, user text
 * with tool results, assistant text/reasoning/tool calls, tool schemas,
 * sampling options) into the native request body of one endpoint type. The
 * endpoint type was already selected per model by {@link wire.pickEndpoint}.
 *
 * Reasoning-effort wire fields (`thinking` / `reasoning_effort`) are only
 * emitted for DeepSeek-family models: the gateway rejects them for other
 * upstreams (MiniMax accepts only `adaptive`/`disabled` thinking), so
 * non-DeepSeek models keep their provider-native default behavior.
 *
 * @module dsh-newapi-provider/serialize
 */

/** Parse tool-call argument JSON; tolerate model malformations with {}. */
export function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

/** Join the text blocks of a message (user / tool-result content). */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/** Whether the model is a DeepSeek-family model (gateway id or models.dev family). */
export function isDeepseekFamily(entry, model) {
  const family = entry?.family;
  if (typeof family === "string" && family.toLowerCase().startsWith("deepseek")) return true;
  return String(model).toLowerCase().startsWith("deepseek");
}

/** Whether the model is a MiniMax-family model (gateway id or models.dev family). */
export function isMinimaxFamily(entry, model) {
  const family = entry?.family;
  if (typeof family === "string" && family.toLowerCase().startsWith("minimax")) return true;
  return String(model).toLowerCase().startsWith("minimax");
}

/**
 * Resolve the thinking/effort wire fields for a harness reasoning effort.
 *
 * - DeepSeek family: `thinking: {type: enabled|disabled}` + `reasoning_effort`
 *   (off disables thinking, high/max enable it with the effort).
 * - MiniMax family: `thinking: {type: adaptive|disabled}` — MiniMax rejects
 *   `enabled` and has no reasoning_effort field, so off maps to disabled and
 *   high/max map to the native adaptive mode.
 * - Everything else: no wire fields (provider-native default behavior).
 */
function resolveThinking(options, entry, model) {
  const effort = options.reasoningEffort;
  if (effort === undefined) return {};
  if (isDeepseekFamily(entry, model)) {
    if (effort === "off") return { thinking: { type: "disabled" } };
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }
  if (isMinimaxFamily(entry, model)) {
    if (effort === "off") return { thinking: { type: "disabled" } };
    return { thinking: { type: "adaptive" } };
  }
  return {};
}

// ---------------------------------------------------------------------------
// OpenAI chat-completions
// ---------------------------------------------------------------------------

function serializeAssistantOpenAI(message) {
  const text = flattenText(message.content);
  const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
  const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: block.arguments },
  }));
  return {
    role: "assistant",
    content: text,
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  };
}

function serializeMessagesOpenAI(messages) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistantOpenAI(message));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: "user", content: text });
    for (const result of toolResults) wire.push({
      role: "tool",
      tool_call_id: result.toolCallId,
      content: flattenText(result.content) || "(no output)",
    });
  }
  return wire;
}

/**
 * OpenAI-compatible chat-completions request body.
 * Always streaming with usage reporting; optional fields are omitted rather
 * than sent as null so gateway defaults apply.
 */
function serializeOpenAI(options, connection, entry) {
  const messages = [];
  if (options.system !== undefined) messages.push({ role: "system", content: options.system });
  messages.push(...serializeMessagesOpenAI(options.messages));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const thinking = isDeepseekFamily(entry, options.model) || isMinimaxFamily(entry, options.model)
    ? resolveThinking(options, entry, options.model)
    : {};
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...thinking,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function serializeMessagesAnthropic(messages) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") continue; // system rides the top-level field
    if (message.role === "assistant") {
      const content = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool-call") content.push({ type: "tool_use", id: block.id, name: block.name, input: parseArguments(block.arguments) });
        // reasoning blocks have no Anthropic wire equivalent here; dropped.
      }
      if (content.length > 0) wire.push({ role: "assistant", content });
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0) wire.push({ role: "user", content: [{ type: "text", text }] });
    for (const result of toolResults) wire.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)",
        ...result.isError === true ? { is_error: true } : {},
      }],
    });
  }
  return wire;
}

/**
 * Anthropic Messages request body against the gateway's `/v1/messages` route.
 * `max_tokens` is required by the protocol; the catalog output cap is the
 * default when the harness did not set one.
 */
function serializeAnthropic(options, connection, entry) {
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
  const maxTokens = options.maxTokens ?? entry?.maxTokens ?? connection.maxTokens ?? 4096;
  return {
    model: options.model,
    max_tokens: maxTokens,
    ...options.system !== undefined ? { system: options.system } : {},
    messages: serializeMessagesAnthropic(options.messages),
    stream: true,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.stop !== undefined ? { stop_sequences: options.stop } : {},
  };
}

// ---------------------------------------------------------------------------
// Gemini generateContent
// ---------------------------------------------------------------------------

function serializeContentsGemini(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === "system") continue; // rides systemInstruction
    if (message.role === "assistant") {
      const parts = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ text: block.text });
        else if (block.type === "tool-call") parts.push({ functionCall: { name: block.name, args: parseArguments(block.arguments) } });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    const parts = [];
    const text = flattenText(message.content);
    if (text.length > 0) parts.push({ text });
    for (const result of message.content.filter((block) => block.type === "tool-result")) {
      parts.push({
        functionResponse: {
          name: result.toolCallId,
          response: { result: flattenText(result.content) || "(no output)" },
        },
      });
    }
    if (parts.length > 0) contents.push({ role: "user", parts });
  }
  return contents;
}

/**
 * Gemini generateContent request body against the gateway's
 * `:streamGenerateContent?alt=sse` route. Tool results ride as
 * `functionResponse` parts in user messages (Gemini's native tool-result
 * shape); the harness tool_call_id is reused as the function name so results
 * correlate without a wire id round-trip.
 */
function serializeGemini(options, connection, entry) {
  const tools = options.tools?.map((tool) => ({
    functionDeclarations: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
  }));
  const generationConfig = {
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens },
    ...options.stop !== undefined ? { stopSequences: options.stop } : {},
  };
  return {
    contents: serializeContentsGemini(options.messages),
    ...options.system !== undefined ? { systemInstruction: { parts: [{ text: options.system }] } } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...Object.keys(generationConfig).length > 0 ? { generationConfig } : {},
  };
}

/**
 * Serialize one harness request into the gateway wire body for an endpoint.
 * @param endpoint - the wire format selected for this model.
 * @param options - the harness GenerateOptions.
 * @param connection - resolved adapter connection facts.
 * @param entry - the catalog entry for the model (may be undefined).
 * @returns the JSON request body.
 */
export function serializeRequest(endpoint, options, connection, entry) {
  switch (endpoint) {
    case "openai":
      return serializeOpenAI(options, connection, entry);
    case "anthropic":
      return serializeAnthropic(options, connection, entry);
    case "gemini":
      return serializeGemini(options, connection, entry);
    default:
      throw new Error(`llm-newapi: cannot serialize unsupported endpoint type "${endpoint}"`);
  }
}
