/**
 * Unit tests for the custom-template protocol URL derivation and the
 * gateway resolution that consumes it (no network, no pi-ai calls).
 *
 * Usage: node test/protocol-urls.mjs
 */
import { deriveProtocolURLs, effectiveEndpointTypes } from "../lib/protocols.js";
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
	deriveProtocolURLs({ openaiURL: "", responsesURL: "", anthropicURL: "" }),
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
	} finally {
		server.close();
	}
}

process.exit(failed ? 1 : 0);
