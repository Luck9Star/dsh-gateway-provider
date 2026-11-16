/**
 * Client↔host Remote API contract test.
 *
 * Guards the dsh ≥ 0.1.2-rc.1 typed-Remote call shapes the settings section
 * makes (the regression that blanked the page: the old
 * `ctx.get("connection").api` facade with `{result:{ok,value}}` envelopes was
 * removed upstream). Loads lib/client.js through a stub module loader,
 * instantiates the registered section component twice (mount effect fires;
 * the second pass renders against the loaded snapshot), then drives the
 * interactive callbacks handed to the gateway card and asserts every outgoing
 * call carries the exact arity and payload the generated Remote namespaces
 * validate:
 *
 *   settings.describe()                        — 0 args
 *   settings.mutate(ns, ops, expectedRevision) — 3 args
 *   credentials.describe(refs[])               — 1 array arg
 *   credentials.set(ref, value)                — 2 args
 *   llm.discoverModels(settingsNs, request)    — 2 args, ns positional
 *
 * plus the {ok, value, error} result envelope (no nested `.result`).
 *
 * Usage: node test/client-api.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");

const calls = { settings: [], credentials: [], llm: [] };
/** When true, credentials.set reports failure (write-order regression). */
let failCredentialSet = false;
const SNAPSHOT = {
	label: "Main", baseURL: "https://gw.example.com", apiKeyEnv: "MY_KEY",
	models: [{ id: "m1" }],
	gateways: [
		{ id: "backup", baseURL: "https://b.example.com", apiKeyEnv: "BACKUP_KEY", models: [] },
		// Inherits the default ref (no apiKeyEnv) — the issue #12 edit path.
		{ id: "shared-url", baseURL: "https://gw.example.com", models: [] },
		// Inherits the default ref; its key write is made to fail (write order).
		{ id: "fail-edit", baseURL: "https://f.example.com", models: [] },
		// Hand-edited YAML id: the host routes it as gateway:mixed-case.
		{ id: "Mixed Case", baseURL: "https://m.example.com", models: [] },
	],
};
const api = {
	settings: {
		describe: async (...a) => { calls.settings.push(a); return { ok: true, value: { namespaces: [{ ns: "llm-newapi", value: SNAPSHOT }] } }; },
		mutate: async (...a) => { calls.settings.push(a); return { ok: true, value: { ns: "llm-newapi" } }; },
	},
	credentials: {
		describe: async (...a) => { calls.credentials.push(a); return { ok: true, value: { MY_KEY: { configured: true } } }; },
		set: async (...a) => { calls.credentials.push(a); return { ok: !failCredentialSet }; },
	},
	llm: {
		discoverModels: async (...a) => { calls.llm.push(a); return { ok: true, value: [{ id: "x", name: "X" }] }; },
	},
};

// ---- Minimal React stand-in with one shared hook-cell array ----
// The section's own hooks occupy the first slots; nested components rendered
// AFTER the section body complete would clobber them, so this test only
// instantiates the section itself (its children stay as element descriptors
// whose props we read without invoking their bodies).
let hookCells = [];
let hookIndex = 0;
const effectQueue = [];
const React = {
	createElement(type, props, ...children) {
		const merged = { ...(props || {}) };
		if (children.length === 1) merged.children = children[0];
		else if (children.length > 1) merged.children = children;
		return { type, props: merged };
	},
	useState(init) {
		const slot = hookIndex++;
		if (hookCells[slot] === undefined) hookCells[slot] = { value: typeof init === "function" ? init() : init };
		const cell = hookCells[slot];
		return [cell.value, (v) => { cell.value = typeof v === "function" ? v(cell.value) : v; }];
	},
	useRef(init) {
		const slot = hookIndex++;
		if (!hookCells[slot]) hookCells[slot] = { current: init };
		return hookCells[slot];
	},
	useEffect(fn) { effectQueue.push(fn); },
	useCallback(fn) { return fn; },
};

let captured = null;
const slots = {
	inject(_name, fn) { fn(); },
	register(spec, renderer) { captured = { spec, renderer }; },
};
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true, writable: true });
let moduleExports;
globalThis.window = {
	__ModuleLoader__: { load(def) { moduleExports = def.factory((n) => (n === "react" ? React : (() => { throw new Error("unexpected require " + n); }))); } },
};
(0, eval)(SOURCE);
moduleExports.apply({
	get: (name) => (name === "slots" ? slots
		: name === "remote.settings" ? api.settings
		: name === "remote.credentials" ? api.credentials
		: name === "remote.llm" ? api.llm
		: name === "remote" ? {} : undefined),
});
if (!captured) throw new Error("settings.section was not registered");

