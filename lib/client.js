/**
 * Client half: a self-built "Gateway Models" settings section.
 *
 * Registers a `settings.section` entry that renders a complete model-
 * management UI for the `llm-newapi` namespace: gateway cards, the discovered
 * model list per gateway, per-model toggle / override / custom-add, and
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
		var GATEWAY_FLAVORS = ["newapi", "litellm", "openai-compatible"];
		var PROTOCOLS = ["openai", "openai-response", "anthropic", "gemini"];

		// ---- i18n (manual zh/en switch; no locale registration needed) ----
		var ZH = (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("zh"));
		var T = ZH ? {
			nav: "网关模型", title: "网关模型管理", intro: "管理 OpenAI 兼容网关的模型列表、接入协议与覆盖设置。",
			gateways: "网关", addGateway: "添加网关", defaultRoute: "默认网关", custom: "自定义",
			models: "模型", fetchModels: "拉取模型", addModel: "添加自定义模型", fetching: "拉取中…",
			disabled: "已隐藏", enable: "显示", disable: "隐藏", override: "覆盖", protocol: "协议",
			contextWindow: "上下文窗口", maxTokens: "输出上限", reasoningLevels: "思考级别",
			save: "保存", cancel: "取消", delete: "删除", label: "名称", flavor: "网关类型",
			baseURL: "基础地址", apiKeyEnv: "API Key 变量名", noModels: "暂无模型，点击「拉取模型」获取。",
			id: "模型 ID", gatewayId: "网关 ID", apply: "应用", close: "关闭", confirmDelete: "确认删除？",
		} : {
			nav: "Gateway Models", title: "Gateway Model Management", intro: "Manage OpenAI-compatible gateway model lists, protocols, and overrides.",
			gateways: "Gateways", addGateway: "Add Gateway", defaultRoute: "Default gateway", custom: "Custom",
			models: "Models", fetchModels: "Fetch Models", addModel: "Add Custom Model", fetching: "Fetching…",
			disabled: "hidden", enable: "Show", disable: "Hide", override: "Override", protocol: "Protocol",
			contextWindow: "Context window", maxTokens: "Output cap", reasoningLevels: "Reasoning levels",
			save: "Save", cancel: "Cancel", delete: "Delete", label: "Label", flavor: "Gateway flavor",
			baseURL: "Base URL", apiKeyEnv: "API Key env var", noModels: "No models yet — click Fetch Models.",
			id: "Model ID", gatewayId: "Gateway ID", apply: "Apply", close: "Close", confirmDelete: "Confirm delete?",
		};

		/** Build a CSS style tag once. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tagId = "dsh-newapi-provider-styles";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
			var tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = [
				".na_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
				".na_title{font-size:16px;font-weight:500;margin:0}",
				".na_intro{color:var(--dsw-alias-label-tertiary);font-size:14px;margin:0}",
				".na_gateway{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
				".na_gatewayHead{display:flex;align-items:center;gap:8px}",
				".na_gatewayName{font-size:14px;font-weight:500}",
				".na_tag{border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:1px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".na_actions{display:flex;gap:6px;margin-left:auto}",
				".na_btn{height:28px;padding:0 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:14px;cursor:pointer;display:inline-flex;align-items:center}",
				".na_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".na_btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}",
				".na_btnDanger{color:var(--dsw-alias-state-error-primary);border:none}",
				".na_btnDanger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}",
				".na_modelRow{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) auto auto;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
				".na_modelId{font-family:var(--ds-font-family-code);font-size:13px;overflow-wrap:anywhere}",
				".na_field{display:flex;flex-direction:column;gap:4px}",
				".na_fieldLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
				".na_input{box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%}",
				".na_modelAdvanced{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;padding:6px 0}",
				".na_toggle{cursor:pointer}",
				".na_muted{color:var(--dsw-alias-label-tertiary);font-size:12px}",
				".na_empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;padding:12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			].join("\n");
			document.head.appendChild(tag);
		}

		function h(type, props) {
			var args = [type, props || null];
			for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
			return React.createElement.apply(React, args);
		}

		/** One gateway card with its model list. */
		function GatewayCard(props) {
			var gw = props.gateway;
			var models = props.models || [];
			var onFetch = props.onFetch;
			var fetching = props.fetching;
			var isDefault = props.isDefault;
			return h("div", { className: "na_gateway" },
				h("div", { className: "na_gatewayHead" },
					h("span", { className: "na_gatewayName" }, gw.label || gw.id),
					h("span", { className: "na_tag" }, gw.flavor || "openai-compatible"),
					isDefault ? h("span", { className: "na_tag" }, T.defaultRoute) : null,
					h("div", { className: "na_actions" },
						h("button", { className: "na_btn", onClick: onFetch, disabled: fetching }, fetching ? T.fetching : T.fetchModels),
						isDefault ? null : h("button", { className: "na_btn na_btnDanger", onClick: props.onDelete }, T.delete),
					),
				),
				h("div", { className: "na_muted" }, gw.baseURL),
				h(ModelList, { models: models, gatewayPath: props.gatewayPath, onChange: props.onModelChange, onDelete: props.onModelDelete }),
			);
		}

		/** The model list with toggle / override / add controls. */
		function ModelList(props) {
			var models = props.models;
			if (models.length === 0) return h("div", { className: "na_empty" }, T.noModels);
			return h("div", null,
				models.map(function (m) {
					return h(ModelRow, { key: m.id, model: m, gatewayPath: props.gatewayPath, onChange: props.onChange, onDelete: props.onDelete });
				}),
			);
		}

		function ModelRow(props) {
			var m = props.model;
			var path = props.gatewayPath.concat(["models"]);
			var _a = React.useState(false); var expanded = _a[0]; var setExpanded = _a[1];
			var toggle = function () { props.onChange(path, m.id, { disabled: !m.disabled }); };
			var update = function (key, val) {
				var patch = Object.assign({}, m);
				if (val === undefined || val === "") delete patch[key];
				else patch[key] = val;
				props.onChange(path, m.id, patch);
			};
			return h("div", { className: "na_modelRow" },
				h("span", { className: "na_modelId" }, m.id),
				h("span", { className: "na_muted" }, m.name || m.id),
				h("button", { className: "na_btn", onClick: toggle }, m.disabled ? T.enable : T.disable),
				h("button", { className: "na_btn", onClick: function () { setExpanded(!expanded); } }, expanded ? "−" : "+"),
				expanded ? h("div", { style: { gridColumn: "1/-1" }, className: "na_modelAdvanced" },
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.protocol),
						h("select", { className: "na_input", value: m.protocol || "", onChange: function (e) { update("protocol", e.target.value || undefined); } },
							h("option", { value: "" }, "—"),
							PROTOCOLS.map(function (p) { return h("option", { key: p, value: p }, p); }),
						),
					),
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.contextWindow),
						h("input", { className: "na_input", type: "number", value: m.contextWindow || "", placeholder: String(m._discoveredContext || ""), onChange: function (e) { update("contextWindow", e.target.value ? Number(e.target.value) : undefined); } }),
					),
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.maxTokens),
						h("input", { className: "na_input", type: "number", value: m.maxTokens || "", placeholder: String(m._discoveredMax || ""), onChange: function (e) { update("maxTokens", e.target.value ? Number(e.target.value) : undefined); } }),
					),
				) : null,
			);
		}

		/** The full settings section component. */
		function GatewayModelsSection(props) {
			var api = props.api;
			var _s = React.useState(null); var snapshot = _s[0]; var setSnapshot = _s[1];
			var _f = React.useState({}); var fetching = _f[0]; var setFetching = _f[1];

			var load = React.useCallback(function () {
				api.settings.describe({}).then(function (res) {
					var nsList = res && res.result && res.result.ok ? (res.result.value.namespaces || []) : [];
					var desc = nsList.find(function (n) { return n.ns === NS; });
					setSnapshot(desc ? desc.value || {} : {});
				}).catch(function () { setSnapshot({}); });
			}, [api]);

			React.useEffect(function () { ensureStyles(); load(); }, [load]);

			if (snapshot === null) return h("div", { className: "na_section" }, h("p", { className: "na_muted" }, "…"));

			var gateways = snapshot.gateways || [];
			var defaultModels = snapshot.models || [];

			/** Mutate one path op into the settings namespace. */
			var mutate = function (ops) {
				return api.settings.mutate({ ns: NS, ops: ops }).then(function (res) {
					if (!(res && res.result && res.result.ok)) {
						console.warn("llm-newapi: settings write failed", res && res.result && res.result.error);
						return;
					}
					load();
				});
			};

			/** Merge/replace one model entry inside an array (keeps the other entries). */
			var mergeModel = function (arr, id, patch) {
				var next = arr.map(function (m) { return m.id === id ? Object.assign({}, m, patch) : m; });
				if (!next.some(function (m) { return m.id === id; })) next.push(Object.assign({ id: id }, patch));
				return next;
			};
			/** Merge a freshly discovered list into the stored catalog: the gateway
			  * is authoritative for id/name/context/maxTokens, while user edits
			  * (disabled/protocol/reasoningLevels/custom name) are preserved. */
			var mergeDiscovered = function (current, discovered) {
				current = current || [];
				var prevById = {};
				var ids = {};
				current.forEach(function (m) { prevById[m.id] = m; });
				discovered.forEach(function (m) { ids[m.id] = true; });
				return discovered.map(function (d) {
					var prev = prevById[d.id];
					if (prev === undefined) return d;
					// A stored custom name wins; otherwise refresh the discovered name.
					var customName = typeof prev._customName === "string" && prev._customName.length > 0;
					return Object.assign({}, prev, d, customName ? { name: prev._customName } : {});
				}).concat(current.filter(function (m) { return ids[m.id] === undefined; }));
			};

			var onModelChange = function (path, id, patch) {
				if (path.length === 1) {
					// Default gateway: the `models` array lives at the section root.
					mutate([{ op: "set", path: ["models"], value: mergeModel(snapshot.models || [], id, patch) }]);
					return;
				}
				// Additional gateway: settings paths cannot address into arrays, so
				// rewrite the whole `gateways` array with the updated element.
				var i = Number(path[1]);
				var gw = gateways[i] || {};
				var nextGateways = gateways.slice();
				nextGateways[i] = Object.assign({}, gw, { models: mergeModel(gw.models || [], id, patch) });
				mutate([{ op: "set", path: ["gateways"], value: nextGateways }]);
			};

			var fetchModels = function (gwIdx) {
				var key = gwIdx === -1 ? "default" : String(gateways[gwIdx].id);
				setFetching(Object.assign({}, fetching, { [key]: true }));
				var gw = gwIdx === -1 ? { baseURL: snapshot.baseURL, apiKeyEnv: snapshot.apiKeyEnv } : gateways[gwIdx];
				api.llm.discoverModels({ settingsNs: NS, provider: gwIdx === -1 ? "newapi" : "gateway:" + gw.id, baseURL: gw.baseURL, apiKey: undefined }).then(function (res) {
					var found = res && res.result && res.result.ok ? (res.result.value.models || []) : [];
					var discovered = found.map(function (m) { return { id: m.id, name: m.name }; });
					if (gwIdx === -1) {
						mutate([{ op: "set", path: ["models"], value: mergeDiscovered(snapshot.models, discovered) }]);
					} else {
						var nextGateways = gateways.slice();
						nextGateways[gwIdx] = Object.assign({}, gateways[gwIdx], { models: mergeDiscovered(gateways[gwIdx].models, discovered) });
						mutate([{ op: "set", path: ["gateways"], value: nextGateways }]);
					}
				}).catch(function () {}).finally(function () {
					setFetching(function (prev) {
						var next = Object.assign({}, prev); delete next[key]; return next;
					});
				});
			};

			return h("div", { className: "na_section" },
				h("h2", { className: "na_title" }, T.title),
				h("p", { className: "na_intro" }, T.intro),
				// Default gateway (legacy flat fields)
				h(GatewayCard, {
					key: "default", gateway: { id: "default", label: snapshot.label || "NewAPI", flavor: snapshot.flavor || "newapi", baseURL: snapshot.baseURL },
					models: defaultModels, isDefault: true, gatewayPath: [],
					fetching: fetching.default, onFetch: function () { fetchModels(-1); },
					onModelChange: onModelChange, onModelDelete: function () {},
				}),
				// Additional gateways
				gateways.map(function (gw, i) {
					return h(GatewayCard, {
						key: gw.id || i, gateway: gw, models: gw.models || [], gatewayPath: ["gateways", String(i)],
						fetching: fetching[gw.id], onFetch: function () { fetchModels(i); },
						onDelete: function () {
							var nextGateways = gateways.slice();
							nextGateways.splice(i, 1);
							mutate([{ op: "set", path: ["gateways"], value: nextGateways }]);
						},
						onModelChange: onModelChange, onModelDelete: function () {},
					});
				}),
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
		return module.exports;
	}
});
