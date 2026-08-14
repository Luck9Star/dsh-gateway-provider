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
			save: "保存", cancel: "取消", delete: "删除", label: "名称", flavor: "网关标签",
			baseURL: "基础地址", apiKeyEnv: "API Key 变量名", noModels: "暂无模型，点击「拉取模型」获取。",
			id: "模型 ID", gatewayId: "网关 ID", apply: "应用", close: "关闭", confirmDelete: "确认删除？",
			test: "测试", testing: "测试中…",
			testOk: "✓ 已连接", testOkN: function (n) { return "✓ 已连接 — " + n + " 个模型"; },
			testFail: "✗ 连接失败", testEmpty: "✗ 无模型",
			saveConfig: "保存配置", configSaved: "✓ 已保存", configSaveFail: "✗ 保存失败",
			keySet: "✓ Key 已设置", keyNotSet: "⚠ 未设置 Key",
			enterBaseURL: "https://your-gateway.com", enterApiKey: "sk-...",
			gatewayConfig: "网关配置", apiKeyLabel: "API Key", saveBtn: "保存",
			addGatewayHint: "添加额外的网关（每个成为独立的 gateway:<id> 路由）",
			idPlaceholder: "my-gateway", labelPlaceholder: "我的网关", urlPlaceholder: "https://...",
			keyEnvHint: "留空则继承默认网关的 Key",
		} : {
			nav: "Gateway Models", title: "Gateway Model Management", intro: "Manage OpenAI-compatible gateway model lists, protocols, and overrides.",
			gateways: "Gateways", addGateway: "Add Gateway", defaultRoute: "Default gateway", custom: "Custom",
			models: "Models", fetchModels: "Fetch Models", addModel: "Add Custom Model", fetching: "Fetching…",
			disabled: "hidden", enable: "Show", disable: "Hide", override: "Override", protocol: "Protocol",
			contextWindow: "Context window", maxTokens: "Output cap", reasoningLevels: "Reasoning levels",
			save: "Save", cancel: "Cancel", delete: "Delete", label: "Label", flavor: "Gateway label",
			baseURL: "Base URL", apiKeyEnv: "API Key env var", noModels: "No models yet — click Fetch Models.",
			id: "Model ID", gatewayId: "Gateway ID", apply: "Apply", close: "Close", confirmDelete: "Confirm delete?",
			test: "Test", testing: "Testing…",
			testOk: "✓ Connected", testOkN: function (n) { return "✓ Connected — " + n + " models"; },
			testFail: "✗ Connection failed", testEmpty: "✗ No models",
			saveConfig: "Save config", configSaved: "✓ Saved", configSaveFail: "✗ Save failed",
			keySet: "✓ Key set", keyNotSet: "⚠ No key set",
			enterBaseURL: "https://your-gateway.com", enterApiKey: "sk-...",
			gatewayConfig: "Gateway Config", apiKeyLabel: "API Key", saveBtn: "Save",
			addGatewayHint: "Add an extra gateway (each becomes its own gateway:<id> route)",
			idPlaceholder: "my-gateway", labelPlaceholder: "My Gateway", urlPlaceholder: "https://...",
			keyEnvHint: "Leave empty to inherit the default gateway's Key",
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
				".na_testBadge{font-size:12px;padding:2px 8px;border-radius:8px;white-space:nowrap}",
				".na_testOk{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}",
				".na_testFail{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}",
				".na_config{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2)}",
				".na_configSave{display:flex;flex-direction:column;gap:4px;align-items:flex-start}",
				".na_addForm{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
				".na_addFormGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}",
			].join("\n");
			document.head.appendChild(tag);
		}

		function h(type, props) {
			var args = [type, props || null];
			for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
			return React.createElement.apply(React, args);
		}

		/** One gateway card with config editing + model list. */
		function GatewayCard(props) {
			var gw = props.gateway;
			var models = props.models || [];
			var onFetch = props.onFetch;
			var onTest = props.onTest;
			var fetching = props.fetching;
			var testing = props.testing;
			var testStatus = props.testStatus;
			var isDefault = props.isDefault;
			var apiKeyEnv = props.apiKeyEnv;
			var credential = props.credential;
			var onSaveConfig = props.onSaveConfig;
			var _cfg = React.useState(false); var cfgOpen = _cfg[0]; var setCfgOpen = _cfg[1];
			var _bu = React.useState(""); var cfgBaseURL = _bu[0]; var setCfgBaseURL = _bu[1];
			var _bk = React.useState(""); var cfgKey = _bk[0]; var setCfgKey = _bk[1];
			var _bl = React.useState(""); var cfgLabel = _bl[0]; var setCfgLabel = _bl[1];
			var _be = React.useState(""); var cfgKeyEnv = _be[0]; var setCfgKeyEnv = _be[1];
			var _cs = React.useState(null); var cfgStatus = _cs[0]; var setCfgStatus = _cs[1];
			var _sv = React.useState(false); var cfgSaving = _sv[0]; var setCfgSaving = _sv[1];
			return h("div", { className: "na_gateway" },
				h("div", { className: "na_gatewayHead" },
					h("span", { className: "na_gatewayName" }, gw.label || gw.id),
					h("span", { className: "na_tag" }, gw.flavor || "openai-compatible"),
					isDefault ? h("span", { className: "na_tag" }, T.defaultRoute) : null,
					h("div", { className: "na_actions" },
						h("button", { className: "na_btn", onClick: onTest, disabled: testing }, testing ? T.testing : T.test),
						h("button", { className: "na_btn", onClick: onFetch, disabled: fetching }, fetching ? T.fetching : T.fetchModels),
						h("button", { className: "na_btn", onClick: function () { setCfgOpen(!cfgOpen); setCfgStatus(null); } }, cfgOpen ? T.close : T.gatewayConfig),
						isDefault ? null : h("button", { className: "na_btn na_btnDanger", onClick: props.onDelete }, T.delete),
					),
				),
				h("div", { className: "na_muted" }, gw.baseURL || "—"),
				credential ? h("span", { className: "na_tag " + (credential.configured ? "na_testOk" : "na_testFail"), style: { display: "inline-block", marginTop: 2 } },
					credential.configured ? T.keySet + " (" + apiKeyEnv + ")" : T.keyNotSet + " (" + apiKeyEnv + ")") : null,
				testStatus ? h("div", { className: "na_testBadge " + (testStatus.ok ? "na_testOk" : "na_testFail") }, testStatus.label) : null,
				cfgOpen ? h("div", { className: "na_config" },
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.baseURL),
						h("input", { className: "na_input", type: "text", value: cfgBaseURL, placeholder: gw.baseURL || T.enterBaseURL, onChange: function (e) { setCfgBaseURL(e.target.value); } }),
					),
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.apiKeyLabel + " (" + apiKeyEnv + ")"),
						h("input", { className: "na_input", type: "password", value: cfgKey, placeholder: credential && credential.configured ? "••••••" : T.enterApiKey, onChange: function (e) { setCfgKey(e.target.value); } }),
					),
					h("div", { className: "na_configSave" },
						h("button", { className: "na_btn na_btnPrimary", disabled: cfgSaving, onClick: function () {
							setCfgSaving(true); setCfgStatus(null);
							var changes = { baseURL: cfgBaseURL || undefined, apiKey: cfgKey || undefined };
							if (!isDefault) {
								if (cfgLabel) changes.label = cfgLabel;
								if (cfgKeyEnv) changes.apiKeyEnv = cfgKeyEnv;
							}
							onSaveConfig(changes).then(function (result) {
								setCfgSaving(false);
								setCfgStatus(result);
								if (result.ok) { setCfgKey(""); setCfgBaseURL(""); setCfgLabel(""); setCfgKeyEnv(""); }
							});
						} }, cfgSaving ? "…" : T.saveBtn),
						cfgStatus ? h("span", { className: "na_testBadge " + (cfgStatus.ok ? "na_testOk" : "na_testFail") }, cfgStatus.label) : null,
					),
				) : null,
				(!isDefault && cfgOpen) ? h("div", { className: "na_addFormGrid" },
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.label),
						h("input", { className: "na_input", value: cfgLabel, placeholder: gw.label || gw.id, onChange: function (e) { setCfgLabel(e.target.value); } }),
					),
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.apiKeyEnv),
						h("input", { className: "na_input", value: cfgKeyEnv, placeholder: apiKeyEnv, onChange: function (e) { setCfgKeyEnv(e.target.value); } }),
					),
				) : null,
				h(ModelList, { models: models, gatewayPath: props.gatewayPath, onChange: props.onModelChange, onDelete: props.onModelDelete }),
			);
		}

		/** Inline form to add a new gateway to the gateways array. */
		function AddGatewayForm(props) {
			var onAdd = props.onAdd;
			var _o = React.useState(false); var open = _o[0]; var setOpen = _o[1];
			var _id = React.useState(""); var gwId = _id[0]; var setGwId = _id[1];
			var _lb = React.useState(""); var gwLabel = _lb[0]; var setGwLabel = _lb[1];
			var _u = React.useState(""); var gwURL = _u[0]; var setGwURL = _u[1];
			var _ke = React.useState(""); var gwKeyEnv = _ke[0]; var setGwKeyEnv = _ke[1];
			var _kk = React.useState(""); var gwKey = _kk[0]; var setGwKey = _kk[1];
			var _err = React.useState(null); var err = _err[0]; var setErr = _err[1];
			var sanitizeId = function (s) { return s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""); };
			var canSubmit = sanitizeId(gwId).length > 0 && gwURL.trim().length > 0;
			var submit = function () {
				setErr(null);
				var id = sanitizeId(gwId);
				if (id.length === 0) { setErr(T.gatewayId + " required"); return; }
				onAdd({
					id: id,
					label: gwLabel.trim() || id,
					baseURL: gwURL.trim().replace(/\/+$/, ""),
					apiKeyEnv: gwKeyEnv.trim() || undefined,
					apiKey: gwKey || undefined,
				}).then(function (result) {
					if (result.ok) {
						setGwId(""); setGwLabel(""); setGwURL(""); setGwKeyEnv(""); setGwKey(""); setOpen(false);
					} else { setErr(result.label); }
				});
			};
			if (!open) return h("button", { className: "na_btn na_btnPrimary", onClick: function () { setOpen(true); setErr(null); } }, "+ " + T.addGateway);
			return h("div", { className: "na_addForm" },
				h("div", { className: "na_muted" }, T.addGatewayHint),
				h("div", { className: "na_addFormGrid" },
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.gatewayId),
						h("input", { className: "na_input", value: gwId, placeholder: T.idPlaceholder, onChange: function (e) { setGwId(e.target.value); } }),
					),
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.label),
						h("input", { className: "na_input", value: gwLabel, placeholder: T.labelPlaceholder, onChange: function (e) { setGwLabel(e.target.value); } }),
					),
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.baseURL),
						h("input", { className: "na_input", value: gwURL, placeholder: T.urlPlaceholder, onChange: function (e) { setGwURL(e.target.value); } }),
					),
				),
				h("div", { className: "na_addFormGrid" },
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.apiKeyEnv),
						h("input", { className: "na_input", value: gwKeyEnv, placeholder: "MY_GATEWAY_KEY", onChange: function (e) { setGwKeyEnv(e.target.value); } }),
						h("span", { className: "na_muted" }, T.keyEnvHint),
					),
					h("div", { className: "na_field" }, h("label", { className: "na_fieldLabel" }, T.apiKeyLabel),
						h("input", { className: "na_input", type: "password", value: gwKey, placeholder: T.enterApiKey, onChange: function (e) { setGwKey(e.target.value); } }),
					),
				),
				h("div", { className: "na_actions" },
					h("button", { className: "na_btn na_btnPrimary", disabled: !canSubmit, onClick: submit }, T.saveBtn),
					h("button", { className: "na_btn", onClick: function () { setOpen(false); setErr(null); } }, T.cancel),
				),
				err ? h("span", { className: "na_testBadge na_testFail" }, err) : null,
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
			var _t = React.useState({}); var testing = _t[0]; var setTesting = _t[1];
			var _ts = React.useState({}); var testStatus = _ts[0]; var setTestStatus = _ts[1];
			var _cr = React.useState({}); var credentials = _cr[0]; var setCredentials = _cr[1];

			var load = React.useCallback(function () {
				api.settings.describe({}).then(function (res) {
					var nsList = res && res.result && res.result.ok ? (res.result.value.namespaces || []) : [];
					var desc = nsList.find(function (n) { return n.ns === NS; });
					var snap = desc ? desc.value || {} : {};
					setSnapshot(snap);
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

			/** Test connectivity to one gateway without mutating stored settings. */
			var testConnection = function (gwIdx) {
				var key = gwIdx === -1 ? "default" : String(gateways[gwIdx].id);
				setTesting(Object.assign({}, testing, { [key]: true }));
				setTestStatus(function (prev) { var next = Object.assign({}, prev); delete next[key]; return next; });
				var gw = gwIdx === -1 ? { baseURL: snapshot.baseURL, apiKeyEnv: snapshot.apiKeyEnv } : gateways[gwIdx];
				api.llm.discoverModels({ settingsNs: NS, provider: gwIdx === -1 ? "newapi" : "gateway:" + gw.id, baseURL: gw.baseURL, apiKey: undefined }).then(function (res) {
					var found = res && res.result && res.result.ok ? (res.result.value.models || []) : [];
					var label = found.length > 0 ? T.testOkN(found.length) : T.testEmpty;
					setTestStatus(Object.assign({}, testStatus, { [key]: { ok: found.length > 0, label: label } }));
				}).catch(function (err) {
					var msg = (err && err.message) || String(err || "");
					setTestStatus(Object.assign({}, testStatus, { [key]: { ok: false, label: T.testFail + (msg ? ": " + msg.slice(0, 80) : "") } }));
				}).finally(function () {
					setTesting(function (prev) {
						var next = Object.assign({}, prev); delete next[key]; return next;
					});
				});
			};

			/**
			 * Save gateway config: writes baseURL/label/apiKeyEnv to settings and
			 * API key to credentials. Returns a Promise<{ok, label}>.
			 */
			var saveGatewayConfig = function (gwIdx, changes) {
				var ops = [];
				if (gwIdx === -1) {
					// Default gateway: flat fields at section root.
					if (changes.baseURL !== undefined && changes.baseURL.length > 0) {
						ops.push({ op: "set", path: ["baseURL"], value: changes.baseURL.replace(/\/+$/, "") });
					}
				} else {
					// Additional gateway: rewrite the whole gateways array element.
					var gw = gateways[gwIdx] || {};
					var updated = Object.assign({}, gw);
					if (changes.baseURL !== undefined && changes.baseURL.length > 0) updated.baseURL = changes.baseURL.replace(/\/+$/, "");
					if (changes.label !== undefined && changes.label.length > 0) updated.label = changes.label;
					if (changes.apiKeyEnv !== undefined && changes.apiKeyEnv.length > 0) updated.apiKeyEnv = changes.apiKeyEnv;
					if (updated !== gw) {
						var nextGateways = gateways.slice();
						nextGateways[gwIdx] = updated;
						ops.push({ op: "set", path: ["gateways"], value: nextGateways });
					}
				}
				// The credential ref: prefer the new apiKeyEnv if being changed, else the current one.
				var keyRef = changes.apiKeyEnv || (gwIdx === -1 ? (snapshot.apiKeyEnv || "NEWAPI_API_KEY") : (gateways[gwIdx].apiKeyEnv || "NEWAPI_API_KEY"));
				var writeSettings = ops.length > 0 ? api.settings.mutate({ ns: NS, ops: ops }) : Promise.resolve({ result: { ok: true } });
				var writeKey = changes.apiKey !== undefined && changes.apiKey.length > 0
					? api.credentials.set({ ref: keyRef, value: changes.apiKey })
					: Promise.resolve({ result: { ok: true } });
				return Promise.all([writeSettings, writeKey]).then(function (results) {
					var settingsOk = results[0] && results[0].result && results[0].result.ok;
					var keyOk = results[1] && results[1].result && results[1].result.ok;
					var ok = settingsOk && keyOk;
					if (ok) load();
					return { ok: ok, label: ok ? T.configSaved : T.configSaveFail };
				}).catch(function () {
					return { ok: false, label: T.configSaveFail };
				});
			};

			/**
			 * Add a new gateway: pushes to the gateways array in settings, and
			 * optionally stores its API key credential if a custom apiKeyEnv was given.
			 */
			var addGateway = function (spec) {
				// Check for duplicate id.
				var existing = (gateways || []).some(function (gw) { return gw.id === spec.id; });
				if (existing) return Promise.resolve({ ok: false, label: "id '" + spec.id + "' " + (ZH ? "已存在" : "already exists") });
				var entry = { id: spec.id, baseURL: spec.baseURL };
				if (spec.label) entry.label = spec.label;
				if (spec.apiKeyEnv) entry.apiKeyEnv = spec.apiKeyEnv;
				var nextGateways = (gateways || []).concat([entry]);
				var writeSettings = api.settings.mutate({ ns: NS, ops: [{ op: "set", path: ["gateways"], value: nextGateways }] });
				var keyRef = spec.apiKeyEnv || "NEWAPI_API_KEY";
				var writeKey = spec.apiKey !== undefined && spec.apiKey.length > 0
					? api.credentials.set({ ref: keyRef, value: spec.apiKey })
					: Promise.resolve({ result: { ok: true } });
				return Promise.all([writeSettings, writeKey]).then(function (results) {
					var settingsOk = results[0] && results[0].result && results[0].result.ok;
					var keyOk = results[1] && results[1].result && results[1].result.ok;
					var ok = settingsOk && keyOk;
					if (ok) load();
					return { ok: ok, label: ok ? T.configSaved : T.configSaveFail };
				}).catch(function () {
					return { ok: false, label: T.configSaveFail };
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
					testing: testing.default, onTest: function () { testConnection(-1); },
					testStatus: testStatus.default,
					apiKeyEnv: snapshot.apiKeyEnv || "NEWAPI_API_KEY",
					credential: credentials[snapshot.apiKeyEnv || "NEWAPI_API_KEY"],
					onSaveConfig: function (changes) { return saveGatewayConfig(-1, changes); },
					onModelChange: onModelChange, onModelDelete: function () {},
				}),
				// Additional gateways
				gateways.map(function (gw, i) {
					return h(GatewayCard, {
						key: gw.id || i, gateway: gw, models: gw.models || [], gatewayPath: ["gateways", String(i)],
						fetching: fetching[gw.id], onFetch: function () { fetchModels(i); },
						testing: testing[gw.id], onTest: function () { testConnection(i); },
						testStatus: testStatus[gw.id],
						apiKeyEnv: gw.apiKeyEnv || "NEWAPI_API_KEY",
						credential: credentials[gw.apiKeyEnv || "NEWAPI_API_KEY"],
						onSaveConfig: function (changes) { return saveGatewayConfig(i, changes); },
						onDelete: function () {
							var nextGateways = gateways.slice();
							nextGateways.splice(i, 1);
							mutate([{ op: "set", path: ["gateways"], value: nextGateways }]);
						},
						onModelChange: onModelChange, onModelDelete: function () {},
					});
				}),
				// Add gateway form
				h(AddGatewayForm, { onAdd: addGateway }),
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
