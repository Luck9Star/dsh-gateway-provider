/**
 * Error-code classification regression tests for the pi-ai bridge.
 *
 * The harness retry stack (dsh-llm-retry, default policy) retries exactly:
 *   EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT
 * (dsh-llm/lib/types/retry-policy.js DEFAULT_RETRYABLE_CODES). The bridge's
 * `classifyPiAiError` decides which harness code a failed gateway stream
 * carries, so a coarse fallback there makes gateway blips unretryable.
 * The classifier is lifted from dsh-llm-pi-ai/stream; these tests pin it.
 *
 * Also pins the `mapStopReason` surrounding contract: empty completed
 * responses surface as EMPTY_RESPONSE (retryable), length maps to
 * max-tokens, and overflow messages map to CONTEXT_WINDOW_EXCEEDED.
 *
 * Usage: node test/error-codes.mjs — exit code 0 = all passed.
 */
import { QUOTA_EXCEEDED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { mapStopReason } from "../lib/pi-bridge.js";

let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Drive classifyPiAiError through mapStopReason's error branch. */
function codeOf(message) {
  const reason = mapStopReason({ stopReason: "error", errorMessage: message, model: "m", usage: { input: 1, output: 0 } }, 1_000_000);
  return reason.failure?.code;
}

// --- retryable classes (what dsh-llm-retry's default policy consumes) ---
check("429 → RATE_LIMIT", codeOf("HTTP 429: rate limit exceeded") === "RATE_LIMIT");
check("429 phrase → RATE_LIMIT", codeOf("request rate limited, retry later") === "RATE_LIMIT");
check("5xx → SERVER", codeOf("HTTP 502: bad gateway") === "SERVER");
check("503 → SERVER", codeOf("upstream returned 503 Service Unavailable") === "SERVER");
check("timeout → TIMEOUT", codeOf("request timed out after 30000ms") === "TIMEOUT");
check("timed out (phrase) → TIMEOUT", codeOf("the operation timed out") === "TIMEOUT");
check("network → TRANSPORT", codeOf("fetch failed: network error") === "TRANSPORT");
check("ECONNRESET → TRANSPORT", codeOf("read ECONNRESET") === "TRANSPORT");
check("premature close → TRANSPORT", codeOf("stream terminated: premature close") === "TRANSPORT");
check("stream ended without terminal event → TRANSPORT", codeOf("stream ended without done or error event") === "TRANSPORT");

// --- non-retryable / routed classes ---
check("401 → AUTH", codeOf("HTTP 401: invalid api key") === "AUTH");
check("403 → AUTH", codeOf("HTTP 403: forbidden") === "AUTH");
check("400 → INVALID_REQUEST", codeOf("HTTP 400: invalid request body") === "INVALID_REQUEST");
check("unknown text → PI_AI_ERROR (not a generic code)", codeOf("something odd happened") === "PI_AI_ERROR");

// --- quota: isQuotaExceededError path, asserted against the real constant ---
check("quota text → QUOTA_EXCEEDED", codeOf("quota exceeded for this key") === QUOTA_EXCEEDED_CODE,
  `code=${codeOf("quota exceeded for this key")}, constant=${QUOTA_EXCEEDED_CODE}`);

// --- mapStopReason surrounding contract ---
const emptyStop = mapStopReason({ stopReason: "stop", content: [], model: "m", usage: { input: 1, output: 0 } }, 1_000_000);
check("empty stop → EMPTY_RESPONSE (retryable)",
  emptyStop.kind === "error" && emptyStop.failure.code === "EMPTY_RESPONSE",
  JSON.stringify(emptyStop));

const overflow = mapStopReason({ stopReason: "error", errorMessage: "context window exceeded", model: "m", usage: { input: 1, output: 0 } }, 1_000_000);
check("overflow message → CONTEXT_WINDOW_EXCEEDED", overflow.kind === "error" && overflow.failure.code === CONTEXT_WINDOW_EXCEEDED_CODE,
  `code=${overflow.failure?.code}, constant=${CONTEXT_WINDOW_EXCEEDED_CODE}`);

const length = mapStopReason({ stopReason: "length", model: "m", usage: { input: 1, output: 5 } }, 1_000_000);
check("length → max-tokens", length.kind === "max-tokens");

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
