/**
 * dsh-plugin-task-coordinator — client module (0.8.0)
 *
 * Occupies the `conversation.session.header.utilities` slot with a
 * "Copy session id" action, so any session's stable id can be grabbed with
 * one click and pasted into task_send / task_progress / /tasks on the
 * supervisor side.
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
 *   receive the standard session props, including `sessionId`.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-task-coordinator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const BUTTON_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: 4,
			fontSize: 12,
			lineHeight: "20px",
			padding: "2px 8px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))",
			background: "transparent",
			cursor: "pointer",
			fontFamily: "inherit",
			whiteSpace: "nowrap"
		};

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
		 * @param props - Standard session props from the slot owner (sessionId).
		 * @returns the header action button.
		 */
		function CopySessionIdHeaderAction(props) {
			const sessionId = String(props.sessionId ?? "");
			const [state, setState] = react.useState("idle"); // idle | copied | failed
			const onClick = () => {
				void copyText(sessionId).then((ok) => {
					setState(ok ? "copied" : "failed");
					setTimeout(() => setState("idle"), 1500);
				});
			};
			const label = state === "copied" ? "已复制 ✓" : state === "failed" ? "复制失败" : "复制 ID";
			return react.createElement("button", {
				type: "button",
				title: `复制会话 ID（${sessionId}）`,
				"aria-label": "复制会话 ID",
				onClick,
				style: {
					...BUTTON_STYLE,
					color: state === "copied"
						? "var(--dsw-alias-label-success, #16A34A)"
						: state === "failed"
							? "var(--dsw-alias-label-error, #DC2626)"
							: "var(--dsw-alias-label-secondary, inherit)"
				}
			}, label);
		}

		const inject = ["slots"];
		/**
		 * Client fiber entry: occupy the header utilities slot.
		 * @param ctx - Client cordis context (slots service).
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "copy-session-id",
				order: 1,
				label: () => "复制会话 ID"
			}, CopySessionIdHeaderAction));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
