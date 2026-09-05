/**
 * dsh-plugin-task-coordinator — client module (0.15.0)
 *
 * Occupies the `conversation.session.header.utilities` slot with a
 * "Copy session id" action, so any session's stable id can be grabbed with
 * one click and pasted into task_send / task_progress / /tasks on the
 * supervisor side.
 *
 * Localization (0.15.0): button strings follow the host's live locale
 * runtime (@deepseek-ai/dsh-client-locale — the same channel the official
 * session-log-export button uses): dictionaries are registered under our own
 * namespace, translations resolve through locale.translate with re-render on
 * every locale/dictionary change (getSnapshot/subscribe is uSES-safe), and
 * any missing piece degrades to the bundled zh strings — never a crash.
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
				"header.failed": "复制失败"
			},
			en: {
				"header.action": "Copy Session ID",
				"header.copied": "Copied ✓",
				"header.failed": "Copy failed"
			}
		};
		/** Live LocaleRuntime (register/translate/getSnapshot/subscribe) when present. */
		let localeRuntime;
		const NO_LOCALE_SNAPSHOT = Object.freeze({ active: "zh", locales: [], revision: 0 });
		const subscribeLocale = (fn) => (localeRuntime && typeof localeRuntime.subscribe === "function"
			? localeRuntime.subscribe(fn)
			: () => {});
		const getLocaleSnapshot = () => (localeRuntime && typeof localeRuntime.getSnapshot === "function"
			? localeRuntime.getSnapshot()
			: NO_LOCALE_SNAPSHOT);
		/**
		 * Resolve one key against the live locale, degrading to the bundled zh
		 * dictionary whenever the runtime is missing or returns the bare key
		 * (dictionary registration refused). Never throws.
		 */
		const translateNow = (key) => {
			if (localeRuntime && typeof localeRuntime.translate === "function") {
				try {
					const value = localeRuntime.translate(NS, key);
					if (typeof value === "string" && value.length > 0 && value !== key) return value;
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
			// Re-render on every locale switch / dictionary registration; the
			// guard is constant per bundle environment, so hook order stays stable.
			const snapshot = useStore ? useStore(subscribeLocale, getLocaleSnapshot) : NO_LOCALE_SNAPSHOT;
			const t = typeof props.t === "function" ? props.t : translateNow;
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

		const inject = ["slots"];
		/**
		 * Client fiber entry: occupy the header utilities slot.
		 * @param ctx - Client cordis context (slots service; locale when the
		 *   host provides @deepseek-ai/dsh-client-locale — accessed defensively,
		 *   never hard-injected so older hosts keep the button in zh).
		 */
		function apply(ctx) {
			try {
				localeRuntime = ctx.locale;
			} catch {
				localeRuntime = undefined;
			}
			if (localeRuntime && typeof localeRuntime.register === "function") {
				try {
					localeRuntime.register(NS, DICTS);
				} catch {
					/* registration refused: translateNow degrades to the zh dictionary */
				}
			}
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "copy-session-id",
				order: 1,
				locale: NS,
				label: () => translateNow("header.action")
			}, CopySessionIdHeaderAction));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
