/**
 * NewapiAdapter: one LlmAdapter instance serving every model the gateway
 * advertises under the `newapi` provider route.
 *
 * The adapter is transport-only in the same sense as the DeepSeek adapter:
 * connection facts arrive through a thunk resolved once per operation, the
 * bearer token through a per-request resolver, and the per-model catalog
 * (gateway list + models.dev parameters) through a TTL cache. Each request
 * picks the model's wire format from its advertised `supported_endpoint_types`
 * and assembles the matching gateway URL.
 *
 * @module dsh-newapi-provider/adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { listPickerModels, lookupCatalogEntry } from "./catalog.js";
import { findPiModel, thinkingEffortsOf } from "./thinking.js";
import { serializeRequest } from "./serialize.js";
import { parseSse } from "./sse.js";
import { translateByEndpoint } from "./translate.js";
import { endpointUrl, normalizeBaseURL, pickEndpoint, providerErrorMessage } from "./wire.js";

/** Default maximum idle interval while an adapter stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";

/** Detached display metadata for one picker model. */
function modelInfo(provider, entry) {
  return {
    provider,
    id: entry.id,
    name: entry.name ?? entry.id,
    ...entry.description === undefined ? {} : { description: entry.description },
    inputModalities: ["text"],
  };
}

/** Map an HTTP status + provider error body to a stable LlmError code. */
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/** Honor a provider `retry-after` header. */
function providerRetryAfterMs(value) {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers) {
  const value = headers.get("x-request-id") ?? headers.get("x-newapi-request-id");
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

export class NewapiAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: "NewAPI" };
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }

  async listModels(provider) {
    const connection = this.config.options();
    const apiKey = await this.config.resolveApiKey(connection);
    const entries = await listPickerModels(connection, apiKey);
    return entries.map((entry) => modelInfo(provider, entry));
  }

  async resolveModel(provider, model, signal) {
    const connection = this.config.options();
    let entry;
    try {
      const apiKey = await this.config.resolveApiKey(connection);
      entry = await lookupCatalogEntry(connection, apiKey, model, signal);
    } catch {
      entry = undefined; // catalog failures must not break exact-model resolution
    }
    const configured = entry;
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
    const reasoning = thinkingEffortsOf(configured, findPiModel(model));
    return {
      ...configured === undefined ? { provider, id: model, name: model, inputModalities: ["text"] } : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    };
  }

  async *stream(options) {
    const connection = this.config.options();
    const apiKey = await this.config.resolveApiKey(connection);
    const consumer = new AbortController();
    const watchdog = idleWatchdog(
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]),
      connection.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    );
    const iterator = this.request(options, watchdog.signal, connection, apiKey, () => {
      watchdog.pulse();
    })[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`newapi stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("newapi request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`newapi API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      consumer.abort("newapi stream consumer stopped");
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return();
        } catch {
          /* aborted transport teardown */
        }
      }
    }
  }

  async *request(options, signal, connection, apiKey, onComment) {
    const entry = await lookupCatalogEntry(connection, apiKey, options.model, signal);
    const endpoint = pickEndpoint(entry, connection.endpointPriority);
    if (endpoint === undefined) {
      const advertised = entry?.endpointTypes?.join(", ") ?? "unknown";
      throw new LlmError(
        `model "${options.model}" advertises no supported request format (${advertised}); adapter implements ${"openai, anthropic, gemini"}`,
        "UNSUPPORTED_ENDPOINT",
      );
    }
    const url = endpointUrl(connection.baseURL, endpoint, options.model);
    const body = JSON.stringify(serializeRequest(endpoint, options, connection, entry));
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...attributionHeaders(),
      ...endpoint === "anthropic" ? { "anthropic-version": "2023-06-01" } : {},
      ...options.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {},
    };
    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`newapi API request to ${url} failed`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let message = `newapi API error (HTTP ${response.status})`;
      let providerError;
      try {
        const parsed = await response.json();
        providerError = parsed?.error ?? parsed;
        const extracted = providerErrorMessage(parsed);
        if (extracted !== undefined) message = extracted;
      } catch {}
      const delay = providerRetryAfterMs(response.headers.get("retry-after"));
      const id = requestId(response.headers);
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      });
    }
    if (!response.body) throw new LlmError("newapi API returned no response body", "EMPTY_RESPONSE");
    yield* translateByEndpoint(endpoint, parseSse(response.body, onComment));
  }
}
