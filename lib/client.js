/**
 * Client half: a self-built "Gateway Models" settings section.
 *
 * Registers a `settings.section` entry that renders a complete model-
 * management UI for the `llm-newapi` namespace: gateway cards (connection
 * config with validation + dirty tracking), the discovered model list per
 * gateway with search/filter, per-model override editing (name / protocol /
 * context / output cap / reasoning levels), custom-model add & delete, and
 * thinking-level mapping. Reads and writes through the forwarded settings +
 * llm services (the same APIs the shipped Models page uses), so it needs no
 * Package-private RPC.
 *
 * @module dsh-newapi-provider/client
 */

window.__ModuleLoader__.load({
	id: "dsh-newapi-provider",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");

		var NS = "llm-newapi";
		var GATEWAY_FLAVORS = ["newapi", "litellm", "higress", "openai-compatible", "custom"];
		var CATALOG_MODES = ["auto", "v1", "management"];
		var PROTOCOLS = ["openai", "openai-response", "anthropic", "gemini"];
		/** Gateway template fields (suffix "URL") → card protocol tag. */
		var PROTOCOL_URL_KEYS = ["openaiURL", "responsesURL", "anthropicURL"];

		// ---- i18n (manual zh/en switch; no locale registration needed) ----
		var ZH = (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("zh"));
		var T = ZH ? {
			nav: "网关模型", title: "网关模型管理", intro: "管理 OpenAI 兼容网关的模型列表、接入协议与覆盖设置。",
			defaultRoute: "默认网关", custom: "自定义", route: "路由",
			models: "模型", fetchModels: "拉取模型", fetching: "拉取中…", addModel: "添加自定义模型",
			searchPlaceholder: "搜索模型…", filterAll: "全部", filterHidden: "已隐藏", filterCustom: "自定义",
			noMatch: "没有匹配的模型", noModels: "暂无模型 — 点击「拉取模型」从网关获取，或添加自定义模型。",
			modelId: "模型 ID", modelIdRequired: "必填", modelIdExists: "该模型 ID 已存在",
			numInvalid: "必须是大于 0 的整数",
			disabledTag: "已隐藏", enable: "显示", disable: "隐藏", expand: "配置", collapse: "收起",
			protocol: "协议", name: "显示名称", contextWindow: "上下文窗口", maxTokens: "输出上限",
			reasoningLevels: "思考级别",
			protocolAuto: function (p) { return p ? "自动（" + p + "）" : "自动"; },
			discoveredAs: function (v) { return "发现值：" + v; },
			nameHint: "留空则跟随网关返回的显示名",
			reasoningHint: "逗号分隔，如 off, low, medium, high；留空使用默认",
			overrideBadge: "覆盖",
			delete: "删除", save: "保存", cancel: "取消", reset: "重置", close: "收起",
			confirmDelete: "确认删除该网关？其模型覆盖配置将一并移除。",
			test: "测试", testing: "测试中…",
			testOkN: function (n) { return "✓ 已连接 — " + n + " 个模型"; },
			syncedN: function (n) { return "✓ 已同步 " + n + " 个模型"; },
			allFiltered: "✗ 模型全部被排除规则过滤",
			testFail: "✗ 连接失败", testEmpty: "✗ 无模型",
			configSaved: "✓ 已保存", configSaveFail: "✗ 保存失败",
			keySet: function (env) { return "✓ Key 已设置 · " + env; },
			keyNotSet: function (env) { return "⚠ 未设置 Key · " + env; },
			gatewayConfig: "网关配置", apiKeyLabel: "API Key",
			baseURL: "基础地址", apiKeyEnv: "API Key 变量名", gatewayId: "网关 ID", label: "名称",
			flavor: "网关类型", catalogMode: "模型列表来源",
			inherit: "继承默认",
			flavorHint: "预设模板；各模型协议仍自动选择。选「完全自定义」后仅启用填了地址的协议",
			tplHintNewapi: "多协议聚合网关：OpenAI / Responses / Anthropic / Gemini，自动发现模型，鉴权失败回退管理 API",
			tplHintLitellm: "LiteLLM Proxy：/v1/chat/completions 与 /v1/responses，经 /v1/models 自动发现",
			tplHintHigress: "Higress AI 网关：OpenAI 格式为主，新版本同端口支持 Anthropic /v1/messages",
			tplHintOpenaiCompatible: "任意 OpenAI 兼容网关：填一个基础地址，各协议路径自动派生",
			tplHintCustom: "三种协议地址分别填写完整 URL；留空的协议不启用，模型仅以已启用协议请求",
			tplNewapi: "NewAPI", tplLitellm: "LiteLLM", tplHigress: "Higress",
			tplOpenaiCompatible: "OpenAI 兼容", tplCustom: "完全自定义",
			openaiURL: "OpenAI 兼容地址", responsesURL: "Responses 地址", anthropicURL: "Anthropic 地址",
			openaiURLHint: "完整地址，以 /chat/completions 结尾（也可只填到 /v1）",
			responsesURLHint: "完整地址，以 /responses 结尾（也可只填到 /v1）",
			anthropicURLHint: "完整地址，以 /v1/messages 结尾",
			customNeedOne: "至少填写一个协议地址",
			customURLPlaceholder: "https://gw.example.com/v1/chat/completions",
			responsesURLPlaceholder: "https://gw.example.com/v1/responses",
			anthropicURLPlaceholder: "https://gw.example.com/v1/messages",
			catalogHint: "auto：优先 /v1/models，鉴权失败时回退管理 API",
			baseURLClearHint: "留空则回退到环境变量 NEWAPI_BASE_URL 或官方云端地址",
			labelClearHint: "留空则回退为 gateway:<id>",
			keyEnvHint: "留空则继承默认网关的 Key（NEWAPI_API_KEY）",
			keyKeepHint: "留空保持不变；填写则覆盖存储的 Key",
			urlInvalid: "必须以 http:// 或 https:// 开头", urlRequired: "必填",
			idExists: "该 ID 已被其他网关使用",
			idPreview: function (s) { return "将创建路由 gateway:" + s; },
			idInvalid: "小写字母、数字、-、_（自动转换）",
			addGateway: "添加网关",
			addGatewayHint: "每个网关成为独立的 gateway:<id> 模型路由",
			idPlaceholder: "my-gateway", labelPlaceholder: "我的网关", urlPlaceholder: "https://…",
			enterApiKey: "sk-…", modelIdPlaceholder: "gpt-5.2", modelNamePlaceholder: "GPT-5.2（可选）",
			modelsTag: function (n) { return n + " 个模型"; },
		} : {
			nav: "Gateway Models", title: "Gateway Model Management", intro: "Manage OpenAI-compatible gateway model lists, protocols, and overrides.",
			defaultRoute: "Default gateway", custom: "Custom", route: "route",
			models: "Models", fetchModels: "Fetch Models", fetching: "Fetching…", addModel: "Add Custom Model",
			searchPlaceholder: "Search models…", filterAll: "All", filterHidden: "Hidden", filterCustom: "Custom",
			noMatch: "No matching models", noModels: "No models yet — fetch from the gateway, or add a custom model.",
			modelId: "Model ID", modelIdRequired: "Required", modelIdExists: "This model ID already exists",
			numInvalid: "Must be an integer > 0",
			disabledTag: "hidden", enable: "Show", disable: "Hide", expand: "Configure", collapse: "Collapse",
			protocol: "Protocol", name: "Display name", contextWindow: "Context window", maxTokens: "Output cap",
			reasoningLevels: "Reasoning levels",
			protocolAuto: function (p) { return p ? "Auto (" + p + ")" : "Auto"; },
			discoveredAs: function (v) { return "Discovered: " + v; },
			nameHint: "Leave empty to follow the gateway's display name",
			reasoningHint: "Comma-separated, e.g. off, low, medium, high; empty = default",
			overrideBadge: "override",
			delete: "Delete", save: "Save", cancel: "Cancel", reset: "Reset", close: "Collapse",
			confirmDelete: "Delete this gateway? Its model overrides will be removed too.",
			test: "Test", testing: "Testing…",
			testOkN: function (n) { return "✓ Connected — " + n + " models"; },
			syncedN: function (n) { return "✓ Synced " + n + " models"; },
			allFiltered: "✗ All models excluded by patterns",
			testFail: "✗ Connection failed", testEmpty: "✗ No models",
			configSaved: "✓ Saved", configSaveFail: "✗ Save failed",
			keySet: function (env) { return "✓ Key set · " + env; },
			keyNotSet: function (env) { return "⚠ No key set · " + env; },
			gatewayConfig: "Gateway Config", apiKeyLabel: "API Key",
			baseURL: "Base URL", apiKeyEnv: "API Key env var", gatewayId: "Gateway ID", label: "Label",
			flavor: "Gateway type", catalogMode: "Model-list source",
			inherit: "Inherit default",
			flavorHint: "Preset template; per-model protocols stay automatic. Choosing Fully custom enables only protocols with an address",
			tplHintNewapi: "Multi-protocol aggregator: OpenAI / Responses / Anthropic / Gemini; auto model discovery with management-API fallback",
			tplHintLitellm: "LiteLLM proxy: /v1/chat/completions and /v1/responses; discovery via /v1/models",
			tplHintHigress: "Higress AI gateway: OpenAI format; newer versions also serve Anthropic /v1/messages",
			tplHintOpenaiCompatible: "Any OpenAI-compatible gateway: one base address, protocol paths derived automatically",
			tplHintCustom: "Enter each protocol's full URL; empty protocols stay disabled and models use enabled protocols only",
			tplNewapi: "NewAPI", tplLitellm: "LiteLLM", tplHigress: "Higress",
			tplOpenaiCompatible: "OpenAI-compatible", tplCustom: "Fully custom",
			openaiURL: "OpenAI-compatible URL", responsesURL: "Responses URL", anthropicURL: "Anthropic URL",
			openaiURLHint: "Full address ending in /chat/completions (a /v1 base also works)",
			responsesURLHint: "Full address ending in /responses (a /v1 base also works)",
			anthropicURLHint: "Full address ending in /v1/messages",
			customNeedOne: "Fill at least one protocol URL",
			customURLPlaceholder: "https://gw.example.com/v1/chat/completions",
			responsesURLPlaceholder: "https://gw.example.com/v1/responses",
			anthropicURLPlaceholder: "https://gw.example.com/v1/messages",
			catalogHint: "auto: prefer /v1/models, fall back to the management API on auth failure",
			baseURLClearHint: "Empty falls back to NEWAPI_BASE_URL or the public cloud default",
			labelClearHint: "Empty falls back to gateway:<id>",
			keyEnvHint: "Empty inherits the default gateway's key (NEWAPI_API_KEY)",
			keyKeepHint: "Empty keeps the stored key; type to overwrite",
			urlInvalid: "Must start with http:// or https://", urlRequired: "Required",
			idExists: "This ID is already used by another gateway",
			idPreview: function (s) { return "Will create route gateway:" + s; },
			idInvalid: "lowercase letters, digits, - and _ (auto-converted)",
			addGateway: "Add Gateway",
			addGatewayHint: "Each gateway becomes its own gateway:<id> model route",
			idPlaceholder: "my-gateway", labelPlaceholder: "My Gateway", urlPlaceholder: "https://…",
			enterApiKey: "sk-…", modelIdPlaceholder: "gpt-5.2", modelNamePlaceholder: "GPT-5.2 (optional)",
			modelsTag: function (n) { return n + " models"; },
		};

		/** Template metadata per gateway flavor (labels + form shaping). */
		var FLAVOR_INFO = {
			"newapi": { label: T.tplNewapi, hint: T.tplHintNewapi, url: "https://api.newapi.ai" },
			"litellm": { label: T.tplLitellm, hint: T.tplHintLitellm, url: "http://localhost:4000" },
			"higress": { label: T.tplHigress, hint: T.tplHintHigress, url: "http://localhost:8080" },
			"openai-compatible": { label: T.tplOpenaiCompatible, hint: T.tplHintOpenaiCompatible, url: "https://your-gateway.com" },
			"custom": { label: T.tplCustom, hint: T.tplHintCustom, url: "" },
		};

		/** Protocol URL field key → { label, hint, placeholder, tag }. */
		var PROTOCOL_URL_INFO = {
			openaiURL: { label: T.openaiURL, hint: T.openaiURLHint, ph: T.customURLPlaceholder, tag: "openai" },
			responsesURL: { label: T.responsesURL, hint: T.responsesURLHint, ph: T.responsesURLPlaceholder, tag: "responses" },
			anthropicURL: { label: T.anthropicURL, hint: T.anthropicURLHint, ph: T.anthropicURLPlaceholder, tag: "anthropic" },
		};

		/** Protocol tags a gateway card shows (configured URL fields only). */
		function protocolTags(gw) {
			return PROTOCOL_URL_KEYS.filter(function (k) { return gw && typeof gw[k] === "string" && gw[k].length > 0; })
				.map(function (k) { return PROTOCOL_URL_INFO[k].tag; });
		}

		/** Build a CSS style tag once. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tagId = "dsh-newapi-provider-styles";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
			var tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = [
				".na_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
				".na_title{font-size:16px;font-weight:600;margin:0}",
				".na_intro{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}",
				".na_gateway{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
				".na_gatewayHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".na_gatewayName{font-size:14px;font-weight:600}",
				".na_tag{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap;display:inline-flex;align-items:center;gap:4px}",
				".na_route{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}",
				".na_meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".na_metaUrl{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
				".na_actions{display:flex;gap:6px;margin-left:auto;align-items:center;flex-wrap:wrap}",
				".na_btn{height:26px;padding:0 12px;font-size:12px;font-weight:500;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}",
				".na_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
				".na_btn:active:not(:disabled){transform:translateY(1px)}",
				".na_btn:disabled{opacity:.45;cursor:default}",
				".na_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
				".na_btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}",
				".na_btnDanger{color:var(--dsw-alias-state-error-primary);border:none}",
				".na_btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
				".na_field{display:flex;flex-direction:column;gap:4px;min-width:0}",
				".na_fieldLabel{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}",
				".na_input{box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0 10px;font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%}",
				".na_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}",
				".na_input::placeholder{color:var(--dsw-alias-label-dimmed)}",
				"select.na_input{padding:0 8px;cursor:pointer}",
				".na_inputInvalid,.na_inputInvalid:focus{border-color:var(--dsw-alias-state-error-primary)}",
				".na_fieldError{font-size:12px;color:var(--dsw-alias-state-error-primary)}",
				".na_hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}",
				".na_muted{color:var(--dsw-alias-label-secondary);font-size:12px}",
				".na_badge{white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;display:inline-flex;align-items:center}",
				".na_testOk{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}",
				".na_testFail{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}",
				".na_keyWarn{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-interactive-bg-hover)}",
				".na_config{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;display:flex;flex-direction:column;gap:10px}",
				".na_configGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}",
				".na_spanAll{grid-column:1/-1}",
				".na_formRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".na_addForm{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
				".na_addFormGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}",
				".na_tplRow{display:flex;gap:6px;flex-wrap:wrap}",
				".na_tpl{height:26px;padding:0 12px;font-size:12px;font-weight:500;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;cursor:pointer}",
				".na_tpl:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".na_tpl:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
				".na_tplOn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}",
				".na_models{border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;display:flex;flex-direction:column;gap:6px}",
				".na_toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".na_search{flex:1;min-width:140px;max-width:240px}",
				".na_toolbar select.na_input{width:auto;flex:none}",
				".na_count{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
				".na_modelRow{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) auto auto auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
				".na_modelRow:last-child{border-bottom:none}",
				".na_modelId{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;overflow-wrap:anywhere;display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}",
				".na_modelNameCol{display:flex;flex-direction:column;gap:2px;min-width:0}",
				".na_modelName{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".na_modelMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".na_modelRowHidden .na_modelId,.na_modelRowHidden .na_modelNameCol,.na_modelRowHidden .na_modelMeta{opacity:.5}",
				".na_editor{grid-column:1/-1;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}",
				".na_editorGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}",
				".na_empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:10px;padding:16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;flex-direction:column;gap:8px;align-items:center}",
			].join("\n");
			document.head.appendChild(tag);
		}

		function h(type, props) {
			var args = [type, props || null];
			for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
			return React.createElement.apply(React, args);
		}

		/** 128000 → "128K", 2000000 → "2M"; "" for unknown. */
		function fmtTokens(n) {
			var v = Number(n);
			if (!isFinite(v) || v <= 0) return "";
			if (v >= 1000000) return (Math.round(v / 100000) / 10) + "M";
			if (v >= 1000) return (Math.round(v / 100) / 10) + "K";
			return String(Math.round(v));
		}

		/** A trimmed http(s) URL, or false. */
		function validURL(s) {
			return /^https?:\/\/\S+$/i.test(String(s || "").trim());
		}

		/** Sanitize a gateway id into a stable provider-route suffix. */
		function sanitizeId(s) {
			return String(s == null ? "" : s).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
		}

		/** Replace or insert one model entry inside a stored array. */
		function upsertModel(arr, entry) {
			var next = arr.map(function (m) { return m.id === entry.id ? entry : m; });
			if (!next.some(function (m) { return m.id === entry.id; })) next.push(entry);
			return next;
		}

		/**
		 * Merge a freshly discovered list into the stored catalog: the gateway
		 * is authoritative for id/name/context/maxTokens/protocol, while user
		 * edits (disabled / overrides / custom names) are preserved. Entries
		 * absent from the discovery result are marked custom. A stored name
		 * wins only when it differs from the name discovery last reported
		 * (_discoveredName); legacy entries without that record always follow
		 * the fresh discovery name (the old UI never wrote name overrides).
		 */
		function mergeDiscovered(current, discovered) {
			current = current || [];
			var prevById = {};
			var ids = {};
			current.forEach(function (m) { prevById[m.id] = m; });
			discovered.forEach(function (m) { ids[m.id] = true; });
			var updated = discovered.map(function (d) {
				var prev = prevById[d.id];
				var entry = {
					id: d.id,
					_discoveredName: d.name || d.id,
					_protocol: d.protocol,
					_discoveredContext: d.contextWindow,
					_discoveredMax: d.maxTokens,
					_reasoning: d.reasoning === true,
				};
				if (prev !== undefined) {
					if (prev._discoveredName !== undefined && typeof prev.name === "string" && prev.name.length > 0 && prev.name !== prev._discoveredName) {
						entry.name = prev.name;
					}
					["protocol", "contextWindow", "maxTokens", "reasoningLevels", "disabled"].forEach(function (k) {
						if (prev[k] !== undefined) entry[k] = prev[k];
					});
				}
				return entry;
			});
			var customs = current.filter(function (m) { return ids[m.id] === undefined; })
				.map(function (m) { return Object.assign({}, m, { _custom: true }); });
			return updated.concat(customs);
		}

		/** Label + control + optional hint / inline error. */
		function Field(props) {
			return h("div", { className: "na_field" + (props.spanAll ? " na_spanAll" : "") },
				h("label", { className: "na_fieldLabel" }, props.label),
				props.children,
				props.error ? h("span", { className: "na_fieldError" }, props.error) : (props.hint ? h("span", { className: "na_hint" }, props.hint) : null),
			);
		}

		/**
		 * Gateway connection form: prefilled from the current values, with
		 * dirty tracking, per-field validation, and explicit clear semantics
		 * (empty label / apiKeyEnv / flavor → inherit the shared defaults).
		 * The "custom" template swaps the single base URL for per-protocol
		 * full endpoint URLs (empty = that protocol stays disabled).
		 */
		function ConfigForm(props) {
			var isDefault = props.isDefault;
			var gw = props.gateway;
			var protoOf = function (src, key) { return (src && src[key]) || ""; };
			var initial = {
				baseURL: (isDefault ? props.snapshot.baseURL : gw.baseURL) || "",
				label: (isDefault ? props.snapshot.label : gw.label) || "",
				apiKeyEnv: (isDefault ? "" : gw.apiKeyEnv) || "",
				flavor: isDefault ? (props.snapshot.flavor || "newapi") : (gw.flavor || ""),
				catalogMode: isDefault ? "" : (gw.catalogMode || ""),
				openaiURL: protoOf(isDefault ? props.snapshot : gw, "openaiURL"),
				responsesURL: protoOf(isDefault ? props.snapshot : gw, "responsesURL"),
				anthropicURL: protoOf(isDefault ? props.snapshot : gw, "anthropicURL"),
				apiKey: "",
			};
			var _v = React.useState(initial); var values = _v[0]; var setValues = _v[1];
			var _b = React.useState(initial); var base = _b[0]; var setBase = _b[1];
			var _st = React.useState(null); var status = _st[0]; var setStatus = _st[1];
			var _sv = React.useState(false); var saving = _sv[0]; var setSaving = _sv[1];

			var isCustom = values.flavor === "custom";
			var editKeys = ["baseURL", "label", "apiKeyEnv", "flavor", "catalogMode"].concat(PROTOCOL_URL_KEYS);
			var errors = {};
			var trimmedURL = values.baseURL.trim();
			if (trimmedURL.length > 0 && !validURL(trimmedURL)) errors.baseURL = T.urlInvalid;
			if (!isDefault && !isCustom && trimmedURL.length === 0) errors.baseURL = T.urlRequired;
			var customFilled = false;
			PROTOCOL_URL_KEYS.forEach(function (k) {
				var v = values[k].trim();
				if (v.length > 0) customFilled = true;
				else return;
				if (!validURL(v)) errors[k] = T.urlInvalid;
			});
			if (isCustom && !customFilled) errors.openaiURL = errors.openaiURL || T.customNeedOne;
			var dirty = editKeys.some(function (k) {
				return (values[k] || "").trim() !== (base[k] || "").trim();
			}) || values.apiKey.length > 0;
			var canSave = dirty && Object.keys(errors).length === 0 && !saving;

			var set = function (key, val) {
				setValues(function (prev) { return Object.assign({}, prev, { [key]: val }); });
				setStatus(null);
			};
			var submit = function () {
				if (!canSave) return;
				setSaving(true); setStatus(null);
				// Send only what actually changed: absent = untouched, "" = clear
				// (inherit). An API-key-only save carries just `apiKey`.
				var changes = {};
				editKeys.forEach(function (k) {
					var cur = (values[k] || "").trim();
					if (k === "baseURL" || PROTOCOL_URL_KEYS.indexOf(k) !== -1) cur = cur.replace(/\/+$/, "");
					if (cur !== (base[k] || "").trim()) changes[k] = cur;
				});
				if (values.apiKey.length > 0) changes.apiKey = values.apiKey;
				props.onSave(changes).then(function (result) {
					setSaving(false);
					setStatus(result);
					if (result.ok) {
						var nextBase = Object.assign({}, values, { apiKey: "" });
						setValues(nextBase);
						setBase(nextBase);
					}
				});
			};

			return h("form", { className: "na_config", onSubmit: function (e) { e.preventDefault(); submit(); } },
				h("div", { className: "na_configGrid" },
					!isCustom ? h(Field, { label: T.baseURL, spanAll: true, error: errors.baseURL, hint: isDefault ? T.baseURLClearHint : null },
						h("input", { className: "na_input" + (errors.baseURL ? " na_inputInvalid" : ""), type: "text", value: values.baseURL, spellCheck: false, placeholder: "https://your-gateway.com", onChange: function (e) { set("baseURL", e.target.value); } }),
					) : null,
					isCustom ? PROTOCOL_URL_KEYS.map(function (k) {
						var info = PROTOCOL_URL_INFO[k];
						return h(Field, { key: k, label: info.label, spanAll: true, error: errors[k], hint: info.hint },
							h("input", { className: "na_input" + (errors[k] ? " na_inputInvalid" : ""), type: "text", value: values[k], spellCheck: false, placeholder: info.ph, onChange: function (e) { set(k, e.target.value); } }),
						);
					}) : null,
					!isDefault ? h(Field, { label: T.label, hint: T.labelClearHint },
						h("input", { className: "na_input", type: "text", value: values.label, placeholder: gw.id, onChange: function (e) { set("label", e.target.value); } }),
					) : h(Field, { label: T.label, hint: T.nameHint },
						h("input", { className: "na_input", type: "text", value: values.label, placeholder: "NewAPI", onChange: function (e) { set("label", e.target.value); } }),
					),
					h(Field, { label: T.flavor, hint: (values.flavor && FLAVOR_INFO[values.flavor]) ? FLAVOR_INFO[values.flavor].hint : T.flavorHint },
						h("select", { className: "na_input", value: values.flavor, onChange: function (e) { set("flavor", e.target.value); } },
							!isDefault ? h("option", { value: "" }, T.inherit) : null,
							GATEWAY_FLAVORS.map(function (f) { return h("option", { key: f, value: f }, FLAVOR_INFO[f].label); }),
						),
					),
					!isDefault ? h(Field, { label: T.catalogMode, hint: T.catalogHint },
						h("select", { className: "na_input", value: values.catalogMode, onChange: function (e) { set("catalogMode", e.target.value); } },
							h("option", { value: "" }, T.inherit),
							CATALOG_MODES.map(function (m) { return h("option", { key: m, value: m }, m); }),
						),
					) : null,
					!isDefault ? h(Field, { label: T.apiKeyEnv, hint: T.keyEnvHint },
						h("input", { className: "na_input", type: "text", value: values.apiKeyEnv, spellCheck: false, placeholder: "MY_GATEWAY_KEY", onChange: function (e) { set("apiKeyEnv", e.target.value); } }),
					) : null,
					h(Field, { label: T.apiKeyLabel, spanAll: true, hint: T.keyKeepHint },
						h("input", { className: "na_input", type: "password", value: values.apiKey, placeholder: props.keyConfigured ? "••••••••" : T.enterApiKey, onChange: function (e) { set("apiKey", e.target.value); } }),
					),
				),
				h("div", { className: "na_formRow" },
					h("button", { className: "na_btn na_btnPrimary", type: "submit", disabled: !canSave }, saving ? "…" : T.save),
					h("button", { className: "na_btn", type: "button", disabled: !dirty || saving, onClick: function () { setValues(Object.assign({}, base)); setStatus(null); } }, T.reset),
					status ? h("span", { className: "na_badge " + (status.ok ? "na_testOk" : "na_testFail") }, status.label) : null,
				),
			);
		}

		/** One gateway card: connection header + config form + model list. */
		function GatewayCard(props) {
			var gw = props.gateway;
			var models = props.models || [];
			var _c = React.useState(false); var cfgOpen = _c[0]; var setCfgOpen = _c[1];
			var hiddenCount = models.filter(function (m) { return m.disabled === true; }).length;
			var protoTags = protocolTags(gw);
			var flavorInfo = FLAVOR_INFO[gw.flavor || "openai-compatible"] || { label: gw.flavor };
			return h("div", { className: "na_gateway" },
				h("div", { className: "na_gatewayHead" },
					h("span", { className: "na_gatewayName" }, gw.label || gw.id),
					h("span", { className: "na_tag" }, flavorInfo.label),
					props.isDefault ? h("span", { className: "na_tag" }, T.defaultRoute) : null,
					models.length > 0 ? h("span", { className: "na_tag" }, T.modelsTag(models.length) + (hiddenCount > 0 ? " · " + hiddenCount + " " + T.filterHidden.toLowerCase() : "")) : null,
					h("div", { className: "na_actions" },
						h("button", { className: "na_btn", onClick: props.onTest, disabled: props.testing }, props.testing ? T.testing : T.test),
						h("button", { className: "na_btn", onClick: props.onFetch, disabled: props.fetching }, props.fetching ? T.fetching : T.fetchModels),
						h("button", { className: "na_btn", onClick: function () { setCfgOpen(!cfgOpen); } }, cfgOpen ? T.close : T.gatewayConfig),
						props.isDefault ? null : h("button", { className: "na_btn na_btnDanger", onClick: props.onDelete }, T.delete),
					),
				),
				h("div", { className: "na_meta" },
					h("span", { className: "na_route" }, T.route + ": " + props.route),
					protoTags.map(function (t) { return h("span", { key: t, className: "na_tag" }, t); }),
					gw.baseURL ? h("span", { className: "na_metaUrl" }, gw.baseURL) : null,
					props.credential ? h("span", { className: "na_badge " + (props.credential.configured ? "na_testOk" : "na_keyWarn") },
						props.credential.configured ? T.keySet(props.apiKeyEnv) : T.keyNotSet(props.apiKeyEnv)) : null,
					props.testStatus ? h("span", { className: "na_badge " + (props.testStatus.ok ? "na_testOk" : "na_testFail") }, props.testStatus.label) : null,
				),
				cfgOpen ? h(ConfigForm, {
					gateway: gw, isDefault: props.isDefault, snapshot: props.snapshot,
					keyConfigured: !!(props.credential && props.credential.configured),
					onSave: props.onSaveConfig,
				}) : null,
				h(ModelList, {
					models: models,
					onChange: props.onModelChange,
					onDelete: props.onModelDelete,
					onAdd: props.onAddModel,
				}),
			);
		}

		/** Inline form adding one custom model to a gateway (no open state:
		  * the parent toggles rendering it below the toolbar). */
		function AddModelForm(props) {
			var _id = React.useState(""); var mid = _id[0]; var setMid = _id[1];
			var _nm = React.useState(""); var mname = _nm[0]; var setMname = _nm[1];
			var _pr = React.useState(""); var mproto = _pr[0]; var setMproto = _pr[1];
			var _cw = React.useState(""); var mcw = _cw[0]; var setMcw = _cw[1];
			var _mt = React.useState(""); var mmt = _mt[0]; var setMmt = _mt[1];

			var trimmedId = mid.trim();
			var duplicate = trimmedId.length > 0 && props.models.some(function (m) { return m.id === trimmedId; });
			var badNum = function (s) { return s.length > 0 && (!/^\d+$/.test(s) || Number(s) <= 0); };
			var canSubmit = trimmedId.length > 0 && !duplicate && !badNum(mcw) && !badNum(mmt);

			var submit = function () {
				if (!canSubmit) return;
				var entry = { id: trimmedId, _custom: true };
				if (mname.trim()) entry.name = mname.trim();
				if (mproto) entry.protocol = mproto;
				if (mcw) entry.contextWindow = Number(mcw);
				if (mmt) entry.maxTokens = Number(mmt);
				props.onAdd(entry);
			};
			return h("form", { className: "na_addForm", onSubmit: function (e) { e.preventDefault(); submit(); } },
				h("div", { className: "na_addFormGrid" },
					h(Field, { label: T.modelId, error: duplicate ? T.modelIdExists : null },
						h("input", { className: "na_input" + (duplicate ? " na_inputInvalid" : ""), type: "text", value: mid, spellCheck: false, placeholder: T.modelIdPlaceholder, autoFocus: true, onChange: function (e) { setMid(e.target.value); } }),
					),
					h(Field, { label: T.name },
						h("input", { className: "na_input", type: "text", value: mname, placeholder: T.modelNamePlaceholder, onChange: function (e) { setMname(e.target.value); } }),
					),
					h(Field, { label: T.protocol },
						h("select", { className: "na_input", value: mproto, onChange: function (e) { setMproto(e.target.value); } },
							h("option", { value: "" }, T.protocolAuto("")),
							PROTOCOLS.map(function (p) { return h("option", { key: p, value: p }, p); }),
						),
					),
					h(Field, { label: T.contextWindow, error: badNum(mcw) ? T.numInvalid : null },
						h("input", { className: "na_input" + (badNum(mcw) ? " na_inputInvalid" : ""), type: "number", min: 1, value: mcw, placeholder: "128000", onChange: function (e) { setMcw(e.target.value); } }),
					),
					h(Field, { label: T.maxTokens, error: badNum(mmt) ? T.numInvalid : null },
						h("input", { className: "na_input" + (badNum(mmt) ? " na_inputInvalid" : ""), type: "number", min: 1, value: mmt, placeholder: "32768", onChange: function (e) { setMmt(e.target.value); } }),
					),
				),
				h("div", { className: "na_formRow" },
					h("button", { className: "na_btn na_btnPrimary", type: "submit", disabled: !canSubmit }, T.save),
					h("button", { className: "na_btn", type: "button", onClick: props.onClose }, T.cancel),
				),
			);
		}

		/** Expanded per-model override editor with local state + save/cancel. */
		function ModelEditor(props) {
			var m = props.model;
			var _v = React.useState({
				name: m.name || "",
				protocol: m.protocol || "",
				contextWindow: m.contextWindow != null ? String(m.contextWindow) : "",
				maxTokens: m.maxTokens != null ? String(m.maxTokens) : "",
				reasoningLevels: (m.reasoningLevels || []).join(", "),
			}); var values = _v[0]; var setValues = _v[1];

			var set = function (key, val) { setValues(function (prev) { return Object.assign({}, prev, { [key]: val }); }); };
			var badNum = function (s) { return s.length > 0 && (!/^\d+$/.test(s) || Number(s) <= 0); };
			var errors = {};
			if (badNum(values.contextWindow)) errors.contextWindow = T.numInvalid;
			if (badNum(values.maxTokens)) errors.maxTokens = T.numInvalid;
			var canSave = Object.keys(errors).length === 0;

			var submit = function () {
				if (!canSave) return;
				var next = Object.assign({}, m);
				// name: store only when it differs from what discovery reported
				var name = values.name.trim();
				if (name.length === 0 || name === (m._discoveredName || m.id)) delete next.name;
				else next.name = name;
				if (!values.protocol) delete next.protocol; else next.protocol = values.protocol;
				["contextWindow", "maxTokens"].forEach(function (k) {
					if (values[k] === "") delete next[k]; else next[k] = Number(values[k]);
				});
				var levels = values.reasoningLevels.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
				if (levels.length === 0) delete next.reasoningLevels; else next.reasoningLevels = levels;
				props.onChange(next);
			};

			return h("form", { className: "na_editor", onSubmit: function (e) { e.preventDefault(); submit(); } },
				h("div", { className: "na_editorGrid" },
					h(Field, { label: T.name, spanAll: true, hint: T.nameHint },
						h("input", { className: "na_input", type: "text", value: values.name, placeholder: m._discoveredName || m.id, onChange: function (e) { set("name", e.target.value); } }),
					),
					h(Field, { label: T.protocol },
						h("select", { className: "na_input", value: values.protocol, onChange: function (e) { set("protocol", e.target.value); } },
							h("option", { value: "" }, T.protocolAuto(m._protocol)),
							PROTOCOLS.map(function (p) { return h("option", { key: p, value: p }, p); }),
						),
					),
					h(Field, { label: T.contextWindow, error: errors.contextWindow, hint: m._discoveredContext ? T.discoveredAs(fmtTokens(m._discoveredContext)) : null },
						h("input", { className: "na_input" + (errors.contextWindow ? " na_inputInvalid" : ""), type: "number", min: 1, value: values.contextWindow, placeholder: m._discoveredContext ? String(m._discoveredContext) : "200000", onChange: function (e) { set("contextWindow", e.target.value); } }),
					),
					h(Field, { label: T.maxTokens, error: errors.maxTokens, hint: m._discoveredMax ? T.discoveredAs(fmtTokens(m._discoveredMax)) : null },
						h("input", { className: "na_input" + (errors.maxTokens ? " na_inputInvalid" : ""), type: "number", min: 1, value: values.maxTokens, placeholder: m._discoveredMax ? String(m._discoveredMax) : "32768", onChange: function (e) { set("maxTokens", e.target.value); } }),
					),
					h(Field, { label: T.reasoningLevels, spanAll: true, hint: T.reasoningHint },
						h("input", { className: "na_input", type: "text", value: values.reasoningLevels, spellCheck: false, placeholder: "off, low, medium, high", onChange: function (e) { set("reasoningLevels", e.target.value); } }),
					),
				),
				h("div", { className: "na_formRow" },
					h("button", { className: "na_btn na_btnPrimary", type: "submit", disabled: !canSave }, T.save),
					h("button", { className: "na_btn", type: "button", onClick: props.onClose }, T.cancel),
				),
			);
		}

		/** One model row: id + tags / name + meta / hide / expand / delete. */
		function ModelRow(props) {
			var m = props.model;
			var _e = React.useState(false); var expanded = _e[0]; var setExpanded = _e[1];
			var displayName = m.name || m._discoveredName || "";
			var metaParts = [];
			if (m._protocol) metaParts.push(m._protocol);
			if (m._discoveredContext) metaParts.push(fmtTokens(m._discoveredContext) + " ctx");
			if (m._reasoning) metaParts.push("reasoning");
			var overridden = m.protocol || m.contextWindow || m.maxTokens || m.reasoningLevels || (m.name && m.name !== m._discoveredName);
			var toggleHide = function () {
				var next = Object.assign({}, m);
				if (m.disabled) delete next.disabled; else next.disabled = true;
				props.onChange(next);
			};
			return h("div", { className: "na_modelRow" + (m.disabled ? " na_modelRowHidden" : "") },
				h("span", { className: "na_modelId" }, m.id,
					m.disabled ? h("span", { className: "na_tag" }, T.disabledTag) : null,
					m._custom ? h("span", { className: "na_tag" }, T.custom) : null,
					overridden ? h("span", { className: "na_tag" }, T.overrideBadge) : null,
				),
				h("span", { className: "na_modelNameCol" },
					displayName && displayName !== m.id ? h("span", { className: "na_modelName" }, displayName) : null,
					metaParts.length > 0 ? h("span", { className: "na_modelMeta" }, metaParts.join(" · ")) : null,
				),
				h("button", { className: "na_btn", onClick: toggleHide }, m.disabled ? T.enable : T.disable),
				h("button", { className: "na_btn", onClick: function () { setExpanded(!expanded); } }, expanded ? T.collapse : T.expand),
				m._custom ? h("button", { className: "na_btn na_btnDanger", onClick: function () { props.onDelete(m.id); } }, T.delete) : h("span", null),
				expanded ? h(ModelEditor, {
					model: m,
					onChange: function (next) { props.onChange(next); setExpanded(false); },
					onClose: function () { setExpanded(false); },
				}) : null,
			);
		}

		/** Model list with search + filter + add-custom entry. */
		function ModelList(props) {
			var models = props.models || [];
			var _q = React.useState(""); var query = _q[0]; var setQuery = _q[1];
			var _f = React.useState(""); var filter = _f[0]; var setFilter = _f[1];
			var _a = React.useState(false); var addOpen = _a[0]; var setAddOpen = _a[1];
			var q = query.trim().toLowerCase();
			var hiddenCount = models.filter(function (m) { return m.disabled === true; }).length;
			var customCount = models.filter(function (m) { return m._custom === true; }).length;
			var visible = models.filter(function (m) {
				if (filter === "hidden" && m.disabled !== true) return false;
				if (filter === "custom" && m._custom !== true) return false;
				if (q.length === 0) return true;
				var hay = (m.id + " " + (m.name || "") + " " + (m._discoveredName || "")).toLowerCase();
				return hay.indexOf(q) !== -1;
			});
			return h("div", { className: "na_models" },
				h("div", { className: "na_toolbar" },
					h("input", { className: "na_input na_search", type: "search", value: query, placeholder: T.searchPlaceholder, onChange: function (e) { setQuery(e.target.value); } }),
					h("select", { className: "na_input", value: filter, onChange: function (e) { setFilter(e.target.value); } },
						h("option", { value: "" }, T.filterAll + " · " + models.length),
						hiddenCount > 0 || filter === "hidden" ? h("option", { value: "hidden" }, T.filterHidden + " · " + hiddenCount) : null,
						customCount > 0 || filter === "custom" ? h("option", { value: "custom" }, T.filterCustom + " · " + customCount) : null,
					),
					h("span", { style: { marginLeft: "auto" } },
						h("button", { className: "na_btn", onClick: function () { setAddOpen(!addOpen); } }, addOpen ? T.cancel : "+ " + T.addModel),
					),
				),
				addOpen ? h(AddModelForm, {
					models: models,
					onAdd: function (entry) { props.onAdd(entry); setAddOpen(false); },
					onClose: function () { setAddOpen(false); },
				}) : null,
				models.length === 0 ? h("div", { className: "na_empty" }, T.noModels) :
					visible.length === 0 ? h("div", { className: "na_empty" }, T.noMatch) :
					visible.map(function (m) {
						return h(ModelRow, { key: m.id, model: m, onChange: props.onChange, onDelete: props.onDelete });
					}),
			);
		}

		/**
		 * Inline form to add a new gateway to the gateways array. Starts from
		 * a gateway-type template (newapi / litellm / higress / OpenAI-
		 * compatible / fully custom); the custom template replaces the single
		 * base URL with per-protocol full endpoint URLs — empty ones stay
		 * disabled ("没填的就是没有").
		 */
		function AddGatewayForm(props) {
			var existingIds = props.existingIds || [];
			var _o = React.useState(false); var open = _o[0]; var setOpen = _o[1];
			var _id = React.useState(""); var gwId = _id[0]; var setGwId = _id[1];
			var _lb = React.useState(""); var gwLabel = _lb[0]; var setGwLabel = _lb[1];
			var _u = React.useState(""); var gwURL = _u[0]; var setGwURL = _u[1];
			var _p = React.useState({ openaiURL: "", responsesURL: "", anthropicURL: "" }); var protoURLs = _p[0]; var setProtoURLs = _p[1];
			var _fl = React.useState("newapi"); var gwFlavor = _fl[0]; var setGwFlavor = _fl[1];
			var _ke = React.useState(""); var gwKeyEnv = _ke[0]; var setGwKeyEnv = _ke[1];
			var _kk = React.useState(""); var gwKey = _kk[0]; var setGwKey = _kk[1];
			var _st = React.useState(null); var status = _st[0]; var setStatus = _st[1];
			var _ut = React.useState(false); var urlTouched = _ut[0]; var setUrlTouched = _ut[1];
			var _tr = React.useState(false); var tried = _tr[0]; var setTried = _tr[1];

			var isCustom = gwFlavor === "custom";
			var flavorInfo = FLAVOR_INFO[gwFlavor] || FLAVOR_INFO["newapi"];
			var sid = sanitizeId(gwId);
			var trimmedURL = gwURL.trim();
			var errors = {};
			if (gwId.length > 0 && sid.length === 0) errors.id = T.idInvalid;
			else if (sid.length > 0 && existingIds.indexOf(sid) !== -1) errors.id = T.idExists;
			var customFilled = false;
			if (isCustom) {
				PROTOCOL_URL_KEYS.forEach(function (k) {
					var v = (protoURLs[k] || "").trim();
					if (v.length === 0) return;
					customFilled = true;
					if (!validURL(v)) errors[k] = T.urlInvalid;
				});
			} else if (trimmedURL.length === 0) {
				if (urlTouched || tried) errors.baseURL = T.urlRequired;
			} else if (!validURL(trimmedURL)) {
				errors.baseURL = T.urlInvalid;
			}
			var canSubmit = sid.length > 0 && !errors.id && Object.keys(errors).length === 0
				&& (isCustom ? customFilled : validURL(trimmedURL));

			var close = function () { setOpen(false); setStatus(null); setTried(false); };
			var submit = function () {
				setTried(true);
				if (!canSubmit) return;
				setStatus(null);
				var entry = {
					id: sid,
					label: gwLabel.trim() || undefined,
					flavor: gwFlavor,
					apiKeyEnv: gwKeyEnv.trim() || undefined,
					apiKey: gwKey || undefined,
				};
				if (isCustom) {
					PROTOCOL_URL_KEYS.forEach(function (k) {
						var v = (protoURLs[k] || "").trim().replace(/\/+$/, "");
						if (v.length > 0) entry[k] = v;
					});
				} else {
					entry.baseURL = trimmedURL.replace(/\/+$/, "");
				}
				props.onAdd(entry).then(function (result) {
					if (result.ok) {
						setGwId(""); setGwLabel(""); setGwURL(""); setGwFlavor("newapi"); setGwKeyEnv(""); setGwKey("");
						setProtoURLs({ openaiURL: "", responsesURL: "", anthropicURL: "" });
						setUrlTouched(false); setTried(false);
						close();
					} else { setStatus(result); }
				});
			};
			var setProtoURL = function (key, val) {
				setProtoURLs(function (prev) { return Object.assign({}, prev, { [key]: val }); });
			};

			if (!open) return h("button", { className: "na_btn na_btnPrimary", onClick: function () { setOpen(true); setStatus(null); } }, "+ " + T.addGateway);
			return h("form", { className: "na_addForm", onSubmit: function (e) { e.preventDefault(); submit(); } },
				h("div", { className: "na_muted" }, T.addGatewayHint),
				h("div", { className: "na_field" },
					h("label", { className: "na_fieldLabel" }, T.flavor),
					h("div", { className: "na_tplRow", role: "radiogroup" },
						GATEWAY_FLAVORS.map(function (f) {
							return h("button", {
								key: f, type: "button", className: "na_tpl" + (gwFlavor === f ? " na_tplOn" : ""),
								"aria-pressed": gwFlavor === f, onClick: function () { setGwFlavor(f); setStatus(null); },
							}, FLAVOR_INFO[f].label);
						}),
					),
					h("span", { className: "na_hint" }, flavorInfo.hint),
				),
				h("div", { className: "na_addFormGrid" },
					h(Field, { label: T.gatewayId, error: errors.id, hint: sid ? T.idPreview(sid) : T.idInvalid },
						h("input", { className: "na_input" + (errors.id ? " na_inputInvalid" : ""), type: "text", value: gwId, spellCheck: false, placeholder: T.idPlaceholder, onChange: function (e) { setGwId(e.target.value); } }),
					),
					h(Field, { label: T.label },
						h("input", { className: "na_input", type: "text", value: gwLabel, placeholder: T.labelPlaceholder, onChange: function (e) { setGwLabel(e.target.value); } }),
					),
					!isCustom ? h(Field, { label: T.baseURL, error: errors.baseURL },
						h("input", { className: "na_input" + (errors.baseURL ? " na_inputInvalid" : ""), type: "text", value: gwURL, spellCheck: false, placeholder: flavorInfo.url || T.urlPlaceholder, onBlur: function () { setUrlTouched(true); }, onChange: function (e) { setGwURL(e.target.value); } }),
					) : null,
					isCustom ? PROTOCOL_URL_KEYS.map(function (k) {
						var info = PROTOCOL_URL_INFO[k];
						// Invalid URLs flag immediately; "at least one" once the user
						// is actually configuring (id typed or submit attempted) —
						// a completely empty form stays calm.
						var askOne = k === "openaiURL" && !customFilled && (tried || sid.length > 0);
						var err = errors[k] !== undefined ? errors[k] : (askOne ? T.customNeedOne : null);
						return h(Field, { key: k, label: info.label, error: err, hint: info.hint },
							h("input", { className: "na_input" + (err ? " na_inputInvalid" : ""), type: "text", value: protoURLs[k], spellCheck: false, placeholder: info.ph, onChange: function (e) { setProtoURL(k, e.target.value); } }),
						);
					}) : null,
					h(Field, { label: T.apiKeyEnv, hint: T.keyEnvHint },
						h("input", { className: "na_input", type: "text", value: gwKeyEnv, spellCheck: false, placeholder: "MY_GATEWAY_KEY", onChange: function (e) { setGwKeyEnv(e.target.value); } }),
					),
					h(Field, { label: T.apiKeyLabel, hint: T.keyKeepHint },
						h("input", { className: "na_input", type: "password", value: gwKey, placeholder: T.enterApiKey, onChange: function (e) { setGwKey(e.target.value); } }),
					),
				),
				h("div", { className: "na_formRow" },
					h("button", { className: "na_btn na_btnPrimary", type: "submit", disabled: !canSubmit }, T.save),
					h("button", { className: "na_btn", type: "button", onClick: close }, T.cancel),
					status && !status.ok ? h("span", { className: "na_badge na_testFail" }, status.label) : null,
				),
			);
		}

		/** The full settings section component. */
		function GatewayModelsSection(props) {
			var api = props.api;
			var _s = React.useState(null); var snapshot = _s[0]; var setSnapshot = _s[1];
			var _f = React.useState({}); var fetching = _f[0]; var setFetching = _f[1];
			var _t = React.useState({}); var testing = _t[0]; var setTesting = _t[1];
			var _ts = React.useState({}); var testStatus = _ts[0]; var setTestStatus = _ts[1];
			var _cr = React.useState({}); var credentials = _cr[0]; var setCredentials = _cr[1];
			// Latest-known snapshot, updated synchronously by every write so
			// consecutive mutations inside one load() round-trip do not read a
			// stale closure and drop each other (writeModels & friends).
			// simplify: settings requests on one connection are applied in
			// order; truly concurrent out-of-order applies would still need a
			// server-side compare-and-swap.
			var snapRef = React.useRef(null);

			var load = React.useCallback(function () {
				api.settings.describe({}).then(function (res) {
					var nsList = res && res.result && res.result.ok ? (res.result.value.namespaces || []) : [];
					var desc = nsList.find(function (n) { return n.ns === NS; });
					var snap = desc ? desc.value || {} : {};
					setSnapshot(snap);
					snapRef.current = snap;
					// Collect all credential refs (default + each gateway's apiKeyEnv).
					var refs = [snap.apiKeyEnv || "NEWAPI_API_KEY"];
					(snap.gateways || []).forEach(function (gw) {
						if (gw.apiKeyEnv && refs.indexOf(gw.apiKeyEnv) === -1) refs.push(gw.apiKeyEnv);
					});
					return api.credentials.describe({ refs: refs }).then(function (cres) {
						var creds = (cres && cres.result && cres.result.ok) ? (cres.result.value.credentials || {}) : {};
						setCredentials(creds);
					}).catch(function () { setCredentials({}); });
				}).catch(function () { setSnapshot({}); });
			}, [api]);

			React.useEffect(function () { ensureStyles(); load(); }, [load]);

			if (snapshot === null) return h("div", { className: "na_section" }, h("p", { className: "na_muted" }, "…"));

			var gateways = snapshot.gateways || [];
			var defaultModels = snapshot.models || [];
			var defaultKeyEnv = snapshot.apiKeyEnv || "NEWAPI_API_KEY";

			/** Mutate one path op into the settings namespace; always reload
			  * afterwards (success resyncs the ref, failure rolls it back). */
			var mutate = function (ops) {
				return api.settings.mutate({ ns: NS, ops: ops }).then(function (res) {
					if (!(res && res.result && res.result.ok)) {
						console.warn("llm-newapi: settings write failed", res && res.result && res.result.error);
						load();
						return false;
					}
					load();
					return true;
				}).catch(function (err) {
					console.warn("llm-newapi: settings write failed", err);
					load();
					return false;
				});
			};

			/** Latest gateways array from the ref (survives the load round-trip). */
			var currentGateways = function () {
				return (snapRef.current && snapRef.current.gateways) || [];
			};
			/** Optimistically sync the ref's gateways before the write settles. */
			var syncGateways = function (next) {
				snapRef.current = Object.assign({}, snapRef.current || {}, { gateways: next });
			};
			var syncModels = function (next) {
				snapRef.current = Object.assign({}, snapRef.current || {}, { models: next });
			};

			/** Write a model entry (default gateway → root `models`, else
			  * gateways[i].models). Reads and updates the ref synchronously so
			  * back-to-back edits do not lose each other. */
			var writeModels = function (gwIdx, transform) {
				var snap = snapRef.current || {};
				if (gwIdx === -1) {
					var nextModels = transform(snap.models || []);
					syncModels(nextModels);
					return mutate([{ op: "set", path: ["models"], value: nextModels }]);
				}
				var gws = snap.gateways || [];
				var nextGateways = gws.slice();
				nextGateways[gwIdx] = Object.assign({}, gws[gwIdx], { models: transform((gws[gwIdx] && gws[gwIdx].models) || []) });
				syncGateways(nextGateways);
				return mutate([{ op: "set", path: ["gateways"], value: nextGateways }]);
			};

			/** Discover models for one gateway (test = same call, no write).
			  * An empty baseURL (URL-addressed custom gateway) is sent as
			  * absent so the host uses its configured discovery base. */
			var discover = function (gwIdx, baseURL, provider) {
				return api.llm.discoverModels({ settingsNs: NS, provider: provider, baseURL: baseURL || undefined, apiKey: undefined }).then(function (res) {
					if (!(res && res.result && res.result.ok)) {
						var raw = res && res.result && res.result.error;
						var msg = typeof raw === "string" ? raw : (raw && raw.message) || "";
						throw new Error(msg || T.testFail);
					}
					return (res.result.value.models || []);
				});
			};

			var fetchModels = function (gwIdx) {
				var snap = snapRef.current || {};
				var gws = snap.gateways || [];
				var key = gwIdx === -1 ? "default" : String(gws[gwIdx].id);
				var gw = gwIdx === -1 ? { baseURL: snap.baseURL } : gws[gwIdx];
				var provider = gwIdx === -1 ? "newapi" : "gateway:" + gw.id;
				setFetching(function (prev) { return Object.assign({}, prev, { [key]: true }); });
				discover(gwIdx, gw.baseURL, provider).then(function (found) {
					// Keep the stored list aligned with what the picker will show:
					// drop entries matched by the configured exclude patterns.
					var patterns = (snap.excludePatterns || []).map(function (p) {
						try { return new RegExp(p); } catch (e) { return null; }
					}).filter(Boolean);
					var discovered = found
						.filter(function (m) { return !patterns.some(function (re) { return re.test(m.id); }); })
						.map(function (m) { return { id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, protocol: m.protocol, reasoning: m.reasoning }; });
					writeModels(gwIdx, function (arr) { return mergeDiscovered(arr, discovered); });
					if (discovered.length === 0) {
						var emptyLabel = found.length > 0 ? T.allFiltered : T.testEmpty;
						setTestStatus(function (prev) { return Object.assign({}, prev, { [key]: { ok: false, label: emptyLabel } }); });
					} else {
						setTestStatus(function (prev) { return Object.assign({}, prev, { [key]: { ok: true, label: T.syncedN(discovered.length) } }); });
					}
				}).catch(function (err) {
					var msg = (err && err.message) || String(err || "");
					setTestStatus(function (prev) { return Object.assign({}, prev, { [key]: { ok: false, label: T.testFail + (msg ? ": " + msg.slice(0, 80) : "") } }); });
				}).finally(function () {
					setFetching(function (prev) { var next = Object.assign({}, prev); delete next[key]; return next; });
				});
			};

			/** Test connectivity to one gateway without mutating stored settings. */
			var testConnection = function (gwIdx) {
				var snap = snapRef.current || {};
				var gws = snap.gateways || [];
				var key = gwIdx === -1 ? "default" : String(gws[gwIdx].id);
				var gw = gwIdx === -1 ? { baseURL: snap.baseURL } : gws[gwIdx];
				var provider = gwIdx === -1 ? "newapi" : "gateway:" + gw.id;
				setTesting(function (prev) { return Object.assign({}, prev, { [key]: true }); });
				setTestStatus(function (prev) { var next = Object.assign({}, prev); delete next[key]; return next; });
				discover(gwIdx, gw.baseURL, provider).then(function (found) {
					setTestStatus(function (prev) {
						return Object.assign({}, prev, { [key]: { ok: found.length > 0, label: found.length > 0 ? T.testOkN(found.length) : T.testEmpty } });
					});
				}).catch(function (err) {
					var msg = (err && err.message) || String(err || "");
					setTestStatus(function (prev) {
						return Object.assign({}, prev, { [key]: { ok: false, label: T.testFail + (msg ? ": " + msg.slice(0, 80) : "") } });
					});
				}).finally(function () {
					setTesting(function (prev) { var next = Object.assign({}, prev); delete next[key]; return next; });
				});
			};

			/**
			 * Save gateway config. `changes` carries only fields the user
			 * actually edited (absent = untouched; "" = clear/inherit: root
			 * fields are unset, per-gateway fields are deleted from the
			 * entry). An API-key-only save writes no settings ops at all.
			 * Returns a Promise<{ok, label}>.
			 */
			var saveGatewayConfig = function (gwIdx, changes) {
				var snap = snapRef.current || {};
				var defaultEnv = snap.apiKeyEnv || "NEWAPI_API_KEY";
				var writes = [];
				if (gwIdx === -1) {
					var ops = [];
					if (changes.baseURL !== undefined) {
						ops.push(changes.baseURL.length > 0
							? { op: "set", path: ["baseURL"], value: changes.baseURL }
							: { op: "unset", path: ["baseURL"] });
					}
					if (changes.label !== undefined) {
						ops.push(changes.label.length > 0
							? { op: "set", path: ["label"], value: changes.label }
							: { op: "unset", path: ["label"] });
					}
					if (changes.flavor !== undefined && changes.flavor.length > 0) {
						ops.push({ op: "set", path: ["flavor"], value: changes.flavor });
					}
					PROTOCOL_URL_KEYS.forEach(function (k) {
						if (changes[k] === undefined) return;
						ops.push(changes[k].length > 0
							? { op: "set", path: [k], value: changes[k] }
							: { op: "unset", path: [k] });
					});
					if (ops.length > 0) writes.push(api.settings.mutate({ ns: NS, ops: ops }));
					if (changes.apiKey !== undefined) writes.push(api.credentials.set({ ref: defaultEnv, value: changes.apiKey }));
					// Optimistically sync the ref; load() reconciles after settle.
					var nextSnap = Object.assign({}, snap);
					if (changes.baseURL !== undefined) { if (changes.baseURL.length > 0) nextSnap.baseURL = changes.baseURL; else delete nextSnap.baseURL; }
					if (changes.label !== undefined) { if (changes.label.length > 0) nextSnap.label = changes.label; else delete nextSnap.label; }
					if (changes.flavor !== undefined && changes.flavor.length > 0) nextSnap.flavor = changes.flavor;
					PROTOCOL_URL_KEYS.forEach(function (k) {
						if (changes[k] === undefined) return;
						if (changes[k].length > 0) nextSnap[k] = changes[k]; else delete nextSnap[k];
					});
					snapRef.current = nextSnap;
				} else {
					var gws = snap.gateways || [];
					var gw = gws[gwIdx] || {};
					var updated = Object.assign({}, gw);
					var touched = false;
					var setOrDelete = function (key, value) {
						if (value.length > 0) updated[key] = value; else delete updated[key];
						touched = true;
					};
					if (changes.baseURL !== undefined) setOrDelete("baseURL", changes.baseURL);
					PROTOCOL_URL_KEYS.forEach(function (k) {
						if (changes[k] !== undefined) setOrDelete(k, changes[k]);
					});
					if (changes.label !== undefined) {
						setOrDelete("label", changes.label);
					}
					if (changes.apiKeyEnv !== undefined) {
						setOrDelete("apiKeyEnv", changes.apiKeyEnv);
					}
					if (changes.flavor !== undefined) {
						setOrDelete("flavor", changes.flavor);
					}
					if (changes.catalogMode !== undefined) {
						setOrDelete("catalogMode", changes.catalogMode);
					}
					if (touched) {
						var nextGateways = gws.slice();
						nextGateways[gwIdx] = updated;
						writes.push(api.settings.mutate({ ns: NS, ops: [{ op: "set", path: ["gateways"], value: nextGateways }] }));
						syncGateways(nextGateways);
					}
					if (changes.apiKey !== undefined) {
						var keyRef = changes.apiKeyEnv || gw.apiKeyEnv || defaultEnv;
						writes.push(api.credentials.set({ ref: keyRef, value: changes.apiKey }));
					}
				}
				return Promise.all(writes).then(function (results) {
					var ok = results.every(function (r) { return r && r.result && r.result.ok; });
					load(); // resync the ref with the persisted truth (success or not)
					return { ok: ok, label: ok ? T.configSaved : T.configSaveFail };
				}).catch(function () {
					load();
					return { ok: false, label: T.configSaveFail };
				});
			};

			/** Add a new gateway entry (plus its API key credential, if given). */
			var addGateway = function (spec) {
				var gws = currentGateways();
				if (gws.some(function (gw) { return gw.id === spec.id; })) {
					return Promise.resolve({ ok: false, label: T.idExists });
				}
				var entry = { id: spec.id };
				if (spec.label) entry.label = spec.label;
				if (spec.flavor) entry.flavor = spec.flavor;
				if (spec.apiKeyEnv) entry.apiKeyEnv = spec.apiKeyEnv;
				if (spec.baseURL) entry.baseURL = spec.baseURL;
				PROTOCOL_URL_KEYS.forEach(function (k) {
					if (spec[k]) entry[k] = spec[k];
				});
				var nextGateways = gws.concat([entry]);
				syncGateways(nextGateways);
				var writes = [
					api.settings.mutate({ ns: NS, ops: [{ op: "set", path: ["gateways"], value: nextGateways }] }),
				];
				if (spec.apiKey !== undefined && spec.apiKey.length > 0) {
					var keyEnv = (snapRef.current && snapRef.current.apiKeyEnv) || "NEWAPI_API_KEY";
					writes.push(api.credentials.set({ ref: spec.apiKeyEnv || keyEnv, value: spec.apiKey }));
				}
				return Promise.all(writes).then(function (results) {
					var ok = results.every(function (r) { return r && r.result && r.result.ok; });
					load();
					return { ok: ok, label: ok ? T.configSaved : T.configSaveFail };
				}).catch(function () {
					load();
					return { ok: false, label: T.configSaveFail };
				});
			};

			/** Delete one additional gateway after an explicit confirm. */
			var deleteGateway = function (gwIdx) {
				if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(T.confirmDelete)) return;
				var nextGateways = currentGateways().slice();
				nextGateways.splice(gwIdx, 1);
				syncGateways(nextGateways);
				mutate([{ op: "set", path: ["gateways"], value: nextGateways }]);
			};

			return h("div", { className: "na_section" },
				h("h2", { className: "na_title" }, T.title),
				h("p", { className: "na_intro" }, T.intro),
				// Default gateway (legacy flat fields)
				h(GatewayCard, {
					key: "default",
					gateway: {
						id: "default", label: snapshot.label || "NewAPI", flavor: snapshot.flavor || "newapi", baseURL: snapshot.baseURL,
						openaiURL: snapshot.openaiURL, responsesURL: snapshot.responsesURL, anthropicURL: snapshot.anthropicURL,
					},
					models: defaultModels, isDefault: true, route: "newapi", snapshot: snapshot,
					fetching: fetching.default, onFetch: function () { fetchModels(-1); },
					testing: testing.default, onTest: function () { testConnection(-1); },
					testStatus: testStatus.default,
					apiKeyEnv: defaultKeyEnv,
					credential: credentials[defaultKeyEnv],
					onSaveConfig: function (v) { return saveGatewayConfig(-1, v); },
					onModelChange: function (entry) { writeModels(-1, function (arr) { return upsertModel(arr, entry); }); },
					onModelDelete: function (id) { writeModels(-1, function (arr) { return arr.filter(function (m) { return m.id !== id; }); }); },
					onAddModel: function (entry) { writeModels(-1, function (arr) { return upsertModel(arr, entry); }); },
				}),
				// Additional gateways
				gateways.map(function (gw, i) {
					return h(GatewayCard, {
						key: gw.id || i,
						gateway: gw, models: gw.models || [], route: "gateway:" + gw.id,
						fetching: fetching[gw.id], onFetch: function () { fetchModels(i); },
						testing: testing[gw.id], onTest: function () { testConnection(i); },
						testStatus: testStatus[gw.id],
						apiKeyEnv: gw.apiKeyEnv || defaultKeyEnv,
						credential: credentials[gw.apiKeyEnv || defaultKeyEnv],
						onSaveConfig: function (v) { return saveGatewayConfig(i, v); },
						onDelete: function () { deleteGateway(i); },
						onModelChange: function (entry) { writeModels(i, function (arr) { return upsertModel(arr, entry); }); },
						onModelDelete: function (id) { writeModels(i, function (arr) { return arr.filter(function (m) { return m.id !== id; }); }); },
						onAddModel: function (entry) { writeModels(i, function (arr) { return upsertModel(arr, entry); }); },
					});
				}),
				// Add gateway form
				h(AddGatewayForm, { onAdd: addGateway, existingIds: gateways.map(function (gw) { return gw.id; }) }),
			);
		}

		var inject = ["slots", "connection"];

		function apply(ctx) {
			var slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("settings.section", function () {
				slots.register({
					name: "settings.section",
					id: "newapi-gateways",
					order: 20,
					label: function () { return T.nav; },
					inject: function () { return { api: ctx.get("connection").api }; },
				}, function (props) {
					return React.createElement(GatewayModelsSection, { api: props.api });
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// Pure helpers exported for the client render/merge unit tests.
		exports.mergeDiscovered = mergeDiscovered;
		exports.upsertModel = upsertModel;
		return module.exports;
	}
});