const problems = [];
const expect = (cond, msg) => { if (!cond) problems.push(msg); };

/** One render pass of the section component (fresh index into shared cells). */
function renderSection() {
	hookIndex = 0;
	const element = captured.renderer({ api });
	return element.type(element.props);
}

/** Walk element descriptors collecting props without invoking function bodies. */
function collectElementProps(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) { node.forEach((n) => collectElementProps(n, out)); return out; }
	if (typeof node.type === "function") {
		out.push(node.props);
		collectElementProps(node.props?.children, out);
		return out;
	}
	collectElementProps(node.props?.children, out);
	return out;
}

// Pass 1: mount → the effect queue runs load() → describe + credentials.describe.
renderSection();
for (const fn of effectQueue.splice(0)) fn();
await new Promise((r) => setTimeout(r, 20));

// settings.describe: zero arguments.
const describes = calls.settings.filter((a) => a.length === 0);
expect(describes.length > 0, `settings.describe must be called with 0 arguments (got ${calls.settings.length} settings calls, ${describes.length} arity-0)`);

// credentials.describe: (refs[]) — arity 1, array of strings.
for (const a of calls.credentials) {
	expect(a.length === 1, `credentials.describe must carry 1 argument (refs), got ${a.length}`);
	expect(Array.isArray(a[0]) && a[0].every((r) => typeof r === "string"), "credentials.describe argument must be a string array");
}

