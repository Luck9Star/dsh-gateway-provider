/**
 * Unit tests for the custom-template protocol URL derivation and the
 * gateway resolution that consumes it (no network, no pi-ai calls).
 *
 * Usage: node test/protocol-urls.mjs
 */
import { deriveProtocolURLs, effectiveEndpointTypes, DEFAULT_ENDPOINT_PRIORITY } from "../lib/protocols.js";
import { sdkBaseURL, buildModel } from "../lib/pi-provider.js";
import { resolveGateways } from "../index.js";
import { discoverGatewayModels } from "../lib/catalog.js";
import http from "node:http";

let failed = false;
const check = (label, actual, expected) => {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) console.log(`[PASS] ${label}`);
	else { failed = true; console.error(`[FAIL] ${label}\n  got:  ${a}\n  want: ${e}`); }
};

// ---- deriveProtocolURLs: full endpoint URLs ----
check("full openai URL → SDK base + bare catalog base",
	deriveProtocolURLs({ openaiURL: "https://x.com/v1/chat/completions" }),
	{ apiBases: { "openai-completions": "https://x.com/v1" }, availableTypes: ["openai"], catalogBase: "https://x.com" });

check("full responses URL with deep path",
	deriveProtocolURLs({ responsesURL: "https://r.io/api/v1/responses" }),
	{ apiBases: { "openai-responses": "https://r.io/api/v1" }, availableTypes: ["openai-response"], catalogBase: "https://r.io/api" });

check("full anthropic URL strips /v1/messages",
	deriveProtocolURLs({ anthropicURL: "https://a.io/anthropic/v1/messages" }),
	{ apiBases: { "anthropic-messages": "https://a.io/anthropic" }, availableTypes: ["anthropic"], catalogBase: null });

// ---- issue #4: geminiURL derivation (pi-ai expects /v1beta in the base) ----
check("gemini bare host gets /v1beta",
	deriveProtocolURLs({ geminiURL: "https://g.io" }),
	{ apiBases: { "google-generative-ai": "https://g.io/v1beta" }, availableTypes: ["gemini"], catalogBase: null });
check("gemini base already ending in /v1beta kept",
	deriveProtocolURLs({ geminiURL: "https://g.io/v1beta" }).apiBases,
	{ "google-generative-ai": "https://g.io/v1beta" });
check("gemini base with trailing /models stripped",
	deriveProtocolURLs({ geminiURL: "https://g.io/v1beta/models" }).apiBases,
	{ "google-generative-ai": "https://g.io/v1beta" });
check("gemini trailing slash tolerated",
	deriveProtocolURLs({ geminiURL: "https://g.io/" }).apiBases,
	{ "google-generative-ai": "https://g.io/v1beta" });
check("gemini /V1beta case-insensitive, no double append",
	deriveProtocolURLs({ geminiURL: "https://g.io/V1beta" }).apiBases,
	{ "google-generative-ai": "https://g.io/V1beta" });
check("openai + gemini URLs share the discovery base",
	deriveProtocolURLs({ openaiURL: "https://m.io/v1/chat/completions", geminiURL: "https://m.io" }),
	{
		apiBases: { "openai-completions": "https://m.io/v1", "google-generative-ai": "https://m.io/v1beta" },
		availableTypes: ["openai", "gemini"],
		catalogBase: "https://m.io",
	});

// ---- tolerant input styles ----
check("openai URL without version gets /v1",
	deriveProtocolURLs({ openaiURL: "https://x.com/chat/completions" }).apiBases,
	{ "openai-completions": "https://x.com/v1" });
check("openai SDK base accepted as-is",
	deriveProtocolURLs({ openaiURL: "https://x.com/custom/v1" }).apiBases,
	{ "openai-completions": "https://x.com/custom/v1" });
check("bare anthropic host accepted",
	deriveProtocolURLs({ anthropicURL: "https://a.io" }).apiBases,
	{ "anthropic-messages": "https://a.io" });
check("anthropic base ending in /v1 stripped",
	deriveProtocolURLs({ anthropicURL: "https://a.io/v1" }).apiBases,
	{ "anthropic-messages": "https://a.io" });
check("trailing slashes tolerated",
	deriveProtocolURLs({ openaiURL: "https://x.com/v1/chat/completions/" }).apiBases,
	{ "openai-completions": "https://x.com/v1" });
check("all empty → undefined",
	deriveProtocolURLs({ openaiURL: "", responsesURL: "", anthropicURL: "", geminiURL: "" }),
	undefined);
check("no fields → undefined", deriveProtocolURLs({}), undefined);
check("null → undefined", deriveProtocolURLs(null), undefined);

// openai URL wins the catalog base over responses
check("catalog base prefers the openai URL",
	deriveProtocolURLs({ openaiURL: "https://o.io/v1/chat/completions", responsesURL: "https://r.io/v1/responses" }).catalogBase,
	"https://o.io");

