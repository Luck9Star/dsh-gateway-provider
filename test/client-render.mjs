/**
 * Client-half render smoke test (no browser, no react-dom).
 *
 * Loads lib/client.js through a stub `window.__ModuleLoader__` with a fake
 * React (createElement records plain trees; useState flips `false` initial
 * values to `true` so every collapsible form — gateway config, model editor,
 * add-model, add-gateway — renders open), then renders the registered
 * settings-section component against a stub settings/credentials/llm api and
 * walks the whole tree. Fails on any component throwing or producing
 * `undefined` text nodes. Runs once per locale (zh + en).
 *
 * Usage: node test/client-render.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");

// ---- Load the module and capture the registered settings-section component ----
// (The loader factory must run once per locale because T is captured at
// module scope; a fresh eval per locale is simplest.)
function loadModule(language, snapshot, api) {
	const React = {
		// Real React merges extra createElement args into props.children.
		createElement(type, props, ...children) {
			const merged = { ...(props || {}) };
			if (children.length === 1) merged.children = children[0];
			else if (children.length > 1) merged.children = children;
			return { type, props: merged, children };
		},
		useState(init) {
			const value = init === null ? snapshot : init === false ? true : typeof init === "function" ? init() : init;
			return [value, () => {}];
		},
		useRef(init) { return { current: init }; },
		useEffect() {},
		useCallback(fn) { return fn; },
	};
	let captured = null;
	const slots = {
		inject(_name, fn) { fn(); },
		register(spec, renderer) { captured = { spec, renderer }; },
	};
	// Node ≥21 exposes a getter-only global navigator; override for the locale switch.
	Object.defineProperty(globalThis, "navigator", { value: { language }, configurable: true, writable: true });
	let moduleExports;
	globalThis.window = {
		__ModuleLoader__: { load(def) { moduleExports = def.factory((n) => (n === "react" ? React : (() => { throw new Error("unexpected require " + n); }))); } },
	};
	(0, eval)(SOURCE);
	moduleExports.apply({ get: (name) => (name === "slots" ? slots : name === "connection" ? { api } : undefined) });
	if (!captured) throw new Error("settings.section not registered for " + language);
	return { captured, moduleExports };
}

const snapshot = {
	label: "Main", flavor: "newapi", baseURL: "https://gw.example.com", apiKeyEnv: "MY_KEY",
	excludePatterns: ["(^|/|-)image"],
	models: [
		{ id: "gpt-5.2", _discoveredName: "GPT-5.2", _protocol: "openai", _discoveredContext: 400000, _discoveredMax: 128000, _reasoning: true, disabled: true },
		{ id: "claude-opus-5", name: "Opus (renamed)", _discoveredName: "Claude Opus 5", _protocol: "anthropic", protocol: "anthropic" },
		{ id: "internal-test", _custom: true, name: "内测模型" },
	],
	gateways: [
		{ id: "backup", label: "Backup", baseURL: "https://b.example.com", flavor: "litellm", apiKeyEnv: "BACKUP_KEY", catalogMode: "v1", models: [{ id: "m1" }] },
		{ id: "edge", label: "Edge GW", flavor: "custom", openaiURL: "https://edge.example.com/openai/v1/chat/completions", anthropicURL: "https://edge.example.com/anthropic/v1/messages", apiKeyEnv: "EDGE_KEY", models: [{ id: "c1" }] },
	],
};
const api = {
	settings: {
		describe: async () => ({ result: { ok: true, value: { namespaces: [{ ns: "llm-newapi", value: snapshot }] } } }),
		mutate: async () => ({ result: { ok: true } }),
	},
	credentials: {
		describe: async () => ({ result: { ok: true, value: { credentials: { MY_KEY: { configured: true }, BACKUP_KEY: { configured: false } } } } }),
		set: async () => ({ result: { ok: true } }),
	},
	llm: { discoverModels: async () => ({ result: { ok: true, value: { models: [{ id: "x", name: "X", contextWindow: 1000, maxTokens: 100, protocol: "openai", reasoning: false }] } } }) },
};

let failed = false;
let firstModuleExports = null;
for (const language of ["zh-CN", "en-US"]) {
	const { captured, moduleExports } = loadModule(language, snapshot, api);
	if (firstModuleExports === null) firstModuleExports = moduleExports;
	const problems = [];
	let instances = 0;
	const walk = (node, where) => {
		if (node === null || node === undefined || typeof node !== "object") {
			if (node === undefined) problems.push(where + ": undefined text node");
			return;
		}
		if (Array.isArray(node)) { node.forEach((n) => walk(n, where)); return; }
		if (typeof node.type === "function") {
			const name = node.type.name || "<anon>";
			const key = where + "/" + name;
			instances++;
			try { walk(node.type(node.props), key); }
			catch (error) { problems.push(key + " threw: " + (error && error.message)); }
			return;
		}
		(node.children || []).forEach((c) => walk(c, where + "/" + String(node.type)));
	};
	try { walk(captured.renderer({ api }), "root"); }
	catch (error) { problems.push("root threw: " + (error && error.message)); }

	// Text expectations per locale (config form + editor + add-gateway all open).
	const texts = [];
	const collect = (node) => {
		if (node === null || node === undefined) return;
		if (Array.isArray(node)) return node.forEach(collect);
		if (typeof node === "object") {
			if (typeof node.type === "function") return collect(node.type(node.props));
			(node.children || []).forEach((c) => { if (typeof c === "string") texts.push(c); else collect(c); });
		}
	};
	collect(captured.renderer({ api }));
	const has = (s) => texts.some((t) => t.includes(s));
	const mustHave = language.startsWith("zh")
		? ["网关模型管理", "默认网关", "gateway:backup", "gateway:edge", "思考级别", "已隐藏", "自定义", "API Key 变量名", "留空则继承默认网关",
			"完全自定义", "OpenAI 兼容地址", "/chat/completions 结尾", "/v1/messages 结尾", "anthropic"]
		: ["Gateway Model Management", "Default gateway", "gateway:backup", "gateway:edge", "Reasoning levels", "hidden", "Custom", "API Key env var", "inherits the default gateway",
			"Fully custom", "OpenAI-compatible URL", "/chat/completions", "/v1/messages", "anthropic"];
	for (const s of mustHave) if (!has(s)) problems.push("missing expected text: " + s);

	if (problems.length > 0) {
		failed = true;
		console.error("[FAIL] " + language);
		problems.forEach((p) => console.error("  - " + p));
	} else {
		console.log("[PASS] client render tree (" + language + ") — " + instances + " component instances, " + texts.length + " text nodes");
	}
}

// ---- mergeDiscovered unit checks (pure helper exported by the module) ----
{
	const md = firstModuleExports && firstModuleExports.mergeDiscovered;
	const problems = [];
	// Key-order-insensitive deep compare (JSON key order follows insertion).
	const norm = (v) => JSON.stringify(v, (k, val) => {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			return Object.keys(val).sort().reduce((acc, key) => { acc[key] = val[key]; return acc; }, {});
		}
		return val;
	});
	const eq = (label, actual, expected) => {
		const a = norm(actual), e = norm(expected);
		if (a !== e) problems.push(label + ": got " + a + ", want " + e);
	};
	if (typeof md !== "function") {
		problems.push("mergeDiscovered is not exported");
	} else {
		// Legacy entry (name from the old UI, no _discoveredName) follows the
		// fresh discovery name instead of freezing the stale one.
		eq("legacy name follows discovery",
			md([{ id: "gpt-4o", name: "GPT-4o (old)" }], [{ id: "gpt-4o", name: "GPT-4o (new)", contextWindow: 128000, maxTokens: 16384, protocol: "openai", reasoning: false }]),
			[{ id: "gpt-4o", _discoveredName: "GPT-4o (new)", _protocol: "openai", _discoveredContext: 128000, _discoveredMax: 16384, _reasoning: false }]);
		// A user-edited name (differs from the last reported discovery name) wins.
		eq("user override name wins",
			md([{ id: "m", name: "Mine", _discoveredName: "Original", disabled: true, protocol: "anthropic" }], [{ id: "m", name: "Original" }]),
			[{ id: "m", name: "Mine", _discoveredName: "Original", _reasoning: false, disabled: true, protocol: "anthropic" }]);
		// Entries absent from discovery become custom; discovered meta recorded.
		eq("absent entry becomes custom",
			md([{ id: "custom-1", name: "X" }], [{ id: "gpt-5.2", name: "GPT-5.2" }]),
			[{ id: "gpt-5.2", _discoveredName: "GPT-5.2", _reasoning: false }, { id: "custom-1", name: "X", _custom: true }]);
	}
	if (problems.length > 0) {
		failed = true;
		console.error("[FAIL] mergeDiscovered unit checks");
		problems.forEach((p) => console.error("  - " + p));
	} else {
		console.log("[PASS] mergeDiscovered unit checks (legacy refresh / override wins / custom marking)");
	}
}
process.exit(failed ? 1 : 0);
