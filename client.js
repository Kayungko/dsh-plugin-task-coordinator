/**
 * dsh-plugin-task-coordinator — client module (0.18.2)
 *
 * Two surfaces:
 *  1. `conversation.session.header.utilities` slot — the "Copy session id"
 *     action (0.8.0), so any session's stable id can be grabbed with one
 *     click and pasted into task_send / task_progress / /tasks.
 *  2. `settings.section` slot (0.18.1) — the first-level "任务编排" settings
 *     page: a GUI editor for the plugin's durable spawn-model default (the
 *     `task-coordinator` settings section installed host-side). Candidates
 *     come from the host's live model catalog (remote.session.modelCatalog —
 *     the same source the GUI model picker renders, so gateway providers
 *     such as a self-hosted mana route appear automatically); writes go
 *     through settingsScope.bind({namespace}) — the same staged-write
 *     channel the native plugin cards use. (0.18.0 shipped this as a
 *     settings.plugins.tab inside the Plugins page; 0.18.1 moved it to a
 *     first-level section per user request.)
 *
 * Localization (0.15.0): strings follow the host's live locale runtime
 * (@deepseek-ai/dsh-client-locale — the same channel the official
 * session-log-export button uses): dictionaries are registered under our own
 * namespace, translations resolve through locale.translate with re-render on
 * every locale/dictionary change (getSnapshot/subscribe is uSES-safe), and
 * any missing piece degrades to the bundled zh strings — never a crash.
 * 0.16.1: the locale runtime connects LAZILY and retries — the locale plugin
 * may load after this bundle, and a one-shot read in apply() missed it while
 * the host still handed the component a `t` prop bound to our namespace that
 * echoes bare keys for unregistered dictionaries (the "header.action" button
 * regression). A bare-key guard around props.t backs the retry up, so a
 * missing dictionary can never render a raw key again.
 * 0.18.1 CRITICAL FIX: the client runner (dsh-cordis-client-runner
 * dynamicCordisContext) gates direct `ctx.serviceName` property access
 * behind the fiber's inject declaration — reading an UNDECLARED service
 * throws, so the 0.16.1 lazy sighting and the 0.18.0 settings tab silently
 * never sighted anything (language switching never actually engaged; the
 * settings selects rendered permanently grey). The sanctioned bypass is
 * `ctx.get(name)` (requireDeclaration=false): every optional service read
 * (locale / settingsScope / remote) now goes through ctx.get() with the
 * plain property kept only as a direct-require fallback for test hosts.
 * The bundle still injects only ["slots"], so older hosts keep the header
 * button working, and every degraded state renders a real diagnostics line.
 *
 * 0.18.2: the settings section is crash-proof by construction — services are
 * sighted synchronously during render (the settings shell guarantees they
 * exist; no timers involved), every effect body is guarded, and the whole
 * derived+tree block sits in a try/catch that RENDERS the failure text
 * itself. Rationale: the host's SlotErrorBoundary catches any render/effect
 * throw, reports it only to the browser console, and ABDICATES the entry —
 * the panel stays blank for the rest of the registration's life. Self-
 * rendering the error keeps the page alive and makes the cause visible
 * without console access.
 *
 * Contract notes (field-tested against DSH Desktop 2.0.5 / core 0.1.2-rc.1):
 * - The client-modules registry reads this file's path from the plugin's
 *   package.json: `dsh.client.platform === "web"` + `exports["./client"]`
 *   (@deepseek-ai/dsh-client-modules resolveMeta).
 * - The file is served verbatim and must be one or more
 *   `window.__ModuleLoader__.load({ id, factory })` registrations; the
 *   factory receives a `require` bound to the shared client graph
 *   (same shape as @deepseek-ai/dsh-session-log-export's compiled bundle).
 * - The slot contract is declared by dsh-cordis-client-runner: occupants
 *   receive the standard session props, including `sessionId` (and `t` when
 *   the slot plumbing binds the registration's `locale` namespace).
 * - First-level settings pages occupy the `settings.section` slot (the
 *   settings-general / settings-models / settings-plugins /
 *   settings-agent-preset seat); native order values are general=0,
 *   models=10, plugins=15, agent-presets=20 — ours is 25.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-task-coordinator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// Filled (solid) design matching the shipped session-log button's
		// geometry (border-radius 18px / height 32px / 13px text), with an
		// inverted palette: dark fill + light text in light mode, light fill +
		// dark text in dark mode, driven by the theme alias tokens so it
		// follows the host theme registry (light / dark / system) without
		// media queries.
		const BUTTON_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 4,
			height: 32,
			fontSize: 13,
			lineHeight: "20px",
			padding: "6px 12px",
			borderRadius: 18,
			border: "none",
			background: "var(--dsw-alias-label-primary, #0f1115)",
			color: "var(--dsw-alias-label-primary-foreground, #fff)",
			cursor: "pointer",
			fontFamily: "var(--dsw-font-family, inherit)",
			whiteSpace: "nowrap"
		};

		// --- localization -----------------------------------------------------
		/** Dictionary namespace owned by this button (host LOCALE_IDS: zh/en). */
		const NS = "task-coordinator";
		const DICTS = {
			zh: {
				"header.action": "复制会话Id",
				"header.copied": "已复制 ✓",
				"header.failed": "复制失败",
				"tab.title": "任务编排",
				"card.title": "派发默认模型",
				"card.intro": "task_spawn / task_spawn_batch 未显式指定 provider+model 时使用的默认路线；此处未设置则跟随宿主默认模型。生效顺序：工具显式指定 > 此处默认 > 宿主默认。",
				"field.provider": "Provider",
				"field.model": "模型",
				"field.effort": "推理力度",
				"option.none": "未设置（跟随宿主默认）",
				"option.effortDefault": "跟随模型默认",
				"option.unavailable": "（已下线）",
				"action.save": "保存",
				"action.discard": "放弃修改",
				"action.refresh": "刷新目录",
				"status.saved": "已保存 ✓",
				"status.saving": "保存中…",
				"status.loading": "读取设置与模型目录…",
				"status.effective": "当前默认",
				"status.hostDefault": "宿主默认",
				"status.notSet": "未设置",
				"invalid.pair": "provider 与 model 需成对设置，或两者都留空。",
				"degraded.scope": "设置服务不可用（宿主缺少 settingsScope），本页暂不可编辑；派发仍按已存默认与宿主默认执行。",
				"degraded.catalog": "模型目录不可用：{message}",
				"degraded.namespace": "设置区未在宿主设置文档中注册（插件可能未随宿主装载），本页暂不可编辑。",
				"degraded.read": "设置读取失败：{message}",
				"degraded.render": "页面渲染异常：{message}",
				"action.retry": "重试"
			},
			en: {
				"header.action": "Copy Session ID",
				"header.copied": "Copied ✓",
				"header.failed": "Copy failed",
				"tab.title": "Task Orchestration",
				"card.title": "Default spawn model",
				"card.intro": "Default route for task_spawn / task_spawn_batch calls that omit provider+model; unset falls back to the host default model. Resolution order: explicit tool args > this default > host default.",
				"field.provider": "Provider",
				"field.model": "Model",
				"field.effort": "Reasoning effort",
				"option.none": "Not set (follow the host default)",
				"option.effortDefault": "Follow the model default",
				"option.unavailable": " (unavailable)",
				"action.save": "Save",
				"action.discard": "Discard changes",
				"action.refresh": "Refresh catalog",
				"status.saved": "Saved ✓",
				"status.saving": "Saving…",
				"status.loading": "Loading settings and model catalog…",
				"status.effective": "Current default",
				"status.hostDefault": "Host default",
				"status.notSet": "Not set",
				"invalid.pair": "provider and model must be set together, or both left empty.",
				"degraded.scope": "The settings service is unavailable (no settingsScope on this host); this page is read-only for now — spawns still follow the stored default and the host default.",
				"degraded.catalog": "The model catalog is unavailable: {message}",
				"degraded.namespace": "The settings section is not registered in the host settings document (the plugin may not be loaded with the host); this page is read-only for now.",
				"degraded.read": "Settings read failed: {message}",
				"degraded.render": "This page failed to render: {message}",
				"action.retry": "Retry"
			}
		};
		/** Live LocaleRuntime (register/translate/getSnapshot/subscribe) when present. */
		let localeRuntime;
		/** Client cordis ctx, kept so the locale service can be re-read when it loads late. */
		let hostCtx;
		/** Whether our dictionaries are known-registered on the live runtime. */
		let localeRegistered = false;
		const NO_LOCALE_SNAPSHOT = Object.freeze({ active: "zh", locales: [], revision: 0 });
		/**
		 * Lazily connect (and reconnect) the host locale runtime: register our
		 * dictionaries the first moment the service is sighted. The bundle only
		 * injects ["slots"] (older hosts keep the zh button instead of failing
		 * module load), so @deepseek-ai/dsh-client-locale may activate AFTER
		 * this apply() — host source: LocaleRuntime.translate falls back to the
		 * bare key for missing dictionaries, and bind(ns) hands out a `t` even
		 * for unregistered namespaces. Late registration is a host-supported
		 * contract: register bumps the snapshot revision so already-rendered
		 * outlets re-render and pick up the dictionary. Idempotent: an
		 * "already has locale" refusal (HMR double-apply) counts as registered.
		 */
		const ensureLocale = () => {
			if (localeRegistered || !hostCtx) return localeRuntime;
			if (!localeRuntime || typeof localeRuntime.register !== "function") {
				// 0.18.1: the client runner gates direct ctx.serviceName access
				// behind the fiber's inject declaration — a plain property read
				// on an undeclared service THROWS (the 0.16.1 lazy sighting
				// silently never sighted anything, so live language switching
				// never actually engaged). ctx.get(name) is the sanctioned
				// optional-lookup bypass (requireDeclaration=false in the
				// runner's dynamicCordisContext proxy); the property fallback
				// keeps direct-require test hosts working.
				try { localeRuntime = typeof hostCtx.get === "function" ? hostCtx.get("locale") : hostCtx.locale; } catch { localeRuntime = undefined; }
			}
			if (localeRuntime && typeof localeRuntime.register === "function") {
				try {
					localeRuntime.register(NS, DICTS);
					localeRegistered = true;
				} catch (error) {
					localeRegistered = /already/i.test(String((error && error.message) || error));
				}
			}
			return localeRuntime;
		};
		const subscribeLocale = (fn) => {
			const runtime = ensureLocale();
			return runtime && typeof runtime.subscribe === "function" ? runtime.subscribe(fn) : () => {};
		};
		const getLocaleSnapshot = () => {
			const runtime = ensureLocale();
			return runtime && typeof runtime.getSnapshot === "function" ? runtime.getSnapshot() : NO_LOCALE_SNAPSHOT;
		};
		/**
		 * Resolve one key against the live locale, degrading to the bundled zh
		 * dictionary whenever the runtime is missing or returns the bare key
		 * (dictionary not registered). Never throws, never renders a raw key.
		 */
		const translateNow = (key) => {
			const runtime = ensureLocale();
			if (runtime && typeof runtime.translate === "function") {
				try {
					const value = runtime.translate(NS, key);
					if (typeof value === "string" && value.length > 0 && value !== key && value !== `${NS}.${key}`) return value;
				} catch {
					/* fall through to the bundled dictionary */
				}
			}
			return DICTS.zh[key] ?? key;
		};
		/** React 18 external-store hook when available; older builds skip live re-render. */
		const useStore = typeof react.useSyncExternalStore === "function" ? react.useSyncExternalStore : null;

		/** Clipboard write with a selection-based fallback for restricted contexts. */
		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				try {
					const holder = document.createElement("textarea");
					holder.value = text;
					holder.style.position = "fixed";
					holder.style.opacity = "0";
					document.body.appendChild(holder);
					holder.select();
					const ok = document.execCommand("copy");
					holder.remove();
					return ok;
				} catch {
					return false;
				}
			}
		}

		/**
		 * Header utility: copies the current session's id.
		 * @param props - Standard session props from the slot owner (sessionId,
		 *   plus `t` when the slot plumbing binds our locale namespace).
		 * @returns the header action button.
		 */
		function CopySessionIdHeaderAction(props) {
			const sessionId = String(props.sessionId ?? "");
			const [state, setState] = react.useState("idle"); // idle | copied | failed
			ensureLocale(); // a late-arriving locale service registers on first sight
			// Re-render on every locale switch / dictionary registration; the
			// guard is constant per bundle environment, so hook order stays stable.
			const snapshot = useStore ? useStore(subscribeLocale, getLocaleSnapshot) : NO_LOCALE_SNAPSHOT;
			// Bare-key guard (0.16.1): the host hands slot occupants a `t` bound
			// to our namespace whenever the registration declares `locale: NS` —
			// even while our dictionaries are not (yet) registered, in which case
			// LocaleRuntime.translate echoes the raw key. Treat that echo (and
			// any non-string/throw) as a miss and fall back to translateNow,
			// which itself degrades to the bundled zh dictionary.
			const t = (key) => {
				if (typeof props.t === "function") {
					let value;
					try { value = props.t(key); } catch { value = undefined; }
					if (typeof value === "string" && value.length > 0 && value !== key && value !== `${NS}.${key}`) return value;
				}
				return translateNow(key);
			};
			const onClick = () => {
				void copyText(sessionId).then((ok) => {
					setState(ok ? "copied" : "failed");
					setTimeout(() => setState("idle"), 1500);
				});
			};
			const action = t("header.action");
			const label = state === "copied" ? t("header.copied") : state === "failed" ? t("header.failed") : action;
			const title = snapshot && snapshot.active === "en"
				? `${action} (${sessionId})`
				: `${action}（${sessionId}）`;
			return react.createElement("button", {
				type: "button",
				title,
				"aria-label": action,
				onClick,
				style: BUTTON_STYLE
			}, label);
		}

		// --- settings tab (0.18.0) --------------------------------------------
		/** Durable settings namespace installed host-side (settings.mjs mirror). */
		const NS_SETTINGS = "task-coordinator";
		const STYLE_ID_SETTINGS = "dsh-plugin-task-coordinator/settings";
		const SETTINGS_CSS = [
			".tcSettingsCard{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2,#00000014);border-radius:12px;max-width:560px}",
			".tcSettingsRow{display:grid;grid-template-columns:120px minmax(0,1fr);align-items:center;gap:12px}",
			".tcSettingsLabel{font-size:13px;color:var(--dsw-alias-label-secondary,#5b616e)}",
			".tcSettingsSelect{height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;min-width:0}",
			".tcSettingsSelect:disabled{opacity:.5}",
			".tcSettingsActions{display:flex;gap:8px;align-items:center}",
			".tcSettingsBtn{height:30px;padding:0 14px;border-radius:15px;border:none;cursor:pointer;font-size:13px;background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".tcSettingsBtn:disabled{opacity:.45;cursor:default}",
			".tcSettingsBtnGhost{background:transparent;color:var(--dsw-alias-label-secondary,#5b616e);border:1px solid var(--dsw-alias-border-l2,#0000001f)}",
			".tcSettingsStatus{margin:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b616e)}",
			".tcSettingsStatus[data-kind='error']{color:var(--dsw-alias-danger,#c0392b)}",
			".tcSettingsIntro{margin:0 0 4px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary,#5b616e);max-width:560px}",
			".tcSettingsHeading{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}",
			".tcSettingsPageTitle{margin:0 0 12px;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}"
		].join("\n");
		function installSettingsStyles() {
			if (document.querySelector(`style[data-plugin="${STYLE_ID_SETTINGS}"]`) !== null) return () => {};
			const style = document.createElement("style");
			style.dataset.plugin = STYLE_ID_SETTINGS;
			style.textContent = SETTINGS_CSS;
			document.head.append(style);
			return () => { style.remove(); };
		}
		/** Cached bound scope for our settings namespace (bind once sighted). */
		let boundScope = null;
		const getBoundScope = () => {
			if (boundScope) return boundScope;
			try {
				// ctx.get() bypasses the runner's inject-declaration gate (see
				// the ensureLocale note); a plain .settingsScope read would
				// throw under our "slots"-only declaration.
				const svc = hostCtx && (typeof hostCtx.get === "function" ? hostCtx.get("settingsScope") : hostCtx.settingsScope);
				if (typeof svc?.bind === "function") {
					const scope = svc.bind({ namespace: NS_SETTINGS });
					if (scope && typeof scope.getSnapshot === "function") boundScope = scope;
				}
			} catch { /* retry on the next sight */ }
			return boundScope;
		};
		/** Live remote face (model catalog) — defensive per-use read. */
		const getRemote = () => {
			try { return hostCtx && (typeof hostCtx.get === "function" ? hostCtx.get("remote") : hostCtx.remote); } catch { return undefined; }
		};
		/** Project the host modelCatalog() payload onto select-friendly rows. */
		function projectCatalog(catalog) {
			const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : [];
			return {
				providers: groups.map((group) => ({
					id: String(group?.id ?? ""),
					name: typeof group?.name === "string" && group.name.length > 0 ? group.name : undefined,
					models: (Array.isArray(group?.models) ? group.models : []).map((model) => ({
						id: String(model?.id ?? ""),
						name: typeof model?.name === "string" && model.name.length > 0 ? model.name : undefined,
						efforts: Array.isArray(model?.reasoning?.efforts)
							? model.reasoning.efforts.map((effort) => effort?.id).filter(Boolean)
							: [],
						defaultEffort: typeof model?.reasoning?.defaultEffort === "string" ? model.reasoning.defaultEffort : undefined
					})).filter((model) => model.id.length > 0)
				})).filter((provider) => provider.id.length > 0),
				...(catalog?.default ? { default: catalog.default } : {})
			};
		}
		/** Stable route equality over the three draft fields. */
		function sameRoute(left, right) {
			return String(left?.provider ?? "") === String(right?.provider ?? "")
				&& String(left?.model ?? "") === String(right?.model ?? "")
				&& String(left?.reasoningEffort ?? "") === String(right?.reasoningEffort ?? "");
		}
		/**
		 * Settings tab: GUI editor for the plugin's spawn-model default.
		 * Follows the lazy-service discipline (see the module header): the
		 * scope and remote faces are re-sighted until present, and every
		 * missing piece renders a degraded line instead of crashing.
		 */
		function TaskCoordinatorSettingsTab(props) {
			ensureLocale();
			const t = (key, params) => {
				if (typeof props.t === "function") {
					let value;
					try { value = props.t(key); } catch { value = undefined; }
					if (typeof value === "string" && value.length > 0 && value !== key && value !== `${NS}.${key}`) return value;
				}
				const fallback = translateNow(key);
				return params ? fallback.replace(/\{(\w+)\}/g, (whole, name) => (params[name] !== undefined ? String(params[name]) : whole)) : fallback;
			};
			const [scopeSnap, setScopeSnap] = react.useState(null);
			const [catalog, setCatalog] = react.useState({ status: "idle" });
			const [catalogNonce, setCatalogNonce] = react.useState(0);
			const [retryNonce, setRetryNonce] = react.useState(0);
			const [draft, setDraft] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState(null);
			// Synchronous, guarded service sighting (0.18.2). The settings
			// services are prerequisites of the settings shell itself — they are
			// present by the time this section mounts, so the 0.18.1 timer
			// retry loop is gone (no setTimeout dependency at all; a manual
			// retry button re-runs the sighting instead). Every service touch
			// is guarded: an effect-body throw is caught by the slot's error
			// boundary, which abdicates the entry and blanks the panel for the
			// rest of the registration's life.
			const scope = getBoundScope();
			const remote = getRemote();
			// Follow the scope snapshot.
			react.useEffect(() => {
				if (!scope) return undefined;
				try {
					setScopeSnap(scope.getSnapshot());
					return scope.subscribe(() => {
						try { setScopeSnap(scope.getSnapshot()); } catch { /* keep the last good snapshot */ }
					});
				} catch (error) {
					setScopeSnap({ status: "error", error: String((error && error.message) || error) });
					return undefined;
				}
			}, [scope, retryNonce]);
			// Load the live model catalog (and on every explicit refresh); the
			// synchronous `.session` reach is guarded like everything else.
			react.useEffect(() => {
				if (!remote) return undefined;
				let catalogFn = null;
				try {
					catalogFn = typeof remote.session?.modelCatalog === "function" ? () => remote.session.modelCatalog() : null;
				} catch (error) {
					setCatalog({ status: "error", error: String((error && error.message) || error) });
					return undefined;
				}
				if (!catalogFn) {
					setCatalog({ status: "error", error: "sessionController.modelCatalog is unavailable on this host" });
					return undefined;
				}
				let cancelled = false;
				setCatalog({ status: "loading" });
				Promise.resolve().then(catalogFn)
					.then((payload) => { if (!cancelled) setCatalog({ status: "ready", ...projectCatalog(payload) }); })
					.catch((error) => { if (!cancelled) setCatalog({ status: "error", error: String((error && error.message) || error) }); });
				return () => { cancelled = true; };
			}, [remote, catalogNonce, retryNonce]);
			// Sync the staged draft from the stored value until the user edits.
			const stored = scopeSnap && scopeSnap.value && typeof scopeSnap.value === "object" ? scopeSnap.value : undefined;
			react.useEffect(() => {
				if (!stored) return;
				try {
					setDraft((previous) => (previous === null || sameRoute(previous, stored) ? {
						provider: String(stored.provider ?? ""),
						model: String(stored.model ?? ""),
						reasoningEffort: String(stored.reasoningEffort ?? "")
					} : previous));
				} catch { /* a malformed stored value leaves the draft untouched */ }
			}, [stored]);
			try {
			const writable = scopeSnap?.writable === true;
			const dirty = draft !== null && stored !== undefined && !sameRoute(draft, stored);
			const pairValid = draft === null || (draft.provider.length === 0 && draft.model.length === 0)
				|| (draft.provider.length > 0 && draft.model.length > 0);
			const providers = catalog.status === "ready" ? catalog.providers : [];
			const providerKnown = draft === null || draft.provider.length === 0 || providers.some((p) => p.id === draft.provider);
			const models = draft ? providers.find((p) => p.id === draft.provider)?.models ?? [] : [];
			const modelKnown = draft === null || draft.model.length === 0 || models.some((m) => m.id === draft.model);
			const efforts = draft ? models.find((m) => m.id === draft.model)?.efforts ?? [] : [];
			const save = async () => {
				if (!scope || !draft || busy) return;
				setBusy(true);
				setMessage(null);
				try {
					await scope.set("provider", draft.provider);
					await scope.set("model", draft.model);
					await scope.set("reasoningEffort", draft.reasoningEffort);
					setMessage({ kind: "ok", text: t("status.saved") });
				} catch (error) {
					setMessage({ kind: "error", text: String((error && error.message) || error) });
				} finally {
					setBusy(false);
				}
			};
			// Discard restores the draft from the STORED value directly — the
			// stored-sync effect above does not re-fire for an unchanged
			// reference, so a null-out would leave the selects disabled.
			const discard = () => {
				setMessage(null);
				setDraft(stored === undefined ? null : {
					provider: String(stored.provider ?? ""),
					model: String(stored.model ?? ""),
					reasoningEffort: String(stored.reasoningEffort ?? "")
				});
			};
			const h = react.createElement;
			const optionRow = (key, value, label, selected) => h("option", { key, value }, label);
			const providerOptions = [
				optionRow("none", "", t("option.none"), draft?.provider === ""),
				...providers.map((provider) => optionRow(provider.id, provider.id, provider.name && provider.name !== provider.id ? `${provider.name} (${provider.id})` : provider.id, draft?.provider === provider.id)),
				...(draft && draft.provider.length > 0 && !providerKnown
					? [optionRow("stored-provider", draft.provider, `${draft.provider}${t("option.unavailable")}`, true)]
					: [])
			];
			const modelOptions = [
				optionRow("none", "", t("option.none"), draft?.model === ""),
				...models.map((model) => optionRow(model.id, model.id, model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id, draft?.model === model.id)),
				...(draft && draft.model.length > 0 && !modelKnown
					? [optionRow("stored-model", draft.model, `${draft.model}${t("option.unavailable")}`, true)]
					: [])
			];
			const effortOptions = [
				optionRow("effort-default", "", t("option.effortDefault"), (draft?.reasoningEffort ?? "") === ""),
				...efforts.map((effort) => optionRow(effort, effort, effort, draft?.reasoningEffort === effort)),
				...(draft && draft.reasoningEffort.length > 0 && !efforts.includes(draft.reasoningEffort)
					? [optionRow("stored-effort", draft.reasoningEffort, `${draft.reasoningEffort}${t("option.unavailable")}`, true)]
					: [])
			];
			const routeText = (route) => route && (route.provider || route.model)
				? `${route.provider || "?"} / ${route.model || "?"}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ""}`
				: null;
			const effective = routeText(stored);
			const hostDefault = catalog.status === "ready" ? routeText(catalog.default) : null;
			// Diagnostics (0.18.2): every degraded state renders a real line —
			// and the whole derived+tree block sits in a try/catch below, so a
			// crash renders its own message instead of tripping the host's
			// SlotErrorBoundary (which abdicates the entry and blanks the
			// panel for the rest of the registration's life).
			const scopeMissing = !scope;
			const scopeError = scopeSnap?.status === "error";
			const scopeLoading = !!scope && !scopeError && (scopeSnap === null || (scopeSnap.status !== "ready" && scopeSnap.status !== "unavailable"));
			const nsUnavailable = scopeSnap?.status === "unavailable";
			const retryButton = (scopeMissing || nsUnavailable || scopeError)
				? h("button", { type: "button", className: "tcSettingsBtn tcSettingsBtnGhost", onClick: () => setRetryNonce((n) => n + 1) }, t("action.retry"))
				: null;
			return h("div", null,
				h("h2", { className: "tcSettingsPageTitle" }, t("tab.title")),
				h("h3", { className: "tcSettingsHeading" }, t("card.title")),
				h("p", { className: "tcSettingsIntro" }, t("card.intro")),
				h("div", { className: "tcSettingsCard" },
					scopeMissing ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("degraded.scope")) : null,
					scopeError ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("degraded.read", { message: scopeSnap.error })) : null,
					nsUnavailable ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("degraded.namespace")) : null,
					scopeLoading ? h("p", { className: "tcSettingsStatus" }, t("status.loading")) : null,
					retryButton,
					h("div", { className: "tcSettingsRow" },
						h("label", { className: "tcSettingsLabel" }, t("field.provider")),
						h("select", {
							className: "tcSettingsSelect",
							value: draft ? draft.provider : "",
							disabled: !draft || !writable,
							onChange: (event) => setDraft((previous) => ({ provider: event.target.value, model: "", reasoningEffort: "" }))
						}, providerOptions)
					),
					h("div", { className: "tcSettingsRow" },
						h("label", { className: "tcSettingsLabel" }, t("field.model")),
						h("select", {
							className: "tcSettingsSelect",
							value: draft ? draft.model : "",
							disabled: !draft || !writable || (draft && draft.provider.length === 0),
							onChange: (event) => setDraft((previous) => ({ provider: previous.provider, model: event.target.value, reasoningEffort: "" }))
						}, modelOptions)
					),
					h("div", { className: "tcSettingsRow" },
						h("label", { className: "tcSettingsLabel" }, t("field.effort")),
						h("select", {
							className: "tcSettingsSelect",
							value: draft ? draft.reasoningEffort : "",
							disabled: !draft || !writable || (draft && draft.model.length === 0) || efforts.length === 0,
							onChange: (event) => setDraft((previous) => ({ ...previous, reasoningEffort: event.target.value }))
						}, effortOptions)
					),
					!pairValid ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("invalid.pair")) : null,
					catalog.status === "error" ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("degraded.catalog", { message: catalog.error })) : null,
					h("div", { className: "tcSettingsActions" },
						h("button", {
							type: "button",
							className: "tcSettingsBtn",
							disabled: !dirty || busy || !pairValid || !writable,
							onClick: () => { void save(); }
						}, busy ? t("status.saving") : t("action.save")),
						h("button", {
							type: "button",
							className: "tcSettingsBtn tcSettingsBtnGhost",
							disabled: !dirty || busy,
							onClick: discard
						}, t("action.discard")),
						h("button", {
							type: "button",
							className: "tcSettingsBtn tcSettingsBtnGhost",
							disabled: !remote || busy,
							onClick: () => { setCatalogNonce((nonce) => nonce + 1); }
						}, t("action.refresh"))
					),
					message ? h("p", { className: "tcSettingsStatus", "data-kind": message.kind }, message.text) : null,
					h("p", { className: "tcSettingsStatus" },
						`${t("status.effective")}: ${effective ?? t("status.notSet")}`
						+ (hostDefault ? ` · ${t("status.hostDefault")}: ${hostDefault}` : ""))
				)
			);
			} catch (error) {
				// Last-resort net (0.18.2): render the failure ourselves — the
				// host's SlotErrorBoundary would otherwise abdicate the entry
				// and leave a blank panel with the reason only in the console.
				const hh = react.createElement;
				return hh("div", null,
					hh("h2", { className: "tcSettingsPageTitle" }, t("tab.title")),
					hh("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("degraded.render", { message: String((error && error.message) || error) })),
					hh("button", { type: "button", className: "tcSettingsBtn tcSettingsBtnGhost", onClick: () => setRetryNonce((n) => n + 1) }, t("action.retry"))
				);
			}
		}

		const inject = ["slots"];

		/**
		 * Client fiber entry: occupy the header utilities slot and a
		 * first-level settings section.
		 * @param ctx - Client cordis context (slots service; locale /
		 *   settingsScope / remote are sighted through ctx.get() — the
		 *   runner's sanctioned optional-lookup bypass — so the bundle keeps
		 *   its "slots"-only declaration and older hosts keep the button).
		 */
		function apply(ctx) {
			hostCtx = ctx;
			// Eager first attempt; every render retries until the runtime is
			// sighted and the dictionaries are registered (see ensureLocale).
			ensureLocale();
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "copy-session-id",
				order: 1,
				locale: NS,
				label: () => translateNow("header.action")
			}, CopySessionIdHeaderAction));
			// First-level settings section (0.18.1): Settings → 任务编排 in the
			// left nav (the settings-general/settings-models/settings-plugins/
			// settings-agent-preset seat — order 25 sits after agent-presets'
			// 20). 0.18.0 shipped this as a settings.plugins.tab inside the
			// Plugins page; the user asked for a first-level entry. The
			// component edits the durable spawn-model default; styles install
			// once per document; every missing service degrades to a real
			// diagnostics line instead of silent grey.
			ctx.slots.inject("settings.section", () => {
				installSettingsStyles();
				return ctx.slots.register({
					name: "settings.section",
					id: "task-coordinator",
					order: 25,
					locale: NS,
					label: () => translateNow("tab.title")
				}, TaskCoordinatorSettingsTab);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
