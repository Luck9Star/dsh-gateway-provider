/**
 * Unit tests for the custom-template protocol URL derivation and the
 * gateway resolution that consumes it (no network, no pi-ai calls).
 *
 * Usage: node test/protocol-urls.mjs
 */
import { deriveProtocolURLs, effectiveEndpointTypes } from "../lib/protocols.js";
import { resolveGateways } from "../index.js";

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

process.exit(failed ? 1 : 0);