// ---- effectiveEndpointTypes ----
check("no availability → types unchanged",
	effectiveEndpointTypes(["openai", "gemini"], undefined), ["openai", "gemini"]);
check("no advertised types → available set",
	effectiveEndpointTypes(undefined, ["anthropic"]), ["anthropic"]);
check("intersection kept",
	effectiveEndpointTypes(["openai", "anthropic"], ["anthropic"]), ["anthropic"]);
check("nothing servable → null",
	effectiveEndpointTypes(["openai", "gemini"], ["anthropic"]), null);
check("gemini servable once geminiURL is configured (issue #4)",
	effectiveEndpointTypes(["gemini"], ["openai", "gemini"]), ["gemini"]);

// ---- sdkBaseURL: per-API version segments (issue #4) ----
check("sdkBaseURL: gemini bare host gets /v1beta",
	sdkBaseURL("https://gw.io", "google-generative-ai"), "https://gw.io/v1beta");
check("sdkBaseURL: gemini base already in /v1beta kept",
	sdkBaseURL("https://gw.io/v1beta", "google-generative-ai"), "https://gw.io/v1beta");
check("sdkBaseURL: trailing slash trimmed before the check",
	sdkBaseURL("https://gw.io/", "google-generative-ai"), "https://gw.io/v1beta");
check("sdkBaseURL: /V1BETA kept, not doubled",
	sdkBaseURL("https://gw.io/V1BETA", "google-generative-ai"), "https://gw.io/V1BETA");
check("sdkBaseURL: openai still gets /v1",
	sdkBaseURL("https://gw.io", "openai-completions"), "https://gw.io/v1");
check("sdkBaseURL: openai base already in /v1 kept",
	sdkBaseURL("https://gw.io/v1", "openai-responses"), "https://gw.io/v1");
check("sdkBaseURL: anthropic bare host unchanged",
	sdkBaseURL("https://gw.io", "anthropic-messages"), "https://gw.io");

// ---- buildModel: the model's baseUrl follows the pi-ai convention ----
const geminiEntry = { id: "gemini-4-argon", endpointTypes: ["gemini"] };
check("buildModel: gemini over a bare gateway base → /v1beta (issue #4)",
	buildModel(geminiEntry, "gateway:gw", "https://gw.example.com", DEFAULT_ENDPOINT_PRIORITY, undefined, undefined).baseUrl,
	"https://gw.example.com/v1beta");
check("buildModel: gemini over a /v1beta base kept",
	buildModel(geminiEntry, "gateway:gw", "https://gw.example.com/v1beta", DEFAULT_ENDPOINT_PRIORITY, undefined, undefined).baseUrl,
	"https://gw.example.com/v1beta");
check("buildModel: configured gemini apiBase wins over baseURL",
	buildModel(geminiEntry, "gateway:gw", "https://other.io", DEFAULT_ENDPOINT_PRIORITY, { apiBases: { "google-generative-ai": "https://g.io/v1beta" } }, undefined).baseUrl,
	"https://g.io/v1beta");
check("buildModel: openai over a bare gateway base → /v1",
	buildModel({ id: "gpt-x", endpointTypes: ["openai"] }, "gateway:gw", "https://gw.example.com", DEFAULT_ENDPOINT_PRIORITY, undefined, undefined).baseUrl,
	"https://gw.example.com/v1");

// ---- resolveGateways integration ----
const routes = (config) => resolveGateways(config, undefined).map((g) => g.provider);
const byRoute = (config, provider) => resolveGateways(config, undefined).find((g) => g.provider === provider);

check("custom gateway resolves without baseURL",
	routes({ gateways: [{ id: "edge", flavor: "custom", openaiURL: "https://e.io/v1/chat/completions", anthropicURL: "https://e.io/anthropic/v1/messages" }] }),
	["newapi", "gateway:edge"]);

const edge = byRoute(
	{ gateways: [{ id: "edge", flavor: "custom", openaiURL: "https://e.io/v1/chat/completions", anthropicURL: "https://e.io/anthropic/v1/messages" }] },
	"gateway:edge");
check("custom gateway connection facts",
	{ baseURL: edge.connection.baseURL, catalogBase: edge.connection.catalogBase, availableTypes: edge.connection.availableTypes, apiBases: edge.connection.apiBases },
	{
		baseURL: "",
		catalogBase: "https://e.io",
		availableTypes: ["openai", "anthropic"],
		apiBases: { "openai-completions": "https://e.io/v1", "anthropic-messages": "https://e.io/anthropic" },
	});

check("anthropic-only gateway has no discovery base",
	byRoute({ gateways: [{ id: "only-an", flavor: "custom", anthropicURL: "https://a.io/v1/messages" }] }, "gateway:only-an").connection.catalogBase,
	null);

