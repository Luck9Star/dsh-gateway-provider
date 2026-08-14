/**
 * NewapiAdapter: a pi-ai-backed LlmAdapter serving every model advertised by
 * any configured gateway.
 *
 * Each gateway becomes a provider route (`gateway:<id>`, plus the legacy
 * `newapi` route). For each request the adapter:
 *  1. resolves the gateway's connection facts (baseURL, credential, catalog);
 *  2. discovers the gateway's models and builds a pi-ai `Provider` whose
 *     `Model` entries each carry the wire protocol (`api` field) pi-ai should
 *     speak for them (openai-completions / openai-responses / anthropic-messages
 *     / google-generative-ai);
 *  3. converts the harness request into a pi-ai `Context`;
 *  4. streams through pi-ai's protocol layer and translates the pi-ai event
 *     stream back into harness `StreamChunk`s.
 *
 * The wire formats (OpenAI Chat Completions, OpenAI Responses, Anthropic
 * Messages, Google Generative AI) are implemented entirely by the pi-ai SDK;
 * this adapter owns only the gateway→pi-ai mapping and the harness↔pi-ai
 * bridge.
 *
 * @module dsh-newapi-provider/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  contentHasImage,
} from "@deepseek-ai/dsh-llm";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getCatalog, listPickerModels, lookupCatalogEntry, DEFAULT_MAX_TOKENS, DEFAULT_CONTEXT_WINDOW } from "./catalog.js";
import { buildModel, buildProvider, DEFAULT_ENDPOINT_PRIORITY } from "./pi-provider.js";
import { findPiModel, thinkingEffortsOf, effortsFromLevels } from "./thinking.js";
import { toPiContext, toStreamChunks, requestHeaders } from "./pi-bridge.js";

/** Default maximum idle interval while an adapter stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";

/** Detached display metadata for one picker model. */
function modelInfo(provider, entry) {
  return {
    provider,
    id: entry.id,
    name: entry.name ?? entry.id,
    ...entry.description === undefined ? {} : { description: entry.description },
    inputModalities: entry.input ?? ["text"],
  };
}

