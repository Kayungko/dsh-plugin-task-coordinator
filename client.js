/**
 * dsh-plugin-task-coordinator — client module (0.25.1)
 *
 * 0.22.0: the card topology is BACK as the orchestration view's form (user
 * verdict after living with the 0.21.x lane timeline: cards + directional
 * SVG edges read better for supervision than abstract lanes). Kept from
 * the lane era: the centered 1040px content column (the 0.20.0 canvas
 * hugged the left edge), the useSession hasMore seat + "load older
 * records" history paging (long sessions keep spawn records outside the
 * finite transcript window), and the scanned-count empty state. The lane
 * pure functions (layoutLanes/laneEvents/orchTimeWindow) are retired with
 * 0.21.x; layoutTopology/orchEdgePath return.
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
 * 0.18.3: two field-reported fixes — ① the `{message}` interpolation ran
 * only on the bundled-dictionary fallback path, so a host-runtime hit
 * returned raw placeholders (invisible until the ctx.get() fix made the
 * host path engage); interpolation now covers both paths. ② the model
 * catalog is sighted through the DOTTED service name "remote.session"
 * first (the shape the native settings cards inject; the runner resolves
 * dotted names via ctx.get), with the facade walk as fallback — a
 * synchronous throw on the facade's `.session` reach is the prime suspect
 * for the 0.18.1 blank panel.
 *
 * 0.20.0: third slot — the "编排" (Orchestration) conversation view.
 * Registers `conversation.view` (id 'orchestration', order 20, after the
 * native chat/trajectory tabs) and renders the LIVE topology anchored on
 * the CURRENT session as the supervisor: a supervisor node on top, child
 * session cards grouped into team rows below, spawn/send/report edges,
 * live running/todos/goal states joined from useSessions projections, and
 * a dash-flow shimmer on edges active within RECENT_MS. Pure client-side
 * READ-ONLY view — zero host changes, zero writes. Design contracts are
 * field-researched (research/orchestration-view-contracts.md):
 * - data comes from the standard seats only: useChat (transcript nodes),
 *   useSessions (live SessionSummary rows incl. projectionValues todos /
 *   goal), sessionId; jumps go through ctx.get('sessions')?.open(id)
 *   (the sidebar's authoritative navigation primitive) with a
 *   copy-session-id fallback when the sighting or the open fails;
 * - extraction is a PURE function (exports.__orchestration test surface):
 *   tool-call nodes' data.root yields task_spawn / task_spawn_batch
 *   (child session id/title/team/correlationId/depth/model from the result
 *   JSON), task_send (mode/target/messageId/reference), inbound relay
 *   reports arrive as `context` nodes with source.kind='coordinator' +
 *   form='relay' + senderSessionId, task_wait/task_cancel land as notes;
 *   malformed shapes (call === null results, unfinished streaming JSON,
 *   missing fields) are SKIPPED, never thrown;
 * - layout is a pure deterministic layered function (no physics): the
 *   supervisor node centered on top, team rows below (no-team children
 *   fall into the "未编组" row, which sorts last); coordinates depend
 *   only on the extraction output;
 * - the transcript is a finite window (the chat store's live projection):
 *   extraction re-runs per snapshot change over the loaded window only
 *   (~µs per node; the full-history cost lives host-side, per the
 *   transcript-perf research), so a 176k-event coordinator costs the
 *   client nothing extra;
 * - crash discipline follows the settings section (0.18.2): every seat
 *   read and effect body is guarded, and the derived+tree block sits in
 *   a try/catch that RENDERS the failure itself — the host's
 *   SlotErrorBoundary must never abdicate this entry.
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
				"field.queue": "队列深度上限",
				"field.queue.hint": "同一目标会话可排队的消息上限（0 = 跟随部署配置，默认 5；最大 {cap}）。队列每轮消化约 1 条，改完下一次 task_send 检查即生效。",
				"queue.invalid": "队列深度上限须为 0–{cap} 的整数。",
				"queue.follow": "跟随部署配置",
				"degraded.scope": "设置服务不可用（宿主缺少 settingsScope），本页暂不可编辑；派发仍按已存默认与宿主默认执行。",
				"degraded.catalog": "模型目录不可用：{message}",
				"degraded.namespace": "设置区未在宿主设置文档中注册（插件可能未随宿主装载），本页暂不可编辑。",
				"degraded.read": "设置读取失败：{message}",
				"degraded.render": "页面渲染异常：{message}",
				"save.rejected": "保存未生效：宿主拒绝了本次写入（已回读核对）。请重试；若持续失败请检查宿主日志。",
				"action.retry": "重试",
				// 0.20.0 orchestration view (conversation.view slot, id 'orchestration')
				"view.tab": "编排",
				"orch.empty.title": "本会话未派发子任务",
				"orch.empty.hint": "用 task_spawn / task_spawn_batch 派发子任务后，这里会实时呈现以本会话为总控的编排拓扑。",
				"orch.empty.suffix": "在子会话或普通会话中打开本页时同样显示此空态——编排视图以当前会话为总控。",
				"orch.coordinator": "总控",
				"orch.ungrouped": "未编组",
				"orch.status.running": "运行中",
				"orch.status.idle": "空闲",
				"orch.status.completed": "已完成",
				"orch.status.unknown": "离线",
				"orch.todos": "待办 {done}/{total}",
				"orch.goal": "阶段 {phase}",
				"orch.refresh": "刷新",
				"orch.retry": "重试",
				"orch.children": "{n} 个子会话",
				"orch.notes.wait": "等待 ×{n}",
				"orch.notes.cancel": "取消 ×{n}",
				"orch.time.now": "刚刚",
				"orch.time.sec": "{n} 秒前",
				"orch.time.min": "{n} 分钟前",
				"orch.time.hour": "{n} 小时前",
				"orch.time.day": "{n} 天前",
				"orch.time.unknown": "活动时间未知",
				"orch.degraded.chat": "转录服务不可用（{message}），编排拓扑暂无法提取。",
				"orch.degraded.sessions": "会话列表服务不可用，实时状态暂缺（拓扑按转录记录渲染）。",
				"orch.error.extract": "拓扑提取异常：{message}",
				"orch.error.render": "编排视图渲染异常：{message}",
				"orch.open.copied": "无法跳转（{message}），已复制会话 ID：{id}",
				"orch.open.copyFailed": "无法跳转（{message}），且复制失败——会话 ID：{id}",
				"orch.legend.spawn": "派发",
				"orch.legend.send": "指令",
				"orch.legend.report": "汇报",
				"orch.legend.recent": "2 分钟内有活动",
				"orch.history.more": "载入更早记录",
				"orch.history.loading": "正在加载更早记录…",
				"orch.history.failed": "载入更早记录失败：{message}",
				"orch.empty.scanned": "已扫描当前转录窗口 {n} 条节点，未发现派发记录。",
				"orch.empty.windowHint": "长会话的早期派发可能在尚未加载的历史窗口里——点「载入更早记录」逐页回溯后自动重提取。"
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
				"field.queue": "Send-queue cap",
				"field.queue.hint": "Max queued messages per target session (0 = follow the deployment config, default 5; ceiling {cap}). The queue drains ~1 per round; an edit applies from the next task_send check onward.",
				"queue.invalid": "The send-queue cap must be an integer between 0 and {cap}.",
				"queue.follow": "deployment config",
				"degraded.scope": "The settings service is unavailable (no settingsScope on this host); this page is read-only for now — spawns still follow the stored default and the host default.",
				"degraded.catalog": "The model catalog is unavailable: {message}",
				"degraded.namespace": "The settings section is not registered in the host settings document (the plugin may not be loaded with the host); this page is read-only for now.",
				"degraded.read": "Settings read failed: {message}",
				"degraded.render": "This page failed to render: {message}",
				"save.rejected": "Save did not take effect: the host rejected the write (verified by read-back). Retry; if it keeps failing, check the host log.",
				"action.retry": "Retry",
				// 0.20.0 orchestration view (conversation.view slot, id 'orchestration')
				"view.tab": "Orchestration",
				"orch.empty.title": "No tasks dispatched from this session",
				"orch.empty.hint": "Dispatch sub-tasks with task_spawn / task_spawn_batch and this tab renders the live topology with this session as the supervisor.",
				"orch.empty.suffix": "Opening this tab inside a child session or a plain session shows the same empty state — the view always anchors on the current session.",
				"orch.coordinator": "Supervisor",
				"orch.ungrouped": "Ungrouped",
				"orch.status.running": "Running",
				"orch.status.idle": "Idle",
				"orch.status.completed": "Completed",
				"orch.status.unknown": "Offline",
				"orch.todos": "Todos {done}/{total}",
				"orch.goal": "Phase {phase}",
				"orch.refresh": "Refresh",
				"orch.retry": "Retry",
				"orch.children": "{n} child sessions",
				"orch.notes.wait": "waits ×{n}",
				"orch.notes.cancel": "cancels ×{n}",
				"orch.time.now": "just now",
				"orch.time.sec": "{n}s ago",
				"orch.time.min": "{n}m ago",
				"orch.time.hour": "{n}h ago",
				"orch.time.day": "{n}d ago",
				"orch.time.unknown": "last activity unknown",
				"orch.degraded.chat": "The transcript service is unavailable ({message}); the orchestration topology cannot be extracted.",
				"orch.degraded.sessions": "The session list is unavailable; live states are missing (the topology renders from transcript records).",
				"orch.error.extract": "Topology extraction failed: {message}",
				"orch.error.render": "The orchestration view failed to render: {message}",
				"orch.open.copied": "Cannot open the session ({message}); copied the session id: {id}",
				"orch.open.copyFailed": "Cannot open the session ({message}); the clipboard copy failed too — session id: {id}",
				"orch.legend.spawn": "spawn",
				"orch.legend.send": "message",
				"orch.legend.report": "report",
				"orch.legend.recent": "active within 2 min",
				"orch.history.more": "Load older records",
				"orch.history.loading": "Loading older records…",
				"orch.history.failed": "Loading older records failed: {message}",
				"orch.empty.scanned": "Scanned {n} nodes in the loaded transcript window; no dispatch records found.",
				"orch.empty.windowHint": "In long sessions the early spawns may sit in the not-yet-loaded history window — page back with Load older records; the view re-extracts automatically."
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
			".tcSettingsHint{margin:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b616e);max-width:560px}",
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
		/**
		 * Live model-catalog face (0.18.3). The native settings cards inject
		 * the DOTTED service name "remote.session" — the runner resolves
		 * dotted names through ctx.get (its fiber waitingFor check calls
		 * ctx.get(name) with the dotted key), so try that shape first; the
		 * facade walk (ctx.get("remote").session) is the fallback. Both reads
		 * are guarded: a synchronous throw here is exactly what blanked the
		 * 0.18.1 panel (the slot error boundary abdicates on effect throws).
		 * Cached on first success; null keeps retrying per render.
		 */
		let catalogFace = null;
		const getCatalogFace = () => {
			if (catalogFace) return catalogFace;
			try {
				if (hostCtx && typeof hostCtx.get === "function") {
					const dotted = hostCtx.get("remote.session");
					if (dotted && typeof dotted.modelCatalog === "function") { catalogFace = dotted; return catalogFace; }
					const facade = hostCtx.get("remote");
					const session = facade && facade.session;
					if (session && typeof session.modelCatalog === "function") { catalogFace = session; return catalogFace; }
				} else if (hostCtx) {
					const session = hostCtx.remote && hostCtx.remote.session;
					if (session && typeof session.modelCatalog === "function") catalogFace = session;
				}
			} catch { /* retry on the next render */ }
			return catalogFace;
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
		/** Hard ceiling for the queue-cap field — mirrors MAX_QUEUE_PER_TASK_CAP in settings.mjs (host side clamps too). */
		const QUEUE_CAP = 50;
		/** Stable equality over the four draft fields (route triple + queue cap). */
		function sameRoute(left, right) {
			return String(left?.provider ?? "") === String(right?.provider ?? "")
				&& String(left?.model ?? "") === String(right?.model ?? "")
				&& String(left?.reasoningEffort ?? "") === String(right?.reasoningEffort ?? "")
				&& Number(left?.maxQueuePerTask ?? 0) === Number(right?.maxQueuePerTask ?? 0);
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
				// 0.18.3: interpolation applies to BOTH resolution paths — the
				// host-runtime hit used to return the raw dictionary string,
				// rendering "{message}" placeholders verbatim (invisible until
				// the ctx.get() fix made the host path actually engage).
				let value;
				if (typeof props.t === "function") {
					try { value = props.t(key); } catch { value = undefined; }
					if (typeof value !== "string" || value.length === 0 || value === key || value === `${NS}.${key}`) value = undefined;
				}
				if (value === undefined) value = translateNow(key);
				return params ? value.replace(/\{(\w+)\}/g, (whole, name) => (params[name] !== undefined ? String(params[name]) : whole)) : value;
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
			const face = getCatalogFace();
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
			// Load the live model catalog (and on every explicit refresh). The
			// face was already validated method-wise during render sighting, so
			// only the async call remains — with its own catch.
			react.useEffect(() => {
				if (!face) {
					setCatalog({ status: "error", error: "remote.session.modelCatalog is unavailable on this host" });
					return undefined;
				}
				let cancelled = false;
				setCatalog({ status: "loading" });
				Promise.resolve().then(() => face.modelCatalog())
					.then((response) => {
						if (cancelled) return;
						// 0.18.4: the CLIENT wire answers a result envelope
						// ({ok, value: {groups, failures, default?}} — the shape
						// the native subagent-model card consumes), while the
						// host-side facade returns the bare catalog. Unwrap
						// defensively so both shapes project.
						if (response && response.ok === false) {
							setCatalog({ status: "error", error: String((response.error && (response.error.message ?? response.error)) ?? "modelCatalog reported a failure") });
							return;
						}
						const payload = response && typeof response === "object" && "value" in response ? response.value : response;
						setCatalog({ status: "ready", ...projectCatalog(payload) });
					})
					.catch((error) => { if (!cancelled) setCatalog({ status: "error", error: String((error && error.message) || error) }); });
				return () => { cancelled = true; };
			}, [face, catalogNonce, retryNonce]);
			// Sync the staged draft from the stored value until the user edits.
			const stored = scopeSnap && scopeSnap.value && typeof scopeSnap.value === "object" ? scopeSnap.value : undefined;
			react.useEffect(() => {
				if (!stored) return;
				try {
					setDraft((previous) => (previous === null || sameRoute(previous, stored) ? {
						provider: String(stored.provider ?? ""),
						model: String(stored.model ?? ""),
						reasoningEffort: String(stored.reasoningEffort ?? ""),
						maxQueuePerTask: Number.isFinite(Number(stored.maxQueuePerTask)) ? Math.max(0, Math.trunc(Number(stored.maxQueuePerTask))) : 0
					} : previous));
				} catch { /* a malformed stored value leaves the draft untouched */ }
			}, [stored]);
			try {
			const writable = scopeSnap?.writable === true;
			const dirty = draft !== null && stored !== undefined && !sameRoute(draft, stored);
			const pairValid = draft === null || (draft.provider.length === 0 && draft.model.length === 0)
				|| (draft.provider.length > 0 && draft.model.length > 0);
			// 0.23.0: queue cap must be an integer in [0, QUEUE_CAP]; 0 = follow
			// the deployment config. Out-of-range disables Save (honest UI-side
			// enforcement — the host write boundary stays types-only per 0.18.5).
			const queueValid = draft === null || (Number.isInteger(draft.maxQueuePerTask) && draft.maxQueuePerTask >= 0 && draft.maxQueuePerTask <= QUEUE_CAP);
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
					// 0.18.5: ONE atomic namespace mutation instead of three
					// per-field writes — the per-field path composed half-pair
					// intermediate states that the host validate hook rejected,
					// and the scope's write channel RESOLVES NORMALLY on a
					// rejected mutation (silent recovery read), so the old code
					// reported "saved" while provider/model never landed.
					const ops = [
						{ op: "set", path: ["provider"], value: draft.provider },
						{ op: "set", path: ["model"], value: draft.model },
						{ op: "set", path: ["reasoningEffort"], value: draft.reasoningEffort },
						{ op: "set", path: ["maxQueuePerTask"], value: draft.maxQueuePerTask }
					];
					if (typeof scope.mutate === "function") {
						await scope.mutate(ops);
					} else {
						// Legacy fallback (scopes without mutate): sequential
						// per-field writes; the post-check below still tells
						// the truth about what landed.
						await scope.set("provider", draft.provider);
						await scope.set("model", draft.model);
						await scope.set("reasoningEffort", draft.reasoningEffort);
						await scope.set("maxQueuePerTask", draft.maxQueuePerTask);
					}
					// Honest-save verification: the write channel swallows host
					// rejections, so read back the landed snapshot and compare
					// before claiming success.
					let landed = null;
					try {
						const snap = scope.getSnapshot();
						landed = snap && snap.value && typeof snap.value === "object" ? snap.value : null;
					} catch { landed = null; }
					if (landed && sameRoute(landed, draft)) {
						setMessage({ kind: "ok", text: t("status.saved") });
					} else {
						setMessage({ kind: "error", text: t("save.rejected") });
					}
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
					reasoningEffort: String(stored.reasoningEffort ?? ""),
					maxQueuePerTask: Number.isFinite(Number(stored.maxQueuePerTask)) ? Math.max(0, Math.trunc(Number(stored.maxQueuePerTask))) : 0
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
							onChange: (event) => setDraft((previous) => ({ provider: event.target.value, model: "", reasoningEffort: "", maxQueuePerTask: previous ? previous.maxQueuePerTask : 0 }))
						}, providerOptions)
					),
					h("div", { className: "tcSettingsRow" },
						h("label", { className: "tcSettingsLabel" }, t("field.model")),
						h("select", {
							className: "tcSettingsSelect",
							value: draft ? draft.model : "",
							disabled: !draft || !writable || (draft && draft.provider.length === 0),
							onChange: (event) => setDraft((previous) => ({ provider: previous.provider, model: event.target.value, reasoningEffort: "", maxQueuePerTask: previous ? previous.maxQueuePerTask : 0 }))
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
					h("div", { className: "tcSettingsRow" },
						h("label", { className: "tcSettingsLabel" }, t("field.queue")),
						h("input", {
							type: "number",
							className: "tcSettingsSelect",
							min: 0,
							max: QUEUE_CAP,
							step: 1,
							value: draft ? String(draft.maxQueuePerTask) : "0",
							disabled: !draft || !writable,
							onChange: (event) => {
								const raw = event.target.value;
								const next = raw === "" ? 0 : Math.trunc(Number(raw));
								setDraft((previous) => ({ ...previous, maxQueuePerTask: Number.isFinite(next) ? next : 0 }));
							}
						})
					),
					h("p", { className: "tcSettingsHint" }, t("field.queue.hint", { cap: QUEUE_CAP })),
					!pairValid ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("invalid.pair")) : null,
					!queueValid ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("queue.invalid", { cap: QUEUE_CAP })) : null,
					catalog.status === "error" ? h("p", { className: "tcSettingsStatus", "data-kind": "error" }, t("degraded.catalog", { message: catalog.error })) : null,
					h("div", { className: "tcSettingsActions" },
						h("button", {
							type: "button",
							className: "tcSettingsBtn",
							disabled: !dirty || busy || !pairValid || !queueValid || !writable,
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
							disabled: busy,
							onClick: () => { setCatalogNonce((nonce) => nonce + 1); }
						}, t("action.refresh"))
					),
					message ? h("p", { className: "tcSettingsStatus", "data-kind": message.kind }, message.text) : null,
					h("p", { className: "tcSettingsStatus" },
						`${t("status.effective")}: ${effective ?? t("status.notSet")}`
						+ (hostDefault ? ` · ${t("status.hostDefault")}: ${hostDefault}` : "")
						+ ` · ${t("field.queue")}: ${Number(stored?.maxQueuePerTask ?? 0) > 0 ? String(stored.maxQueuePerTask) : t("queue.follow")}`)
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

		// --- orchestration view (0.20.0) ---------------------------------------
		/** Style element id for the orchestration view (deduped per document). */
		const STYLE_ID_ORCH = "dsh-plugin-task-coordinator/orchestration-view";
		const ORCH_CSS = [
			".orchViewRoot{max-width:calc(var(--dsh-chat-content-width,920px) + 32px);width:100%;margin:0 auto;padding:24px 16px 48px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;min-height:100%;font-family:var(--dsw-font-family,inherit)}",
			".orchViewToolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
			".orchViewTitle{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}",
			".orchViewMeta{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b616e)}",
			".orchViewFlash{margin:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b616e)}",
			".orchViewFlash[data-kind='error']{color:var(--dsw-alias-danger,#c0392b)}",
			".orchViewBtn{height:28px;padding:0 12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#0000001f);background:transparent;color:var(--dsw-alias-label-secondary,#5b616e);cursor:pointer;font-size:12px;font-family:var(--dsh-font-family,inherit)}",
			".orchViewBtn:hover{color:var(--dsw-alias-label-primary,#0f1115)}",
			".orchViewCanvas{position:relative;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#00000014);border-radius:12px;background:var(--dsw-alias-bg-module-platform,#fafbfc)}",
			".orchViewLayer{position:relative;margin:0 auto}",
			".orchViewSvg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}",
			".orchViewRowLabel{position:absolute;font-size:12px;line-height:22px;color:var(--dsw-alias-label-secondary,#5b616e);white-space:nowrap}",
			".orchViewNode{position:absolute;box-sizing:border-box;width:240px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#0000001f);border-radius:10px;background:var(--dsw-alias-bg-module-platform,#fff);color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer;text-align:left;font-family:var(--dsw-font-family,inherit)}",
			".orchViewNode:hover{border-color:var(--dsw-alias-label-secondary,#5b616e)}",
			".orchViewNode[data-role='coordinator']{border-width:2px;cursor:default}",
			".orchViewNodeTitle{font-size:13px;font-weight:600;line-height:18px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}",
			".orchViewNodeMeta{display:flex;gap:8px;align-items:baseline;margin-top:2px;min-width:0}",
			".orchViewId{font-size:11px;color:var(--dsw-alias-label-secondary,#5b616e);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
			".orchViewModel{font-size:11px;color:var(--dsw-alias-label-secondary,#5b616e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".orchViewChips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}",
			".orchViewChip{font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;background:var(--dsw-alias-bg-module-embed,#f0f1f3);color:var(--dsw-alias-label-secondary,#5b616e);white-space:nowrap}",
			".orchViewChip[data-kind='team']{color:var(--dsw-alias-label-primary,#0f1115)}",
			".orchViewChip[data-kind='status'][data-state='running']{color:var(--dsw-alias-accent,#2563eb);background:rgba(37,99,235,.12)}",
			".orchViewChip[data-kind='status'][data-state='completed']{color:var(--dsw-alias-success,#16a34a);background:rgba(22,163,74,.12)}",
			".orchViewChip[data-kind='status'][data-state='unknown']{opacity:.7}",
			".orchViewNodeTime{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#5b616e)}",
			".orchViewBreath{animation:orchViewBreathKf 2s ease-in-out infinite}",
			"@keyframes orchViewBreathKf{0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,.3)}50%{box-shadow:0 0 0 7px rgba(37,99,235,0)}}",
			".orchViewEdge{fill:none;stroke-width:1.5}",
			".orchViewEdgeSpawn{stroke:var(--dsw-alias-border-l2,#c9ced6)}",
			".orchViewEdgeSend{stroke:var(--dsw-alias-accent,#2563eb)}",
			".orchViewEdgeReport{stroke:var(--dsw-alias-label-secondary,#8a919e);stroke-dasharray:6 4}",
			".orchViewFlow{stroke-dasharray:8 6;animation:orchViewFlowKf 1.1s linear infinite}",
			"@keyframes orchViewFlowKf{to{stroke-dashoffset:-28}}",
			".orchViewEdgeLabel{font-size:10px;fill:var(--dsw-alias-label-secondary,#5b616e)}",
			".orchViewLegend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#5b616e);align-items:center}",
			".orchViewLegendKey{display:inline-block;width:18px;height:0;border-top:2px solid var(--dsw-alias-border-l2,#c9ced6);vertical-align:middle;margin-right:4px}",
			".orchViewLegendKey[data-kind='send']{border-top-color:var(--dsw-alias-accent,#2563eb)}",
			".orchViewLegendKey[data-kind='report']{border-top-style:dashed;border-top-color:var(--dsw-alias-label-secondary,#8a919e)}",
			".orchViewEmpty{display:flex;flex-direction:column;gap:8px;padding:32px 24px;border:1px dashed var(--dsw-alias-border-l2,#0000001f);border-radius:12px;max-width:560px;margin:24px auto 0;text-align:center}",
			".orchViewEmptyTitle{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}",
			".orchViewEmptyText{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary,#5b616e)}",
			"@media (prefers-reduced-motion: reduce){.orchViewBreath{animation:none}.orchViewFlow{animation:none}}"
		].join("\n");
		function installOrchStyles() {
			if (document.querySelector(`style[data-plugin="${STYLE_ID_ORCH}"]`) !== null) return () => {};
			const style = document.createElement("style");
			style.dataset.plugin = STYLE_ID_ORCH;
			style.textContent = ORCH_CSS;
			document.head.append(style);
			return () => { style.remove(); };
		}
		/** Edges with activity inside this window get the dash-flow shimmer. */
		const RECENT_MS = 120000;
		/** Sentinel node id for the supervisor (the CURRENT session anchors the view). */
		const ORCH_COORD = "coordinator";
		/** Deterministic layered-layout metrics (px). */
		const ORCH_LAYOUT = { nodeW: 240, nodeH: 108, gapX: 24, rowGap: 56, labelH: 22, padX: 16, padTop: 16, padBottom: 16 };

		/** Best-effort JSON object parse: malformed / streaming-incomplete text → null. */
		function orchParseJson(text) {
			if (typeof text !== "string" || text.length === 0) return null;
			try {
				const value = JSON.parse(text);
				return value !== null && typeof value === "object" ? value : null;
			} catch { return null; }
		}
		/** First text block of a tool-result content list (the plugin's JSON payload channel). */
		function orchResultPayload(block) {
			if (!Array.isArray(block.content)) return null;
			for (const item of block.content) {
				if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
					return orchParseJson(item.text);
				}
			}
			return null;
		}
		/**
		 * Normalize one tool-call node's data.root into { name, args, time, result }.
		 * Returns null for RUNNING calls (no result content yet — nothing durable
		 * to extract; the node updates once the call settles) and for result
		 * nodes whose call was truncated away by the transcript window
		 * (call === null: no tool name survives, the node is unidentifiable).
		 * Never throws.
		 */
		function orchToolFacts(block) {
			if (!block || typeof block !== "object") return null;
			if (typeof block.kind === "string" && block.kind === "tool-result") {
				const call = block.call && typeof block.call === "object" ? block.call : null;
				if (!call || typeof call.name !== "string") return null;
				return {
					name: call.name,
					args: orchParseJson(call.argsRaw),
					time: typeof block.time === "number" ? block.time : undefined,
					result: orchResultPayload(block)
				};
			}
			return null; // RunningToolCall: wait for the settled result node
		}
		/**
		 * Fold one identified tool call into the extraction sinks. Pure, never
		 * throws; every missing field just skips its contribution.
		 */
		function orchExtractTool(facts, sink) {
			const { name, args, result, time } = facts;
			const record = result || {};
			if (name === "task_spawn") {
				if (record.ok === false) {
					sink.note({ kind: "spawn-failed", time, title: typeof args?.title === "string" ? args.title : undefined });
					return;
				}
				if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return;
				sink.addChild({
					sessionId: record.sessionId,
					title: typeof record.title === "string" && record.title.length > 0 ? record.title
						: typeof args?.title === "string" && args.title.length > 0 ? args.title : undefined,
					team: typeof record.team === "string" && record.team.length > 0 ? record.team
						: typeof args?.team === "string" && args.team.length > 0 ? args.team : undefined,
					correlationId: typeof record.correlationId === "string" ? record.correlationId : undefined,
					shortId: typeof record.shortId === "string" ? record.shortId : undefined,
					depth: typeof record.depth === "number" ? record.depth : undefined,
					model: record.model && typeof record.model === "object" ? record.model : undefined,
					time
				});
				sink.addEdge({ kind: "spawn", from: ORCH_COORD, to: record.sessionId, time });
				return;
			}
			if (name === "task_spawn_batch") {
				const team = typeof record.team === "string" && record.team.length > 0 ? record.team
					: typeof args?.team === "string" && args.team.length > 0 ? args.team : undefined;
				if (Array.isArray(record.results)) {
					for (const item of record.results) {
						if (!item || typeof item !== "object") continue;
						if (typeof item.sessionId !== "string" || item.sessionId.length === 0) continue; // failed item: no session was born
						sink.addChild({
							sessionId: item.sessionId,
							title: typeof item.title === "string" && item.title.length > 0 ? item.title : undefined,
							team,
							correlationId: typeof item.correlationId === "string" ? item.correlationId : undefined,
							shortId: typeof item.shortId === "string" ? item.shortId : undefined,
							depth: typeof item.depth === "number" ? item.depth : undefined,
							model: undefined,
							time
						});
						sink.addEdge({ kind: "spawn", from: ORCH_COORD, to: item.sessionId, time });
					}
				}
				return;
			}
			if (name === "task_send") {
				const target = typeof args?.sessionId === "string" && args.sessionId.length > 0 ? args.sessionId
					: typeof record.targetId === "string" && record.targetId.length > 0 ? record.targetId : undefined;
				if (!target) return;
				const mode = typeof args?.mode === "string" && args.mode.length > 0 ? args.mode
					: typeof record.mode === "string" && record.mode.length > 0 ? record.mode : "queue";
				sink.addEdge({
					kind: "send", from: ORCH_COORD, to: target, time, mode,
					messageId: typeof record.messageId === "string" ? record.messageId : undefined,
					reference: typeof args?.reference === "string" ? args.reference : undefined,
					delivered: result ? record.delivered !== false : undefined
				});
				return;
			}
			if (name === "task_wait" || name === "task_cancel") {
				sink.note({
					kind: name === "task_wait" ? "wait" : "cancel", time,
					detail: result ? { settled: record.settled, reason: record.reason, count: record.count } : undefined
				});
			}
		}
		/**
		 * PURE extraction: scan a chat snapshot ({ order, nodes.get }) for the
		 * orchestration record of the CURRENT session (the view's supervisor):
		 * task_spawn / task_spawn_batch children, task_send edges, inbound relay
		 * reports (context nodes with source.kind='coordinator' + form='relay'),
		 * task_wait / task_cancel notes. Every malformed shape is skipped —
		 * this function NEVER throws (the view wraps it once more, and the
		 * verify harness asserts the tolerance directly).
		 * @returns {{ children: object[], edges: object[], notes: object[], scanned: number }}
		 */
		function extractOrchestration(snapshot) {
			const out = { children: [], edges: [], notes: [], scanned: 0 };
			if (!snapshot || typeof snapshot !== "object") return out;
			const order = Array.isArray(snapshot.order) ? snapshot.order : [];
			const store = snapshot.nodes;
			const get = store && typeof store.get === "function" ? (key) => store.get(key) : () => null;
			const childById = new Map();
			const edgeKeys = new Set();
			const addChild = (entry) => {
				if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) return;
				const previous = childById.get(entry.sessionId);
				// A session id can reappear on window overlap (seq0 replay): keep the freshest record.
				if (!previous || (entry.time ?? 0) >= (previous.time ?? 0)) childById.set(entry.sessionId, entry);
			};
			const addEdge = (edge) => {
				if (typeof edge.to !== "string" || edge.to.length === 0) return;
				const key = `${edge.kind}|${edge.from}|${edge.to}|${edge.time ?? ""}|${edge.messageId ?? ""}`;
				if (edgeKeys.has(key)) return;
				edgeKeys.add(key);
				out.edges.push(edge);
			};
			for (const key of order) {
				let node = null;
				try { node = get(key); } catch { node = null; }
				if (!node || typeof node !== "object") continue;
				out.scanned += 1;
				const data = node.data;
				if (!data || typeof data !== "object") continue;
				if (node.kind === "tool-call") {
					const facts = orchToolFacts(data.root);
					if (facts) orchExtractTool(facts, { addChild, addEdge, note: (note) => out.notes.push(note) });
				} else if (node.kind === "context") {
					// Inbound report-back: the classifier renders source.kind !== 'user'
					// messages as context nodes; ours carry form='relay' + senderSessionId.
					const source = data.source;
					if (source && typeof source === "object" && source.kind === "coordinator" && source.form === "relay"
						&& typeof source.senderSessionId === "string" && source.senderSessionId.length > 0) {
						addEdge({ kind: "report", from: source.senderSessionId, to: ORCH_COORD, time: typeof data.time === "number" ? data.time : undefined });
					}
				}
			}
			out.children = [...childById.values()].sort((left, right) => ((left.time ?? 0) - (right.time ?? 0)) || (left.sessionId < right.sessionId ? -1 : 1));
			return out;
		}
		/**
		 * PURE deterministic layered layout (no physics, no randomness): the
		 * supervisor node centered on top; one row per team below (teams in
		 * code-point order, the ungrouped row LAST); children inside a row in
		 * extraction order (spawn time, then session id). Same input → same
		 * output on every call and every machine.
		 * @returns {{ nodes: Record<string, {x:number,y:number}>, rows: {team:string,y:number,ids:string[]}[], size: {width:number,height:number} }}
		 */
		function layoutTopology(extraction) {
			const L = ORCH_LAYOUT;
			const children = extraction && Array.isArray(extraction.children) ? extraction.children : [];
			const groups = new Map();
			for (const child of children) {
				if (!child || typeof child.sessionId !== "string") continue;
				const team = typeof child.team === "string" && child.team.length > 0 ? child.team : "";
				const bucket = groups.get(team);
				if (bucket) bucket.push(child);
				else groups.set(team, [child]);
			}
			const grouped = [...groups.keys()].filter((team) => team !== "").sort((left, right) => (left < right ? -1 : 1));
			const ordered = groups.has("") ? [...grouped, ""] : grouped;
			const rows = ordered.map((team, index) => {
				// In-row order is the extraction's (spawn time, then session id) —
				// re-sorted here so the pure layout stays deterministic even when
				// fed unsorted children directly.
				const bucket = groups.get(team).slice()
					.sort((left, right) => ((left.time ?? 0) - (right.time ?? 0)) || (left.sessionId < right.sessionId ? -1 : 1));
				return {
					team,
					y: L.padTop + L.nodeH + L.rowGap + L.labelH + index * (L.labelH + L.nodeH + L.rowGap),
					ids: bucket.map((child) => child.sessionId),
					width: bucket.length * L.nodeW + (bucket.length - 1) * L.gapX
				};
			});
			const contentWidth = Math.max(L.nodeW, ...rows.map((row) => row.width));
			const nodes = {};
			nodes[ORCH_COORD] = { x: (contentWidth - L.nodeW) / 2, y: L.padTop };
			for (const row of rows) {
				row.ids.forEach((id, column) => {
					nodes[id] = { x: (contentWidth - row.width) / 2 + column * (L.nodeW + L.gapX), y: row.y + L.labelH };
				});
			}
			const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
			return {
				nodes,
				rows,
				size: {
					width: contentWidth + L.padX * 2,
					height: lastRow ? lastRow.y + L.labelH + L.nodeH + L.padBottom : L.padTop + L.nodeH + L.padBottom
				}
			};
		}
		/** Live SessionSummary projection for one session id (pure; missing → null). */
		function orchSessionInfo(byId, sessionId) {
			if (!byId || typeof sessionId !== "string" || sessionId.length === 0) return null;
			let row;
			try { row = byId[sessionId]; } catch { return null; }
			if (!row || typeof row !== "object") return null;
			const projections = row.projectionValues && typeof row.projectionValues === "object" ? row.projectionValues : {};
			let todos = null;
			if (Array.isArray(projections.todos)) {
				let done = 0;
				for (const todo of projections.todos) if (todo && todo.status === "completed") done += 1;
				todos = { done, total: projections.todos.length };
			}
			const goal = projections.goal && typeof projections.goal === "object" ? projections.goal.goal : undefined;
			return {
				running: row.running === true,
				completed: row.completed === true,
				updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : undefined,
				title: typeof row.displayTitle === "string" && row.displayTitle.length > 0 ? row.displayTitle
					: typeof row.title === "string" && row.title.length > 0 ? row.title : undefined,
				todos,
				goalPhase: goal && typeof goal === "object" && typeof goal.phase === "string" ? goal.phase : undefined
			};
		}
		/** Relative-time text for a millisecond timestamp (pure, locale-formatted via t). */
		function orchAgoText(ms, now, t) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return t("orch.time.unknown");
			const delta = Math.max(0, now - ms);
			if (delta < 10000) return t("orch.time.now");
			const seconds = Math.floor(delta / 1000);
			if (seconds < 60) return t("orch.time.sec", { n: seconds });
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return t("orch.time.min", { n: minutes });
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return t("orch.time.hour", { n: hours });
			return t("orch.time.day", { n: Math.floor(hours / 24) });
		}
		/** SVG curve between a source node's bottom edge and a target node's top edge. */
		function orchEdgePath(x1, y1, x2, y2) {
			const bend = Math.max(24, Math.abs(y2 - y1) * 0.45);
			return `M ${x1} ${y1} C ${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
		}
		/** Guarded extraction wrapper: never throws, reports the failure instead. */
		function safeExtractOrchestration(snapshot) {
			try {
				return { ok: true, ...extractOrchestration(snapshot) };
			} catch (error) {
				return { ok: false, error: String((error && error.message) || error), children: [], edges: [], notes: [] };
			}
		}
		/**
		 * The "编排" conversation view: live orchestration topology with the
		 * CURRENT session as the supervisor. Pure client-side READ-ONLY view
		 * (zero host changes, zero writes). Seats come from the standard
		 * session-scoped set: useChat (transcript), useSessions (live rows),
		 * sessionId; `t` arrives through the registration's locale namespace.
		 * Crash discipline: every optional seat read and effect body is
		 * guarded, and the derived+tree block sits in a try/catch that renders
		 * the failure itself — the host's SlotErrorBoundary must never
		 * abdicate this entry.
		 */
		function OrchestrationView(props) {
			ensureLocale();
			const t = (key, params) => {
				// Same dual-path interpolation as the settings tab (0.18.3): the
				// host-runtime hit and the bundled-dictionary fallback BOTH interpolate.
				let value;
				if (typeof props.t === "function") {
					try { value = props.t(key); } catch { value = undefined; }
					if (typeof value !== "string" || value.length === 0 || value === key || value === `${NS}.${key}`) value = undefined;
				}
				if (value === undefined) value = translateNow(key);
				return params ? value.replace(/\{(\w+)\}/g, (whole, name) => (params[name] !== undefined ? String(params[name]) : whole)) : value;
			};
			const [refreshNonce, setRefreshNonce] = react.useState(0);
			const [nowTick, setNowTick] = react.useState(() => Date.now());
			const [flash, setFlash] = react.useState(null);
			// 0.21.1 (kept in 0.22.0): manual history paging — the transcript is
			// a finite window, so long supervisor sessions can hold spawn
			// records OUTSIDE it; loadOlder() pages the store back and the
			// snapshot change re-runs extraction automatically.
			const [loadingOlder, setLoadingOlder] = react.useState(false);
			const localeSnapshot = useStore ? useStore(subscribeLocale, getLocaleSnapshot) : NO_LOCALE_SNAPSHOT;
			// Keep relative times and the RECENT_MS flow window fresh (every 30s).
			react.useEffect(() => {
				try {
					const timer = setInterval(() => { try { setNowTick(Date.now()); } catch { /* keep the last tick */ } }, 30000);
					return () => { try { clearInterval(timer); } catch { /* noop */ } };
				} catch { return undefined; }
			}, []);
			// Optional seat reads: an absent OR throwing seat degrades to a
			// diagnostics line — never a render throw (SlotErrorBoundary abdicates).
			let chat = null;
			let chatError = null;
			try {
				if (typeof props.useChat === "function") chat = props.useChat((snapshot) => snapshot);
			} catch (error) { chatError = String((error && error.message) || error); }
			let sessionsList = null;
			let sessionsError = null;
			try {
				if (typeof props.useSessions === "function") sessionsList = props.useSessions((snapshot) => snapshot);
			} catch (error) { sessionsError = String((error && error.message) || error); }
			// hasMore: the session face's history flag (better-display reads the
			// same seat: props.useSession(snapshot => snapshot.hasMore)).
			let hasMore = null;
			try {
				if (typeof props.useSession === "function") hasMore = props.useSession((snapshot) => !!(snapshot && snapshot.hasMore));
			} catch { hasMore = null; }
			try {
			const coordinatorId = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId : "";
			const extraction = chat !== null ? safeExtractOrchestration(chat) : { ok: true, children: [], edges: [], notes: [] };
			const children = extraction.children;
			const layout = layoutTopology(extraction);
			const byId = sessionsList && sessionsList.byId && typeof sessionsList.byId === "object" ? sessionsList.byId : null;
			const coordinatorLive = orchSessionInfo(byId, coordinatorId);
			const now = nowTick;
			const notesMeta = [];
			const waitCount = extraction.notes.filter((note) => note.kind === "wait").length;
			const cancelCount = extraction.notes.filter((note) => note.kind === "cancel").length;
			if (waitCount > 0) notesMeta.push(t("orch.notes.wait", { n: waitCount }));
			if (cancelCount > 0) notesMeta.push(t("orch.notes.cancel", { n: cancelCount }));
			const openChild = (child) => {
				const id = child.sessionId;
				let failure = null;
				try {
					// Lazy sighting through ctx.get() — the sanctioned bypass the
					// runner's inject gate (see the ensureLocale note); a direct
					// property read of the sessions service would throw under our
					// "slots"-only declaration, and open() itself fails loud on
					// unknown ids.
					const svc = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("sessions") : undefined;
					if (svc && typeof svc.open === "function") {
						svc.open(id);
						return;
					}
					failure = "sessions service unavailable";
				} catch (error) {
					failure = String((error && error.message) || error);
				}
				// Degraded path: copy the session id so the user can act anyway.
				void copyText(id).then((ok) => {
					setFlash(ok
						? { kind: "info", text: t("orch.open.copied", { message: failure, id }) }
						: { kind: "error", text: t("orch.open.copyFailed", { message: failure, id }) });
					try { setTimeout(() => setFlash(null), 6000); } catch { /* flash simply stays */ }
				});
			};
			const h = react.createElement;
			// 0.21.1 history paging (kept in 0.22.0): sessions face →
			// binding(sessionId).session → loadOlder() (better-display index.tsx
			// L33-38 does exactly this with its declared inject; we sight the
			// same service through ctx.get() under our slots-only declaration).
			// Every failure lands as a flash line — never a throw.
			const loadOlderHistory = () => {
				if (loadingOlder) return;
				try { setLoadingOlder(true); } catch { /* noop */ }
				const finish = (message) => {
					try { setLoadingOlder(false); } catch { /* noop */ }
					if (message !== null) {
						try {
							setFlash({ kind: "error", text: message });
							setTimeout(() => setFlash(null), 6000);
						} catch { /* flash simply stays */ }
					}
				};
				try {
					const svc = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("sessions") : undefined;
					const binding = svc && typeof svc.binding === "function" ? svc.binding(coordinatorId) : undefined;
					const face = binding && typeof binding === "object" ? binding.session : undefined;
					if (!face || typeof face.loadOlder !== "function") {
						finish(t("orch.history.failed", { message: "sessions face unavailable" }));
						return;
					}
					const result = face.loadOlder();
					if (result && typeof result.then === "function") {
						result.then(
							() => finish(null),
							(error) => finish(t("orch.history.failed", { message: String((error && error.message) || error) }))
						);
					} else finish(null);
				} catch (error) {
					finish(t("orch.history.failed", { message: String((error && error.message) || error) }));
				}
			};
			const historyButton = hasMore === true
				? h("button", {
					type: "button",
					className: "orchViewBtn",
					disabled: loadingOlder,
					onClick: loadOlderHistory
				}, loadingOlder ? t("orch.history.loading") : t("orch.history.more"))
				: null;
			const L = ORCH_LAYOUT;
			const statusChip = (state) => h("span", { className: "orchViewChip", "data-kind": "status", "data-state": state },
				t(state === "running" ? "orch.status.running" : state === "completed" ? "orch.status.completed" : state === "idle" ? "orch.status.idle" : "orch.status.unknown"));
			const liveState = (live) => (live ? (live.running ? "running" : live.completed ? "completed" : "idle") : "unknown");
			const chipsFor = (live) => [
				live && live.todos ? h("span", { key: "todos", className: "orchViewChip", "data-kind": "todos" }, t("orch.todos", { done: live.todos.done, total: live.todos.total })) : null,
				live && live.goalPhase ? h("span", { key: "goal", className: "orchViewChip", "data-kind": "goal" }, t("orch.goal", { phase: live.goalPhase })) : null
			];
			// NOTE (phase B placeholder): a child that itself spawned grandchildren
			// should render a nested-supervisor badge here (its own task_spawn
			// records live in ITS transcript — a second-window lookup, deferred).
			const childCard = (child) => {
				const pos = layout.nodes[child.sessionId];
				if (!pos) return null;
				const live = orchSessionInfo(byId, child.sessionId);
				const state = liveState(live);
				return h("button", {
					type: "button",
					key: child.sessionId,
					className: `orchViewNode${state === "running" ? " orchViewBreath" : ""}`,
					"data-role": "child",
					"data-state": state,
					style: { left: `${pos.x}px`, top: `${pos.y}px`, width: `${L.nodeW}px` },
					onClick: () => openChild(child),
					title: child.sessionId
				},
					h("div", { className: "orchViewNodeTitle" }, (live && live.title) || child.title || child.sessionId),
					h("div", { className: "orchViewNodeMeta" },
						h("span", { className: "orchViewId" }, child.shortId || child.sessionId.slice(-8)),
						child.model && typeof child.model.model === "string" && child.model.model.length > 0
							? h("span", { className: "orchViewModel" }, child.model.model) : null
					),
					h("div", { className: "orchViewChips" },
						child.team ? h("span", { className: "orchViewChip", "data-kind": "team" }, child.team) : null,
						statusChip(state),
						...chipsFor(live)
					),
					h("div", { className: "orchViewNodeTime" }, orchAgoText(live && live.updatedAt ? live.updatedAt : child.time, now, t))
				);
			};
			const coordPos = layout.nodes[ORCH_COORD] || { x: 0, y: L.padTop };
			const coordinatorState = liveState(coordinatorLive);
			const coordinatorCard = h("div", {
				className: `orchViewNode${coordinatorState === "running" ? " orchViewBreath" : ""}`,
				"data-role": "coordinator",
				"data-state": coordinatorState,
				style: { left: `${coordPos.x}px`, top: `${coordPos.y}px`, width: `${L.nodeW}px` }
			},
				h("div", { className: "orchViewNodeTitle" }, (coordinatorLive && coordinatorLive.title) || coordinatorId || t("orch.coordinator")),
				h("div", { className: "orchViewChips" },
					h("span", { className: "orchViewChip", "data-kind": "team" }, t("orch.coordinator")),
					statusChip(coordinatorState),
					...chipsFor(coordinatorLive)
				),
				h("div", { className: "orchViewNodeTime" }, orchAgoText(coordinatorLive && coordinatorLive.updatedAt, now, t))
			);
			// Edges: spawn (solid, downward), send (accent, downward, mode label),
			// report (dashed, upward from the child to the supervisor). Edges with
			// activity inside RECENT_MS get the dash-flow shimmer.
			const edgeElements = [];
			for (const edge of extraction.edges) {
				if (edge.kind !== "spawn" && edge.kind !== "send" && edge.kind !== "report") continue;
				const from = layout.nodes[edge.from];
				const to = layout.nodes[edge.to];
				if (!from || !to) continue; // e.g. a send aimed at a session this window never saw spawning
				const recent = typeof edge.time === "number" && edge.time > 0 && now - edge.time < RECENT_MS;
				const downward = edge.kind !== "report";
				const x1 = from.x + L.nodeW / 2;
				const y1 = downward ? from.y + L.nodeH : from.y;
				const x2 = to.x + L.nodeW / 2;
				const y2 = downward ? to.y : to.y + L.nodeH;
				const className = `orchViewEdge orchViewEdge${edge.kind === "spawn" ? "Spawn" : edge.kind === "send" ? "Send" : "Report"}${recent ? " orchViewFlow" : ""}`;
				const marker = edge.kind === "send" ? "url(#orchViewArrowSend)" : "url(#orchViewArrow)";
				edgeElements.push(h("path", { key: `edge:${edge.kind}:${edge.to}:${edge.time ?? ""}:${edge.messageId ?? ""}:${edgeElements.length}`, d: orchEdgePath(x1, y1, x2, y2), className, markerEnd: marker }));
				if (edge.kind === "send" && typeof edge.mode === "string") {
					edgeElements.push(h("text", { key: `label:${edgeElements.length}`, className: "orchViewEdgeLabel", x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, textAnchor: "middle" }, edge.mode));
				}
			}
			const svg = h("svg", {
				className: "orchViewSvg",
				width: layout.size.width,
				height: layout.size.height,
				viewBox: `0 0 ${layout.size.width} ${layout.size.height}`
			},
				h("defs", null,
					h("marker", { id: "orchViewArrow", markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: "auto", markerUnits: "userSpaceOnUse" },
						h("path", { d: "M0,0 L7,3.5 L0,7 Z", fill: "var(--dsw-alias-border-l2,#c9ced6)" })),
					h("marker", { id: "orchViewArrowSend", markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: "auto", markerUnits: "userSpaceOnUse" },
						h("path", { d: "M0,0 L7,3.5 L0,7 Z", fill: "var(--dsw-alias-accent,#2563eb)" }))
				),
				...edgeElements
			);
			const rowLabels = layout.rows.map((row) => h("div", {
				key: `row:${row.team}`,
				className: "orchViewRowLabel",
				style: { left: `${L.padX}px`, top: `${row.y}px` }
			}, `${row.team === "" ? t("orch.ungrouped") : row.team} · ${row.ids.length}`));
			const diagnostics = [];
			if (chatError !== null) diagnostics.push(h("p", { key: "chat-err", className: "orchViewFlash", "data-kind": "error" }, t("orch.degraded.chat", { message: chatError })));
			else if (chat === null) diagnostics.push(h("p", { key: "chat-missing", className: "orchViewFlash", "data-kind": "error" }, t("orch.degraded.chat", { message: "useChat seat unavailable" })));
			if (sessionsError !== null) diagnostics.push(h("p", { key: "sess-err", className: "orchViewFlash", "data-kind": "error" }, t("orch.degraded.sessions", { message: sessionsError })));
			else if (sessionsList === null) diagnostics.push(h("p", { key: "sess-missing", className: "orchViewFlash" }, t("orch.degraded.sessions")));
			if (extraction.ok === false) {
				diagnostics.push(h("p", { key: "extract-err", className: "orchViewFlash", "data-kind": "error" },
					t("orch.error.extract", { message: extraction.error }),
					" ",
					h("button", { type: "button", className: "orchViewBtn", onClick: () => { try { setRefreshNonce((nonce) => nonce + 1); } catch { /* noop */ } } }, t("orch.retry"))));
			}
			const tree = h("div", { className: "orchViewRoot", key: `${refreshNonce}:${localeSnapshot && localeSnapshot.revision}` },
				h("div", { className: "orchViewToolbar" },
					h("h2", { className: "orchViewTitle" }, t("view.tab")),
					h("span", { className: "orchViewMeta" }, t("orch.children", { n: children.length })),
					notesMeta.length > 0 ? h("span", { className: "orchViewMeta" }, notesMeta.join(" · ")) : null,
					historyButton,
					h("button", { type: "button", className: "orchViewBtn", onClick: () => { try { setRefreshNonce((nonce) => nonce + 1); setNowTick(Date.now()); } catch { /* noop */ } } }, t("orch.refresh")),
					h("span", { className: "orchViewLegend" },
						h("span", null, h("i", { className: "orchViewLegendKey", "data-kind": "spawn" }), t("orch.legend.spawn")),
						h("span", null, h("i", { className: "orchViewLegendKey", "data-kind": "send" }), t("orch.legend.send")),
						h("span", null, h("i", { className: "orchViewLegendKey", "data-kind": "report" }), t("orch.legend.report")),
						h("span", null, t("orch.legend.recent"))
					)
				),
				flash ? h("p", { className: "orchViewFlash", "data-kind": flash.kind }, flash.text) : null,
				...diagnostics,
				children.length === 0
					? h("div", { className: "orchViewEmpty" },
						h("p", { className: "orchViewEmptyTitle" }, t("orch.empty.title")),
						h("p", { className: "orchViewEmptyText" }, t("orch.empty.hint")),
						chat !== null && extraction.ok !== false
							? h("p", { className: "orchViewEmptyText" }, t("orch.empty.scanned", { n: extraction.scanned ?? 0 })) : null,
						hasMore === true
							? h("p", { className: "orchViewEmptyText" }, t("orch.empty.windowHint")) : null,
						historyButton,
						h("p", { className: "orchViewEmptyText" }, t("orch.empty.suffix")))
					: h("div", { className: "orchViewCanvas" },
						h("div", { className: "orchViewLayer", style: { width: `${layout.size.width}px`, height: `${layout.size.height}px` } },
							svg,
							...rowLabels,
							coordinatorCard,
							...children.map(childCard)
						))
			);
			return tree;
			} catch (error) {
				// Last-resort net (0.18.2 discipline): render the failure ourselves —
				// the host's SlotErrorBoundary would otherwise abdicate the entry and
				// leave a blank tab with the reason only in the console.
				const hh = react.createElement;
				return hh("div", { className: "orchViewRoot" },
					hh("h2", { className: "orchViewTitle" }, t("view.tab")),
					hh("p", { className: "orchViewFlash", "data-kind": "error" }, t("orch.error.render", { message: String((error && error.message) || error) })),
					hh("button", { type: "button", className: "orchViewBtn", onClick: () => { try { setRefreshNonce((nonce) => nonce + 1); } catch { /* noop */ } } }, t("orch.retry"))
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
			// Orchestration view (0.20.0): the third conversation tab (after the
			// native chat=0 / trajectory=10 tabs) — a live, read-only topology of
			// everything this session supervises. Session-scoped slot: it remounts
			// per session identity, which the empty state covers for child/plain
			// sessions. All data comes from the standard seats (useChat /
			// useSessions / sessionId); navigation sights the sessions service
			// lazily through ctx.get() inside the component.
			ctx.slots.inject("conversation.view", () => {
				installOrchStyles();
				return ctx.slots.register({
					name: "conversation.view",
					id: "orchestration",
					order: 20,
					locale: NS,
					label: () => translateNow("view.tab")
				}, OrchestrationView);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		// Pure-function test surface for the orchestration view (verify harness
		// drives synthetic fixtures through these; never used by the UI itself).
		exports.__orchestration = {
			extractOrchestration,
			layoutTopology,
			orchToolFacts,
			orchParseJson,
			orchSessionInfo,
			orchAgoText,
			orchEdgePath,
			RECENT_MS,
			ORCH_COORD,
			ORCH_LAYOUT
		};
		return module.exports;
	}
});