// ---- issue #4: gemini becomes a first-class protocol-URL citizen ----
check("gemini-only custom gateway: no discovery base, gemini available",
	(() => {
		const c = byRoute({ gateways: [{ id: "only-gm", flavor: "custom", geminiURL: "https://g.io" }] }, "gateway:only-gm").connection;
		return { catalogBase: c.catalogBase, availableTypes: c.availableTypes, apiBases: c.apiBases };
	})(),
	{ catalogBase: null, availableTypes: ["gemini"], apiBases: { "google-generative-ai": "https://g.io/v1beta" } });

check("openai + gemini custom gateway: discovery from the openai URL (issue #4 workaround)",
	(() => {
		const c = byRoute({ gateways: [{ id: "mixed", flavor: "custom", openaiURL: "https://m.io/v1/chat/completions", geminiURL: "https://m.io" }] }, "gateway:mixed").connection;
		return { catalogBase: c.catalogBase, availableTypes: c.availableTypes, apiBases: c.apiBases };
	})(),
	{
		catalogBase: "https://m.io",
		availableTypes: ["openai", "gemini"],
		apiBases: { "openai-completions": "https://m.io/v1", "google-generative-ai": "https://m.io/v1beta" },
	});

check("issue #4 repro gateway: plain baseURL keeps unrestricted availability",
	byRoute({ gateways: [{ id: "gw", baseURL: "https://gw.example.com", models: [{ id: "gemini-4-argon", protocol: "gemini", contextWindow: 1000000 }] }] }, "gateway:gw").connection.availableTypes,
	undefined);

check("gateway without baseURL or URLs is skipped",
	routes({ gateways: [{ id: "broken" }, { id: "ok", baseURL: "https://ok.io" }] }),
	["newapi", "gateway:ok"]);

check("legacy gateway keeps full availability",
	byRoute({ gateways: [{ id: "plain", baseURL: "https://p.io" }] }, "gateway:plain").connection.availableTypes,
	undefined);

check("root protocol URLs replace the default base",
	(() => {
		const gw = byRoute({ openaiURL: "https://root.io/v1/chat/completions" }, "newapi");
		return { baseURL: gw.connection.baseURL, catalogBase: gw.connection.catalogBase, availableTypes: gw.connection.availableTypes };
	})(),
	{ baseURL: "", catalogBase: "https://root.io", availableTypes: ["openai"] });

check("plain config still falls back to the public cloud",
	byRoute({}, "newapi").connection.baseURL,
	"https://api.newapi.ai");

// ---- issue #3: baseURL ending in /v1 must not double the version segment ----
// The catalog always appends its own full paths (/v1/models, /api/user/models),
// so a versioned base (accepted verbatim by the chat path's OpenAI-SDK
// convention) is stripped before discovery. Verified against a live local
// server recording the exact request path per base form.
{
	const hits = [];
	// The management API answers a flat id list; /v1/models answers objects.
	let flatMode = false;
	const server = http.createServer((req, res) => {
		hits.push(req.url);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ data: flatMode ? ["probe-model"] : [{ id: "probe-model" }] }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	const probe = async (config, label, expectedPath) => {
		hits.length = 0;
		flatMode = config.catalogMode === "management";
		const gw = byRoute(config, config.gateways ? "gateway:extra" : "newapi");
		const models = await discoverGatewayModels(gw.connection, "test-key");
		const got = `${hits[0] ?? "(no request)"} → ${models.length} model(s)`;
		check(label, got, `${expectedPath} → 1 model(s)`);
	};
	try {
		await probe({ baseURL: `http://127.0.0.1:${port}` }, "bare host hits /v1/models", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v1` }, "versioned base hits /v1/models once (issue #3)", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v1/` }, "trailing slash + version tolerated", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v2` }, "other version segments stripped too", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v1`, catalogMode: "management" }, "management mode with versioned base hits /api/user/models (issue #3)", "/api/user/models");
		await probe({ gateways: [{ id: "extra", baseURL: `http://127.0.0.1:${port}/v1` }] }, "gateways[] entry with versioned base hits /v1/models (issue #3)", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v1beta` }, "v1beta base stripped for discovery (issue #4)", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/V1beta` }, "v1beta strip is case-insensitive (issue #4)", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v1beta/` }, "trailing slash + v1beta tolerated (issue #4)", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v2beta` }, "v2beta stripped too (issue #4)", "/v1/models");
		await probe({ baseURL: `http://127.0.0.1:${port}/v1beta`, catalogMode: "management" }, "management mode with v1beta base hits /api/user/models (issue #4)", "/api/user/models");
	} finally {
		server.close();
	}
}

process.exit(failed ? 1 : 0);
