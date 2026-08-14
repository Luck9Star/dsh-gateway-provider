/**
 * Standalone smoke test for the NewAPI provider adapter.
 *
 * Drives the REAL adapter code (catalog discovery → models.dev enrichment →
 * pi-ai Provider construction → pi-ai protocol dispatch → StreamChunk
 * translation) against the live gateway configured in:
 *   1. $NEWAPI_API_KEY / $NEWAPI_BASE_URL environment variables, else
 *   2. ../dsh-newapi/.env (API_KEY / API_URL / NEWAPI_ACCESS_TOKEN) — the
 *      local newapi skill checkout.
 *
 * Usage: node test/smoke.mjs [--only <name>]
 * Exit code 0 = all tests passed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NewapiAdapter } from "../lib/adapter.js";
import { resolveGateways } from "../index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");

function loadEnv() {
  const env = { ...process.env };
  const candidates = [
    path.join(PACKAGE_ROOT, ".env"),
    process.env.NEWAPI_ENV_FILE,
    path.join(process.env.HOME ?? "", "Documents", "dev", "Agents", "dsh-newapi", ".env"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("=") || line.trim().startsWith("#")) continue;
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      if (env[key] === undefined) env[key] = line.slice(i + 1).trim();
    }
  }
  return env;
}

const env = loadEnv();
const BASE_URL = env.NEWAPI_BASE_URL || env.NEWAPI_API_URL || env.API_URL;
const API_KEY = env.NEWAPI_API_KEY || env.API_KEY || env.NEWAPI_ACCESS_TOKEN;
if (!BASE_URL || !API_KEY) {
  console.error("missing gateway env: need NEWAPI_BASE_URL (or API_URL) and NEWAPI_API_KEY (or API_KEY)");
  process.exit(2);
}

function makeAdapter(overrides = {}) {
  const baseOptions = () => ({
    providerId: "newapi",
    displayName: "NewAPI",
    apiKeyEnv: "NEWAPI_API_KEY",
    baseURL: BASE_URL.replace(/\/+$/, ""),
    flavor: "newapi",
    modelsUrl: env.NEWAPI_MODELS_URL ?? "https://models.dev/models.json",
    useModelsDev: true,
    extendedReasoningLevels: false,
    sortModelsByRelease: true,
    catalogMode: "auto",
    catalogTtlMs: 30 * 60 * 1000,
    includeChatOnly: true,
    excludePatterns: [
      "(^|/|-)image", "(^|/|-)speech", "(^|/|-)audio", "(^|/|-)video",
      "(^|/|-)embed", "(^|/|-)rerank", "(^|/)bge-", "(^|/)text-embedding",
      "(^|/|-)moderation", "(^|/|-)tts", "(^|/|-)stt", "(^|/|-)whisper",
    ],
    endpointPriority: ["openai-response", "anthropic", "openai", "gemini"],
    userId: "1",
    modelOverrides: {},
    headers: {},
    maxTokens: 32768,
    defaultContextWindow: 128000,
    streamIdleTimeoutMs: 300_000,
    retryPolicy: { mode: "normal", maxRetries: 0, retryableCodes: ["RATE_LIMIT"], backoff: { initialDelayMs: 500, maxDelayMs: 2000, jitterRatio: 0.1 } },
    ...overrides,
  });
  // The adapter resolves one connection per provider route; the test gateway
  // is the default `newapi` route, so every route shares the same connection.
  const options = (_provider) => baseOptions();
  const providerInfo = (provider) => ({ id: provider, name: "NewAPI" });
  const resolveApiKey = async () => API_KEY;
  return new NewapiAdapter({ options, resolveApiKey, providerInfo, providerCache: new Map(), resolveAttachments: () => undefined });
}

const PROVIDER = "newapi";
let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function collectStream(adapter, request) {
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: PROVIDER, model: request.model, messages: request.messages, ...request })) {
    chunks.push(chunk);
  }
  return chunks;
}

function summarize(chunks) {
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  const reasoning = chunks.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
  const tools = chunks.filter((c) => c.type === "tool-call-delta").map((c) => c).reduce((acc, c) => {
    const last = acc[acc.length - 1];
    if (last && last.index === c.index) last.argumentsDelta += c.argumentsDelta;
    else acc.push({ index: c.index, name: c.name, argumentsDelta: c.argumentsDelta });
    return acc;
  }, []);
  const finish = chunks.filter((c) => c.type === "finish").map((c) => c.reason).pop();
  const usage = chunks.filter((c) => c.type === "usage").map((c) => c.usage).pop();
  return { text, reasoning, tools, finish, usage };
}

async function testCatalog() {
  console.log("\n--- catalog discovery + models.dev enrichment ---");
  const adapter = makeAdapter();
  const models = await adapter.listModels(PROVIDER);
  check("model list auto-fetched from gateway", Array.isArray(models) && models.length > 0, `${models.length} models`);
  const ids = models.map((m) => m.id);
  check("deepseek-v4-flash discovered", ids.includes("deepseek-v4-flash"));
  check("MiniMax-M3 discovered", ids.includes("MiniMax-M3"));
  check("image/speech/embedding models excluded from picker", !ids.some((id) => /image|speech|bge|embedding|rerank/i.test(id)),
    `sample remaining: ${ids.slice(0, 8).join(", ")}`);
  const mm3 = models.find((m) => m.id === "MiniMax-M3");
  check("MiniMax-M3 carries models.dev name/description", mm3?.name?.includes("MiniMax"), JSON.stringify(mm3?.name));
  const resolved = await adapter.resolveModel(PROVIDER, "deepseek-v4-flash");
  check("deepseek-v4-flash contextWindow from models.dev", resolved.context?.contextWindow === 1_000_000, `context=${resolved.context?.contextWindow}`);
  check("deepseek-v4-flash maxTokens from models.dev", resolved.defaultMaxTokens === 384_000, `maxTokens=${resolved.defaultMaxTokens}`);
  check("deepseek-v4-flash exposes reasoning efforts", resolved.reasoning?.efforts?.length === 3, JSON.stringify(resolved.reasoning?.efforts?.map((e) => e.id)));
  const mm3Resolved = await adapter.resolveModel(PROVIDER, "MiniMax-M3");
  check("MiniMax-M3 contextWindow from models.dev", mm3Resolved.context?.contextWindow === 512_000, `context=${mm3Resolved.context?.contextWindow}`);
  check("MiniMax-M3 maxTokens from models.dev", mm3Resolved.defaultMaxTokens === 128_000, `maxTokens=${mm3Resolved.defaultMaxTokens}`);
  check("MiniMax-M3 exposes two-state reasoning efforts", mm3Resolved.reasoning?.efforts?.length === 2, JSON.stringify(mm3Resolved.reasoning?.efforts?.map((e) => e.id)));
  check("claude model gets reasoning efforts from pi-ai", JSON.stringify((await adapter.resolveModel(PROVIDER, "claude-opus-4-8")).reasoning?.efforts?.map((e) => e.id)) === JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"]));
  check("glm-5.2-highspeed normalizes to glm-5.2 and inherits its levels", JSON.stringify((await adapter.resolveModel(PROVIDER, "glm-5.2-highspeed")).reasoning?.efforts?.map((e) => e.id)) === JSON.stringify(["off", "low", "medium", "high", "max"]));
  check("embedding-ish unknown model keeps provider-native reasoning", (await adapter.resolveModel(PROVIDER, "some-unknown-model-xyz")).reasoning === undefined);
  const unknown = await adapter.resolveModel(PROVIDER, "not-a-real-model-xyz");
  check("unlisted model resolves with configured defaults", unknown.context?.contextWindow === 128000, `context=${unknown.context?.contextWindow}`);
  // Regression: a per-model contextWindow/maxTokens override must reach
  // resolveModel — the harness reads resolveModel.context.contextWindow for
  // context compaction, so a missing override silently compacts on the wrong
  // window (reported for glm-5.3 configured with contextWindow 1000000).
  const overridden = makeAdapter({ modelOverrides: { "glm-5.3": { contextWindow: 1_000_000, maxTokens: 131_072 } } });
  const glmResolved = await overridden.resolveModel(PROVIDER, "glm-5.3");
  check("glm-5.3 contextWindow override reaches resolveModel", glmResolved.context?.contextWindow === 1_000_000, `context=${glmResolved.context?.contextWindow}`);
  check("glm-5.3 maxTokens override reaches resolveModel", glmResolved.defaultMaxTokens === 131_072, `maxTokens=${glmResolved.defaultMaxTokens}`);
}

async function testOpenAIChat(model, label) {
  console.log(`\n--- openai wire: ${label} (${model}) ---`);
  const adapter = makeAdapter();
  const chunks = await collectStream(adapter, {
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: GATEWAY OK" }] }],
    maxTokens: 128,
  });
  const s = summarize(chunks);
  check(`${label}: text produced`, s.text.includes("GATEWAY OK"), JSON.stringify(s.text.slice(0, 60)));
  check(`${label}: finish stop`, s.finish?.kind === "stop", JSON.stringify(s.finish));
  check(`${label}: usage reported`, s.usage?.inputTokens !== undefined && s.usage?.outputTokens !== undefined, JSON.stringify(s.usage));
  return s;
}

async function testToolCall() {
  console.log("\n--- openai wire: tool calling (deepseek-v4-flash) ---");
  const adapter = makeAdapter();
  const chunks = await collectStream(adapter, {
    model: "deepseek-v4-flash",
    messages: [
      { role: "user", content: [{ type: "text", text: "What is the weather in Beijing? Use the get_weather tool." }] },
    ],
    tools: [{
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }],
    maxTokens: 256,
  });
  const s = summarize(chunks);
  check("tool call requested", s.tools.length > 0, JSON.stringify(s.tools));
  check("tool finish reason", s.finish?.kind === "tool-calls", JSON.stringify(s.finish));
  if (s.tools.length > 0) {
    const args = JSON.parse(s.tools[0].argumentsDelta || "{}");
    check("tool arguments parse as JSON", typeof args.city === "string" && args.city.length > 0, JSON.stringify(args));
    // Round trip: feed the tool result back and expect a final text answer.
    const chunks2 = await collectStream(adapter, {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: [{ type: "text", text: "What is the weather in Beijing? Use the get_weather tool." }] },
        {
          role: "assistant",
          source: { kind: "model", provider: PROVIDER, model: "deepseek-v4-flash" },
          content: [{
            type: "tool-call",
            id: s.tools[0].index === undefined ? "call_1" : `call_${s.tools[0].index}`,
            name: s.tools[0].name,
            arguments: s.tools[0].argumentsDelta,
          }],
        },
        { role: "user", content: [{ type: "tool-result", toolCallId: `call_${s.tools[0].index}`, content: [{ type: "text", text: '{"city":"Beijing","weather":"sunny, 28C"}' }] }] },
      ],
      maxTokens: 256,
    });
    const s2 = summarize(chunks2);
    check("tool result round trip answers", s2.text.length > 0, JSON.stringify(s2.text.slice(0, 80)));
  }
}

async function testAnthropicWire() {
  console.log("\n--- anthropic protocol: MiniMax-M3 via /v1/messages ---");
  const adapter = makeAdapter();
  const chunks = await collectStream(adapter, {
    model: "MiniMax-M3",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ANTHROPIC OK" }] }],
    maxTokens: 128,
  });
  const s = summarize(chunks);
  check("anthropic text produced", s.text.length > 0, JSON.stringify(s.text.slice(0, 60)));
  check("anthropic finish stop", s.finish?.kind === "stop", JSON.stringify(s.finish));
  check("anthropic usage", s.usage?.inputTokens !== undefined && s.usage?.outputTokens !== undefined, JSON.stringify(s.usage));
}

async function testGeminiWire() {
  console.log("\n--- gemini model via openai-completions (gemini-2.5-flash) ---");
  // The google-generative-ai protocol has known SSE compatibility issues with
  // some newapi gateways; verify the model is reachable through its openai
  // endpoint instead (endpointPriority forced to openai).
  const adapter = makeAdapter({ endpointPriority: ["openai"] });
  const chunks = await collectStream(adapter, {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: GEMINI OK" }] }],
    maxTokens: 128,
  });
  const s = summarize(chunks);
  check("gemini text produced", s.text.includes("GEMINI OK"), JSON.stringify(s.text.slice(0, 60)));
  check("gemini finish stop", s.finish?.kind === "stop", JSON.stringify(s.finish));
  check("gemini usage", s.usage?.inputTokens !== undefined, JSON.stringify(s.usage));
}

async function testMiniMaxReasoning() {
  console.log("\n--- MiniMax reasoning-effort (anthropic protocol, reasoning blocks) ---");
  const adapter = makeAdapter();
  // off → reasoning disabled: no reasoning-delta chunks.
  const off = await collectStream(adapter, {
    model: "MiniMax-M3",
    reasoningEffort: "off",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: NO THINK" }] }],
    maxTokens: 64,
  });
  const offSummary = summarize(off);
  check("MiniMax off: no reasoning blocks", offSummary.reasoning.length === 0, JSON.stringify(offSummary.reasoning.slice(0, 40)));
  check("MiniMax off: text produced", offSummary.text.length > 0, JSON.stringify(offSummary.text.slice(0, 40)));
  // high → reasoning enabled: reasoning-delta chunks present (pi-ai surfaces
  // thinking as a reasoning block, not a <think> tag, under anthropic-messages).
  const high = await collectStream(adapter, {
    model: "MiniMax-M3",
    reasoningEffort: "high",
    messages: [{ role: "user", content: [{ type: "text", text: "What is 15+27? Think step by step." }] }],
    maxTokens: 256,
  });
  const highSummary = summarize(high);
  check("MiniMax high: reasoning blocks present", highSummary.reasoning.length > 0, `${highSummary.reasoning.length} chars of reasoning`);
  check("MiniMax high: text produced", highSummary.text.length > 0, JSON.stringify(highSummary.text.slice(0, 40)));
}

async function testCustomURLs() {
  console.log("\n--- custom template: full endpoint URLs (openai + anthropic) ---");
  // Build the connection through the real resolveGateways path: the gateway
  // carries NO baseURL, only fully-qualified endpoint URLs, exactly as the
  // settings UI's "Fully custom" template writes them.
  const base = BASE_URL.replace(/\/+$/, "");
  const config = {
    gateways: [{
      id: "cu", flavor: "custom",
      openaiURL: `${base}/v1/chat/completions`,
      anthropicURL: `${base}/v1/messages`,
    }],
  };
  const gws = resolveGateways(config, { get: () => undefined });
  const conn = gws.find((g) => g.provider === "gateway:cu").connection;
  check("custom connection derived protocol bases",
    conn.apiBases?.["openai-completions"] === `${base}/v1` && conn.apiBases?.["anthropic-messages"] === base,
    JSON.stringify(conn.apiBases));
  check("custom connection derives the discovery base", conn.catalogBase === base, `catalogBase=${conn.catalogBase}`);
  check("custom availability is exactly the configured set", JSON.stringify(conn.availableTypes) === JSON.stringify(["openai", "anthropic"]), JSON.stringify(conn.availableTypes));

  const options = (_provider) => conn;
  const providerInfo = (provider) => ({ id: provider, name: "Custom URLs" });
  const adapter = new NewapiAdapter({ options, resolveApiKey: async () => API_KEY, providerInfo, providerCache: new Map(), resolveAttachments: () => undefined });
  const models = await adapter.listModels("gateway:cu");
  check("discovery works through the URL-derived base", models.length > 0, `${models.length} models`);

  const openai = await collectStream(adapter, {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: CUSTOM OK" }] }],
    maxTokens: 128,
  });
  const so = summarize(openai);
  check("custom openai URL streams chat completions", so.text.includes("CUSTOM OK"), JSON.stringify(so.text.slice(0, 60)));
  check("custom openai finish stop", so.finish?.kind === "stop", JSON.stringify(so.finish));

  // Anthropic wire through the full /v1/messages URL; the model is pinned to
  // anthropic so the priority cannot route it elsewhere.
  const anAdapter = new NewapiAdapter({
    options: () => ({ ...conn, modelOverrides: { "MiniMax-M3": { protocol: "anthropic" } } }),
    resolveApiKey: async () => API_KEY, providerInfo, providerCache: new Map(), resolveAttachments: () => undefined,
  });
  const anthropic = await collectStream(anAdapter, {
    model: "MiniMax-M3",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: CUSTOM ANTHROPIC OK" }] }],
    maxTokens: 128,
  });
  const sa = summarize(anthropic);
  check("custom anthropic URL streams messages", sa.text.length > 0, JSON.stringify(sa.text.slice(0, 60)));
  check("custom anthropic usage", sa.usage?.inputTokens !== undefined, JSON.stringify(sa.usage));
}

async function main() {
  const only = process.argv.findIndex((a) => a === "--only");
  const onlyName = only !== -1 ? process.argv[only + 1] : undefined;
  const tests = {
    catalog: testCatalog,
    "openai-deepseek": () => testOpenAIChat("deepseek-v4-flash", "deepseek-v4-flash"),
    "openai-minimax": () => testOpenAIChat("MiniMax-M3", "MiniMax-M3"),
    "minimax-reasoning": testMiniMaxReasoning,
    tools: testToolCall,
    anthropic: testAnthropicWire,
    gemini: testGeminiWire,
    "custom-urls": testCustomURLs,
  };
  for (const [name, fn] of Object.entries(tests)) {
    if (onlyName && name !== onlyName) continue;
    try {
      await fn();
    } catch (error) {
      failures += 1;
      console.log(`[FAIL] ${name} threw: ${error?.message ?? error}`);
      if (error?.stack) console.log(error.stack.split("\n").slice(0, 4).join("\n"));
    }
  }
  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