export class NewapiAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
  }

  providerInfo(provider) {
    return this.config.providerInfo(provider);
  }

  providerRetryPolicy(provider) {
    return this.config.options(provider).retryPolicy;
  }

  async listModels(provider) {
    const connection = this.config.options(provider);
    const apiKey = await this.config.resolveApiKey(connection);
    const entries = await listPickerModels(connection, apiKey);
    return entries.map((entry) => modelInfo(provider, entry));
  }

  async resolveModel(provider, model, signal) {
    const connection = this.config.options(provider);
    let entry;
    try {
      const apiKey = await this.config.resolveApiKey(connection);
      entry = await lookupCatalogEntry(connection, apiKey, model, signal);
    } catch {
      entry = undefined; // catalog failures must not break exact-model resolution
    }
    const configured = entry;
    const override = connection.modelOverrides?.[model];
    // Per-model overrides (context window / output cap) must win over the
    // models.dev-enriched catalog, mirroring buildModel + applyModelConfig. The
    // harness reads this `context.contextWindow` for context management, so a
    // missing override here silently compacts on the wrong window.
    const contextWindow = override?.contextWindow ?? configured?.contextWindow ?? connection.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens = override?.maxTokens ?? configured?.maxTokens ?? connection.maxTokens ?? DEFAULT_MAX_TOKENS;
    // An explicit per-model reasoningLevels override wins over catalog inference.
    const overrideEfforts = effortsFromLevels(override?.reasoningLevels);
    const reasoning = overrideEfforts.length > 0
      ? { efforts: overrideEfforts }
      : thinkingEffortsOf(configured, findPiModel(model), { extended: connection.extendedReasoningLevels });
    return {
      ...configured === undefined ? { provider, id: model, name: model, inputModalities: ["text"] } : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    };
  }

  /**
   * Build (and cache) one pi-ai Provider for a gateway connection.
   * The provider's Model list is the gateway's discovered, enriched catalog;
   * each model's `api` field dispatches pi-ai to the right wire protocol.
   */
  async piProviderOf(connection, apiKey) {
    const cacheKey = connection.baseURL;
    const cached = this.config.providerCache.get(cacheKey);
    if (cached !== undefined && cached.apiKey === apiKey && cached.at > Date.now() - (connection.catalogTtlMs ?? 30 * 60 * 1000)) {
      return cached.provider;
    }
    const entries = await getCatalog(connection, apiKey);
    const priority = connection.endpointPriority ?? DEFAULT_ENDPOINT_PRIORITY;
    // An explicit per-model protocol override pins the endpoint types to that
    // single choice, so pickModelApi can no longer drift with the priority.
    const pinnedTypes = (ov) => Array.isArray(ov?.protocol) ? ov.protocol : (typeof ov?.protocol === "string" && ov.protocol.length > 0 ? [ov.protocol] : undefined);
    const models = entries.map((entry) => {
      const override = connection.modelOverrides?.[entry.id];
      const effective = pinnedTypes(override) !== undefined ? { ...entry, endpointTypes: pinnedTypes(override) } : entry;
      return buildModel(effective, connection.providerId, connection.baseURL, priority, connection, override);
    });
    // Apply user overrides that disable models (hide from the provider).
    const visible = models.filter((m) => connection.modelOverrides?.[m.id]?.disabled !== true);
    // Merge custom models declared in settings but absent from the gateway.
    const present = new Set(visible.map((m) => m.id));
    const custom = Object.entries(connection.modelOverrides ?? {})
      .filter(([id, ov]) => !present.has(id) && ov?.disabled !== true)
      .map(([id, ov]) => buildModel({ id, name: ov.name ?? id, endpointTypes: pinnedTypes(ov) }, connection.providerId, connection.baseURL, priority, connection, ov));
    const provider = buildProvider({
      providerId: connection.providerId,
      displayName: connection.displayName ?? connection.providerId,
      baseURL: connection.baseURL,
      models: [...visible, ...custom],
    });
    this.config.providerCache.set(cacheKey, { provider, apiKey, at: Date.now() });
    return provider;
  }

  async *stream(options) {
    if (options.stop !== undefined) throw new LlmError("newapi adapter does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
    const connection = this.config.options(options.provider);
    const apiKey = await this.config.resolveApiKey(connection);

    const consumer = new AbortController();
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);

    try {
      const provider = await this.piProviderOf(connection, apiKey);
      const models = createModels();
      models.setProvider(provider);
      const model = models.getModel(connection.providerId, options.model);
      if (model === undefined) throw new LlmError(`gateway "${connection.providerId}" has no model "${options.model}"`, "UNKNOWN_MODEL");

      const containsImage = options.messages.some((message) => contentHasImage(message.content));
      if (containsImage && !model.input.includes("image")) throw new LlmError(`gateway model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined;
      if (containsImage && attachments === undefined) throw new LlmError("gateway image input requires the durable attachment service", "UNSUPPORTED_CONTENT");

      const context = attachments === undefined ? toPiContext(options) : await toPiContext(options, attachments);

      const reasoning = options.reasoningEffort === undefined
        ? undefined
        : (getSupportedThinkingLevels(model).some((level) => level === options.reasoningEffort) ? options.reasoningEffort : undefined);

      const piStream = models.streamSimple(model, context, {
        apiKey,
        ...reasoning === undefined ? {} : { reasoning },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        signal: watchdog.signal,
        headers: requestHeaders(connection.headers),
        maxRetries: 0,
      });

      const iterator = toStreamChunks(piStream, model.contextWindow)[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const result = await watchdog.next(iterator);
          if (result.done) { exhausted = true; return; }
          yield result.value;
        }
      } finally {
        if (!exhausted) {
          consumer.abort("gateway stream consumer stopped");
          try { await iterator.return(undefined); } catch { /* aborted */ }
        }
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`gateway stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("gateway request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`gateway API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      consumer.abort("gateway stream consumer stopped");
    }
  }
}