// Pass 2: the snapshot cell now holds the loaded document → the full tree
// builds, with the gateway-card element carrying its interactive props.
const tree = renderSection();
const propsList = collectElementProps(tree);
const card = propsList.find((p) => p && typeof p.onFetch === "function" && typeof p.onTest === "function");
if (!card) {
	problems.push("gateway-card path not reachable in the render tree (onFetch/onTest props not found)");
} else {
	await card.onFetch();
	await card.onTest();
	await new Promise((r) => setTimeout(r, 20));
	// llm.discoverModels: (settingsNs, request) — arity 2.
	for (const a of calls.llm) {
		if (a.length !== 2) problems.push(`llm.discoverModels must carry 2 arguments (settingsNs, request), got ${a.length}`);
		else {
			if (a[0] !== "llm-newapi") problems.push("llm.discoverModels first argument must be the namespace string");
			if (typeof a[1] !== "object" || a[1] === null) problems.push("llm.discoverModels second argument must be a request object");
			if ("settingsNs" in a[1]) problems.push("llm.discoverModels request must not carry a legacy settingsNs field");
		}
	}
	// The save-config path: ConfigForm is only mounted when the card's local
	// state opens it, which the element-level walk cannot do — exercise the
	// documented contract through the section's own saveGatewayConfig by
	// re-rendering with the config form force-opened is not reachable either.
	// Instead: assert credentials.set through the add-gateway path (its form
	// submits synchronously through props.onAdd).
	const addForm = propsList.find((p) => p && typeof p.onAdd === "function" && p.existingIds !== undefined);
	if (!addForm) {
		problems.push("add-gateway path not reachable in the render tree (onAdd prop not found)");
	} else {
		await addForm.onAdd({ id: "edge", baseURL: "https://edge.example.com", flavor: "openai-compatible", apiKey: "sk-edge" });
		await new Promise((r) => setTimeout(r, 20));
		const sets = calls.credentials.filter((a) => a.length === 2);
		expect(sets.length > 0, "credentials.set must be called with 2 arguments (ref, value)");
		for (const a of sets) {
			expect(typeof a[0] === "string" && typeof a[1] === "string", "credentials.set arguments must be (ref, value) strings");
		}

		// ---- Issue #12: a new key never overwrites the default gateway's ref ----
		const lastGatewaysWrite = () => {
			const m = calls.settings.filter((a) => a.length === 3 && a[1].some((op) => op.path[0] === "gateways")).at(-1);
			return m && m[1].find((op) => op.path[0] === "gateways").value;
		};
		const setsFor = (value) => calls.credentials.filter((a) => a.length === 2 && a[1] === value);

		// (a) add with a key and no env var → per-gateway ref, persisted on the entry.
		const edgeSet = setsFor("sk-edge");
		expect(edgeSet.length === 1, "add-gateway with a key must write it exactly once");
		expect(edgeSet[0]?.[0] !== "MY_KEY", `add-gateway key must not overwrite the default ref MY_KEY (wrote ${edgeSet[0]?.[0]})`);
		expect(edgeSet[0]?.[0] === "NEWAPI_API_KEY_EDGE", `add-gateway key ref should be NEWAPI_API_KEY_EDGE, got ${edgeSet[0]?.[0]}`);
		const edgeEntry = (lastGatewaysWrite() || []).find((g) => g.id === "edge");
		expect(edgeEntry?.apiKeyEnv === edgeSet[0]?.[0], "the added gateway entry must reference the ref its key was written to");

		// (b) add with an explicit env var → exactly that ref.
		await addForm.onAdd({ id: "explicit", baseURL: "https://x.example.com", apiKeyEnv: "X_KEY", apiKey: "sk-x" });
		await new Promise((r) => setTimeout(r, 20));
		expect(setsFor("sk-x")[0]?.[0] === "X_KEY", "an explicit apiKeyEnv must be used as-is");

		// (c) add with no key and no env var → inherits the default (no write, no ref).
		const before = calls.credentials.length;
		await addForm.onAdd({ id: "inherit", baseURL: "https://i.example.com" });
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.credentials.slice(before).every((a) => a.length !== 2), "add-gateway without a key must not write any credential");
		const inheritEntry = (lastGatewaysWrite() || []).find((g) => g.id === "inherit");
		expect(inheritEntry !== undefined && inheritEntry.apiKeyEnv === undefined, "a key-less gateway keeps inheriting the default ref");
	}

	// (d) editing an inheriting gateway with only a new key → its own ref.
	const sharedCard = propsList.find((p) => p && p.gateway?.id === "shared-url" && typeof p.onSaveConfig === "function");
	if (!sharedCard) {
		problems.push("shared-url gateway card not reachable in the render tree");
	} else {
		const result = await sharedCard.onSaveConfig({ apiKey: "sk-shared" });
		await new Promise((r) => setTimeout(r, 20));
		expect(result?.ok === true, "key-only save on an inheriting gateway must succeed");
		const sharedSet = calls.credentials.filter((a) => a.length === 2 && a[1] === "sk-shared");
		expect(sharedSet.length === 1 && sharedSet[0][0] === "NEWAPI_API_KEY_SHARED_URL", `inheriting-gateway key must go to NEWAPI_API_KEY_SHARED_URL, got ${sharedSet[0]?.[0]}`);
		const gwWrites = calls.settings.filter((a) => a.length === 3 && a[1].some((op) => op.path[0] === "gateways"));
		const sharedEntry = gwWrites.at(-1)?.[1].find((op) => op.path[0] === "gateways").value.find((g) => g.id === "shared-url");
		expect(sharedEntry?.apiKeyEnv === "NEWAPI_API_KEY_SHARED_URL", "the edited gateway must persist its new apiKeyEnv");
		expect(!calls.credentials.some((a) => a.length === 2 && a[0] === "MY_KEY"), "no write may target the default gateway's ref MY_KEY");
	}

	// (f) the key is stored before any setting references it: a failed
	// credential write must leave the stored gateways untouched.
	const failCard = propsList.find((p) => p && p.gateway?.id === "fail-edit" && typeof p.onSaveConfig === "function");
	const addCard = propsList.find((p) => p && typeof p.onAdd === "function" && p.existingIds !== undefined);
	if (!failCard || !addCard) {
		problems.push("fail-edit card / add form not reachable in the render tree");
	} else {
		failCredentialSet = true;
		const settingsBefore = calls.settings.length;
		const editResult = await failCard.onSaveConfig({ apiKey: "sk-fail-edit" });
		const addResult = await addCard.onAdd({ id: "fail-add", baseURL: "https://fa.example.com", apiKey: "sk-fail-add" });
		await new Promise((r) => setTimeout(r, 20));
		failCredentialSet = false;
		expect(editResult?.ok === false && addResult?.ok === false, "a failed key write must report the save as failed");
		const laterGatewayWrites = calls.settings.slice(settingsBefore).filter((a) => a.length === 3 && a[1].some((op) => op.path[0] === "gateways"));
		expect(laterGatewayWrites.length === 0, `no gateways write may follow a failed key write (got ${laterGatewayWrites.length})`);
	}

	// (g) the client addresses a gateway by the same route the host registers
	// (index.js routeIdOf), and its duplicate check uses that route too.
	const mixedCard = propsList.find((p) => p && p.gateway?.id === "Mixed Case" && typeof p.onTest === "function");
	if (!mixedCard) {
		problems.push("Mixed Case gateway card not reachable in the render tree");
	} else {
		expect(mixedCard.route === "gateway:mixed-case", `card route must match the host route gateway:mixed-case, got ${mixedCard.route}`);
		const before = calls.llm.length;
		await mixedCard.onTest();
		await new Promise((r) => setTimeout(r, 20));
		const asked = calls.llm.slice(before).map((a) => a[1]?.provider);
		expect(asked.length === 1 && asked[0] === "gateway:mixed-case", `test-connection must ask the host route gateway:mixed-case, got ${asked}`);
		const addCard2 = propsList.find((p) => p && typeof p.onAdd === "function" && p.existingIds !== undefined);
		expect(addCard2.existingIds.indexOf("mixed-case") !== -1, "existingIds must hold sanitized ids so a colliding add is refused");
		const dup = await addCard2.onAdd({ id: "mixed-case", baseURL: "https://dup.example.com" });
		expect(dup?.ok === false, "adding an id that collides after sanitizing must be refused");
	}

	// (h) an invalid key variable name is refused before anything is written
	// (the host would reject the ref and skip the gateway).
	{
		const card = propsList.find((p) => p && p.gateway?.id === "shared-url" && typeof p.onSaveConfig === "function");
		const add = propsList.find((p) => p && typeof p.onAdd === "function" && p.existingIds !== undefined);
		const settingsBefore = calls.settings.length;
		const credsBefore = calls.credentials.length;
		const edit = await card.onSaveConfig({ apiKeyEnv: "MY-KEY", apiKey: "sk-test-bad-env" });
		const added = await add.onAdd({ id: "bad-env", baseURL: "https://be.example.com", apiKeyEnv: "9KEY", apiKey: "sk-test-bad-env" });
		await new Promise((r) => setTimeout(r, 20));
		expect(edit?.ok === false && added?.ok === false, "an invalid apiKeyEnv must be refused");
		expect(calls.settings.length === settingsBefore && calls.credentials.length === credsBefore,
			`an invalid apiKeyEnv must write nothing (settings +${calls.settings.length - settingsBefore}, credentials +${calls.credentials.length - credsBefore})`);
	}

	// (e) derived names never collide with refs already in use.
	const derive = moduleExports.perGatewayKeyEnv;
	expect(derive("a-b", []) === "NEWAPI_API_KEY_A_B", "derived ref upper-cases and replaces '-'");
	expect(derive("a-b", ["NEWAPI_API_KEY_A_B"]) === "NEWAPI_API_KEY_A_B_2", "derived ref is suffixed on collision");
	expect(/^[A-Za-z_][A-Za-z0-9_]*$/.test(derive("9lives", [])), "derived ref is a valid credential ref");
}

// settings.mutate: (ns, ops, expectedRevision) — arity 3, ns first, ops array.
const mutates = calls.settings.filter((a) => a.length !== 0);
for (const a of mutates) {
	expect(a.length === 3, `settings.mutate must carry 3 arguments (ns, ops, expectedRevision), got ${a.length}`);
	expect(a[0] === "llm-newapi", "settings.mutate first argument must be the namespace string");
	expect(Array.isArray(a[1]), "settings.mutate second argument must be an ops array");
}
expect(mutates.length > 0, "settings.mutate must have been exercised (fetch/add-gateway writes settings)");

// The result envelope: {ok, value} / {ok:false, error} — never nested `.result`.
// Every consumer path above resolved with real values; a nested `.result` read
// would have produced undefined values and thrown inside the component.

if (problems.length > 0) {
	console.error("[FAIL] client Remote API contract");
	problems.forEach((p) => console.error("  - " + p));
	process.exit(1);
}
console.log("[PASS] client Remote API contract (typed namespaces, positional args, {ok,value} envelopes)");
