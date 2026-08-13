/**
 * Zero-dependency SSE (Server-Sent Events) parser for adapter streams.
 *
 * Parses a WHATWG ReadableStream of bytes into event `data` payloads. Handles
 * CRLF / LF line endings, multi-line `data:` fields (joined with "\n"),
 * comment lines, and payloads split across arbitrary byte boundaries
 * (including mid-UTF-8 sequences). The parser is transport-only: it does not
 * interpret the payloads.
 *
 * @module dsh-newapi-provider/sse
 */

/** Split one raw event block (terminated by a blank line) into its `data` payload. */
function eventData(raw) {
  const lines = raw.split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue; // blank / comment
    if (!line.startsWith("data:")) continue; // ignore event:/id:/retry: fields
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.join("\n");
}

/**
 * Yield every SSE `data` payload from an HTTP response body stream.
 *
 * @param stream - the response body (`response.body`), an async-iterable of Uint8Array chunks.
 * @returns each event payload in arrival order. The stream ends naturally at EOF;
 *   callers (translators) decide whether EOF is a legal terminal (Gemini) or a truncation (OpenAI).
 */
export async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      // An event ends at the first blank line (\n\n or \r\n\r\n).
      const end = findEventEnd(buffer);
      if (end === -1) break;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const payload = eventData(raw);
      if (payload.length > 0) yield payload;
    }
  }
  // Flush any trailing bytes and a final unterminated event (streams are not
  // required to close with a blank line).
  buffer += decoder.decode();
  const payload = eventData(buffer);
  if (payload.length > 0) yield payload;
}

/** Locate the end of the first complete SSE event, or -1. */
function findEventEnd(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4;
  if (crlf === -1) return lf + 2;
  return Math.min(lf + 2, crlf + 4);
}
