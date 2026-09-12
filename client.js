/**
 * dsh-plugin-task-coordinator — client module (0.25.2)
 *
 * Current UI: responsive grouped topology with selection, a read-only inspector,
 * aggregated relations, and explicit navigation. No host writes or new services.
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
				"orch.empty.partial": "当前记录中未找到子任务",
				"orch.empty.unavailable": "暂时无法读取任务关系",
				"orch.empty.unavailableHint": "会话记录暂不可用。请稍后刷新，或切回对话检查会话是否正常加载。",
				"orch.service.missing": "会话记录服务不可用",
				"orch.summary": "{n} 个任务 · {running} 运行中 · {completed} 已完成",
				"orch.supervising": "监督 {n} 个子任务",
				"orch.todos.none": "待办未提供",
				"orch.topology": "任务关系图",
				"orch.detail": "任务详情",
				"orch.detail.todos": "待办",
				"orch.detail.updated": "最近更新",
				"orch.detail.model": "派发时模型",
				"orch.detail.goal": "目标阶段",
				"orch.detail.id": "会话 ID",
				"orch.detail.unknown": "当前无法读取此会话的实时状态，任务关系来自已加载记录。",
				"orch.detail.relations": "关系记录",
				"orch.detail.scope": "本总控已加载的往来记录",
				"orch.detail.recent": "显示最近 20 条记录",
				"orch.open": "打开会话",
				"orch.history.partial": "仅显示已加载记录",
				"orch.history.loaded": "历史记录已载入",
				"orch.event.spawn": "已派发",
				"orch.event.send": "已发送指令",
				"orch.event.report": "已收到汇报",
				"orch.event.failed": "指令未送达",
				"orch.event.unconfirmed": "指令状态未确认",
				"orch.event.spawnHint": "总控派发了此子任务。",
				"orch.event.reportHint": "此任务向总控发送了汇报。",
				"orch.event.steerHint": "总控发送了插入执行指令（steer）。",
				"orch.event.queueHint": "总控发送了后续执行指令（queue）。",
				"orch.event.failedHint": "此次指令投递失败，未计入成功连线。",
				"view.tab": "编排",
				"orch.empty.title": "本会话尚未派发子任务",
				"orch.empty.hint": "在对话中让总控拆分并派发任务后，即可在这里查看任务关系与进展。",
				"orch.empty.suffix": "在子会话或普通会话中打开本页时同样显示此空态——编排视图以当前会话为总控。",
				"orch.coordinator": "总控",
				"orch.ungrouped": "未编组",
				"orch.status.running": "运行中",
				"orch.status.idle": "空闲",
				"orch.status.completed": "已完成",
				"orch.status.unknown": "状态未知",
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
				"orch.legend.recent": "流动连线 · 组内最近 2 分钟有往来",
				"orch.history.more": "载入更早记录",
				"orch.history.loading": "正在加载更早记录…",
				"orch.history.failed": "载入更早记录失败：{message}",
				"orch.empty.scanned": "已查看 {n} 条记录，未发现派发记录。",
				"orch.empty.windowHint": "早期派发可能尚未加载。载入更早记录后，任务关系会自动补充。"
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
				"orch.empty.partial": "No child tasks in the loaded records",
				"orch.empty.unavailable": "Task relationships are unavailable",
				"orch.empty.unavailableHint": "Session records are unavailable. Refresh later or check that the conversation has loaded.",
				"orch.service.missing": "Session records service unavailable",
				"orch.summary": "{n} tasks · {running} running · {completed} completed",
				"orch.supervising": "Supervising {n} child tasks",
				"orch.todos.none": "No to-do data",
				"orch.topology": "Task relationships",
				"orch.detail": "Task details",
				"orch.detail.todos": "To-dos",
				"orch.detail.updated": "Last updated",
				"orch.detail.model": "Model at dispatch",
				"orch.detail.goal": "Goal phase",
				"orch.detail.id": "Session ID",
				"orch.detail.unknown": "Live status is unavailable. Relationships come from the loaded records.",
				"orch.detail.relations": "Relation history",
				"orch.detail.scope": "Exchanges loaded in this supervisor session",
				"orch.detail.recent": "Showing the latest 20 records",
				"orch.open": "Open conversation",
				"orch.history.partial": "Loaded records only",
				"orch.history.loaded": "History loaded",
				"orch.event.spawn": "Dispatched",
				"orch.event.send": "Instruction sent",
				"orch.event.report": "Report received",
				"orch.event.failed": "Instruction not delivered",
				"orch.event.unconfirmed": "Delivery unconfirmed",
				"orch.event.spawnHint": "The supervisor dispatched this task.",
				"orch.event.reportHint": "This task sent a report to the supervisor.",
				"orch.event.steerHint": "The supervisor sent a mid-run instruction (steer).",
				"orch.event.queueHint": "The supervisor sent a follow-up instruction (queue).",
				"orch.event.failedHint": "Delivery failed and is excluded from successful links.",
				"view.tab": "Orchestration",
				"orch.empty.title": "No tasks dispatched in this session",
				"orch.empty.hint": "Ask the supervisor to split and dispatch tasks in the conversation. Their relationships and progress will appear here.",
				"orch.empty.suffix": "Opening this tab inside a child session or a plain session shows the same empty state — the view always anchors on the current session.",
				"orch.coordinator": "Supervisor",
				"orch.ungrouped": "Ungrouped",
				"orch.status.running": "Running",
				"orch.status.idle": "Idle",
				"orch.status.completed": "Completed",
				"orch.status.unknown": "Unknown",
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
				"orch.legend.recent": "Flow: activity in the selected group within 2 minutes",
				"orch.history.more": "Load older records",
				"orch.history.loading": "Loading older records…",
				"orch.history.failed": "Loading older records failed: {message}",
				"orch.empty.scanned": "Checked {n} records; no dispatches found.",
				"orch.empty.windowHint": "Earlier dispatches may not be loaded yet. Load older records to extend the task overview."
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
		const ORCH_CSS = `
.orchViewRoot{--orch-ink:var(--dsw-alias-label-primary,#161b26);--orch-muted:var(--dsw-alias-label-secondary,#687284);--orch-line:var(--dsw-alias-border-l2,#e3e7ee);--orch-surface:var(--dsw-alias-bg-base,#fff);--orch-soft:var(--dsw-alias-bg-module-platform,#f5f6f9);--orch-accent:var(--dsw-alias-state-business-primary,#4176e6);--orch-green:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 65%,var(--orch-ink));max-width:1440px;width:100%;min-width:0;align-self:center;margin:0 auto;min-height:100%;box-sizing:border-box;color:var(--orch-ink);font-family:var(--dsw-font-family,inherit);container:orch / inline-size;font-size:14px;line-height:1.5}
.orchViewRoot *{box-sizing:border-box}
.orchViewRoot{padding-bottom:calc(var(--dsh-composer-height,0px) + 24px)}
.orchViewRoot ::selection{background:color-mix(in srgb,var(--orch-accent) 20%,transparent)}
.orchViewRoot button{font:inherit;cursor:pointer}
.orchViewRoot button:focus-visible{outline:2px solid var(--orch-accent);outline-offset:4px}
.orchViewRoot button:disabled{cursor:wait;opacity:.5}
.orchViewWorkspace{display:grid;grid-template-columns:minmax(0,1fr) 350px;align-items:start;min-height:600px}
.orchViewMain{min-width:0;padding:30px 24px 26px;display:flex;flex-direction:column;min-height:600px}
.orchViewToolbar{display:flex;gap:18px;align-items:start;justify-content:space-between;flex-wrap:wrap;margin-bottom:30px}
.orchViewHeading{min-width:0;flex:1 1 260px}
.orchViewHeadingLine{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.orchViewTitle{margin:0;font-size:23px;line-height:1.4;font-weight:650;overflow-wrap:anywhere}
.orchViewMeta{margin:10px 0 0;color:var(--orch-muted);font-size:13px;line-height:22px}
.orchViewHistory{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--orch-muted);padding-top:6px}
.orchViewBtn{display:inline-flex;gap:6px;align-items:center;justify-content:center;min-height:32px;border:1px solid var(--orch-line);padding:4px 10px;border-radius:7px;background:transparent;color:var(--orch-muted);white-space:nowrap}
.orchViewBtn:hover{background:var(--orch-soft);color:var(--orch-ink)}
.orchViewLink{border:0;padding:4px;color:var(--orch-accent);background:none;font-size:12px!important;min-height:32px}
.orchViewFlash{font-size:13px;color:var(--orch-muted);margin:0 24px 12px;overflow-wrap:anywhere}
.orchViewFlash[data-kind='error']{color:var(--dsw-alias-danger,#bd3333)}
.orchViewCanvas{position:relative;min-width:0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--orch-line) transparent}
.orchViewLayer{position:relative;margin:0 auto;max-width:100%}
.orchViewSvg{position:absolute;inset:0;pointer-events:none;overflow:visible}
.orchViewGroup{position:absolute;border:1px solid var(--orch-line);border-radius:10px;background:var(--orch-surface)}
.orchViewGroupHeading{display:flex;gap:8px;align-items:center;height:48px;padding:0 12px;background:color-mix(in srgb,var(--orch-soft) 64%,transparent);border-radius:9px 9px 0 0;min-width:0}
.orchViewGroupHeading h3{margin:0;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orchViewCount{font-size:12px;color:var(--orch-muted);font-variant-numeric:tabular-nums}
.orchViewNode{position:absolute;padding:13px 10px;border:1px solid var(--orch-line);border-radius:9px;background:var(--orch-surface);color:var(--orch-ink);text-align:left;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:8px;transition:border-color 140ms,background-color 140ms}
.orchViewNode:hover{border-color:color-mix(in srgb,var(--orch-accent) 50%,var(--orch-line))}
.orchViewNode[aria-pressed='true']{border-color:var(--orch-accent);background:color-mix(in srgb,var(--orch-accent) 4%,var(--orch-surface));box-shadow:0 0 0 1px var(--orch-accent) inset}
.orchViewNode[data-role='coordinator']{border-color:color-mix(in srgb,var(--orch-accent) 60%,var(--orch-line));background:color-mix(in srgb,var(--orch-accent) 4%,var(--orch-surface));flex-direction:row;align-items:flex-start;padding:18px;gap:12px;cursor:default}
.orchViewNodeTitle{font-size:14px;line-height:21px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;max-width:100%}
.orchViewCoordinatorCopy{min-width:0;display:flex;flex-direction:column;gap:6px}
.orchViewNodeChips{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.orchViewChip{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:19px;white-space:nowrap;color:var(--orch-muted)}
.orchViewChip[data-kind='status']::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.orchViewChip[data-state='running']{color:var(--orch-accent)}
.orchViewChip[data-state='completed']{color:var(--orch-green)}
.orchViewChip[data-state='unknown']{color:var(--orch-muted)}
.orchViewRole{font-size:12px;color:var(--orch-muted);background:var(--orch-soft);padding:2px 8px;border-radius:6px}
.orchViewNodeTodo{font-size:13px;color:var(--orch-muted);font-variant-numeric:tabular-nums}
.orchViewId{font-size:11px;color:var(--orch-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;margin-top:auto}
.orchViewModel{font-size:12px;color:var(--orch-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.orchViewIconTile{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:var(--orch-soft);color:var(--orch-muted);flex:none}
.orchViewNode[aria-pressed='true'] .orchViewIconTile,.orchViewNode[data-role='coordinator'] .orchViewIconTile{background:color-mix(in srgb,var(--orch-accent) 10%,transparent);color:var(--orch-accent)}
.orchViewIcon{display:inline-block;width:19px;height:19px;flex:none;background:currentColor;mask:var(--orch-icon) center/contain no-repeat}
.orchViewEdge{fill:none;stroke:var(--orch-line);stroke-width:1.35}
.orchViewEdgeSend{stroke:var(--orch-accent);stroke-width:1.7}
.orchViewEdgeReport{stroke:var(--orch-muted);stroke-dasharray:5 4;opacity:.55}
.orchViewEdge[data-selected='false']{stroke:var(--orch-line);opacity:.8}
.orchViewFlow{stroke-dasharray:6 5;animation:orchViewFlowKf 1.5s linear infinite}
.orchViewEdgeReport.orchViewFlow{animation-direction:reverse}
@keyframes orchViewFlowKf{to{stroke-dashoffset:-22}}
.orchViewEdgeLabel{font-size:11px;fill:var(--orch-muted)}
.orchViewLegend{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:auto;padding-top:32px;font-size:11px;color:var(--orch-muted)}
.orchViewLegend span{display:inline-flex;gap:6px;align-items:center}
.orchViewLegendKey{width:23px;border-top:1.5px solid var(--orch-line)}
.orchViewLegendKey[data-kind='send']{border-color:var(--orch-accent)}
.orchViewLegendKey[data-kind='report']{border-color:var(--orch-muted);border-top-style:dashed}
.orchViewInspector{border-left:1px solid var(--orch-line);padding:30px 24px;min-width:0;align-self:stretch;overflow-wrap:anywhere}
.orchViewInspectorTop{display:flex;gap:10px;align-items:start;justify-content:space-between}
.orchViewInspector h2{font-size:21px;line-height:1.4;margin:0;font-weight:650}
.orchViewInspectorStatus{display:flex;gap:12px;align-items:center;margin:16px 0 12px}
.orchViewBreadcrumb{font-size:12px;color:var(--orch-muted);margin:0 0 26px;overflow-wrap:anywhere}
.orchViewFacts{display:grid;grid-template-columns:72px 72px minmax(0,1fr);gap:16px 12px;margin:0 0 24px}
.orchViewFacts div{min-width:0}
.orchViewFacts dt{font-size:12px;color:var(--orch-muted);margin-bottom:4px}
.orchViewFacts dd{margin:0;font-size:14px;overflow-wrap:anywhere}
.orchViewFacts .orchViewTodoValue{font-size:25px;font-weight:600;line-height:1.25;font-variant-numeric:tabular-nums}
.orchViewFactModel{grid-column:auto}
.orchViewPrimary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:38px;border:0;border-radius:7px;background:var(--orch-ink);color:var(--orch-surface);font-size:13px!important}
.orchViewPrimary:hover{opacity:.88}
.orchViewRelations{border-top:1px solid var(--orch-line);margin-top:28px;padding-top:24px}
.orchViewRelations h3{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:14px;font-weight:600}
.orchViewRelationHint{font-size:11px;color:var(--orch-muted);margin:0 0 20px}
.orchViewEvents{list-style:none;padding:0;margin:0}
.orchViewEvent{position:relative;padding:0 0 25px 21px;border-left:1px solid var(--orch-line);margin-left:5px}
.orchViewEvent:last-child{border-left-color:transparent;padding-bottom:0}
.orchViewEvent::before{content:'';position:absolute;left:-5px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--orch-muted);box-shadow:0 0 0 4px var(--orch-surface)}
.orchViewEvent[data-kind='send']::before{background:var(--orch-accent)}
.orchViewEvent[data-failed='true']::before{background:var(--dsw-alias-danger,#bd3333)}
.orchViewEventHeading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.orchViewEventHeading strong{font-size:13px;font-weight:600}
.orchViewEventHeading time{font-size:11px;color:var(--orch-muted);white-space:nowrap}
.orchViewEvent p{font-size:12px;color:var(--orch-muted);margin:5px 0 0;line-height:1.65}
.orchViewEmpty{padding:70px 24px;max-width:480px;margin:0 auto;text-align:center}
.orchViewEmpty h2{font-size:20px;margin:16px 0 10px}
.orchViewEmpty p{font-size:13px;line-height:1.8;color:var(--orch-muted);margin:8px 0 20px}
.orchViewEmpty .orchViewIconTile{width:48px;height:48px;margin:0 auto}
@container orch (max-width:900px){.orchViewWorkspace{grid-template-columns:minmax(0,1fr);min-height:0}.orchViewMain{min-height:0}.orchViewInspector{border-left:0;border-top:1px solid var(--orch-line)}.orchViewFacts{grid-template-columns:1fr 1fr 2fr}.orchViewFactModel{grid-column:auto}.orchViewInspector .orchViewPrimary{max-width:300px}.orchViewLegend{margin-top:0}.orchViewToolbar{margin-bottom:20px}}
@container orch (max-width:460px){.orchViewMain,.orchViewInspector{padding:20px 12px}.orchViewTitle{font-size:20px}.orchViewFacts{grid-template-columns:1fr 1fr}.orchViewFactModel{grid-column:auto}.orchViewHistory{padding:0}.orchViewNode{padding:12px 8px}.orchViewNodeTitle{font-size:13px}.orchViewLegend{gap:12px}}
@media(prefers-reduced-motion:reduce){.orchViewFlow{animation:none}.orchViewNode{transition:none}}
`;

		/* Tabler Icons 3.44.0, bundled SVG sources (https://tabler.io/icons).
 * MIT License
 *
 * Copyright (c) 2020-2026 Paweł Kuna
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
		const ORCH_ICONS = {
  "task": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n  class=\"icon icon-tabler icons-tabler-outline icon-tabler-layout-navbar\"\n>\n  <path stroke=\"none\" d=\"M0 0h24v24H0z\" fill=\"none\" />\n  <path d=\"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12\" />\n  <path d=\"M4 9l16 0\" />\n</svg>",
  "supervisor": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n  class=\"icon icon-tabler icons-tabler-outline icon-tabler-user\"\n>\n  <path stroke=\"none\" d=\"M0 0h24v24H0z\" fill=\"none\" />\n  <path d=\"M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0\" />\n  <path d=\"M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2\" />\n</svg>",
  "group": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n  class=\"icon icon-tabler icons-tabler-outline icon-tabler-subtask\"\n>\n  <path stroke=\"none\" d=\"M0 0h24v24H0z\" fill=\"none\" />\n  <path d=\"M6 9l6 0\" />\n  <path d=\"M4 5l4 0\" />\n  <path d=\"M6 5v11a1 1 0 0 0 1 1h5\" />\n  <path d=\"M12 8a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1l0 -2\" />\n  <path d=\"M12 16a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1l0 -2\" />\n</svg>",
  "done": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n  class=\"icon icon-tabler icons-tabler-outline icon-tabler-circle-check\"\n>\n  <path stroke=\"none\" d=\"M0 0h24v24H0z\" fill=\"none\" />\n  <path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0\" />\n  <path d=\"M9 12l2 2l4 -4\" />\n</svg>",
  "unknown": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n  class=\"icon icon-tabler icons-tabler-outline icon-tabler-help-circle\"\n>\n  <path stroke=\"none\" d=\"M0 0h24v24H0z\" fill=\"none\" />\n  <path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0\" />\n  <path d=\"M12 16v.01\" />\n  <path d=\"M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483\" />\n</svg>",
  "external": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n  class=\"icon icon-tabler icons-tabler-outline icon-tabler-external-link\"\n>\n  <path stroke=\"none\" d=\"M0 0h24v24H0z\" fill=\"none\" />\n  <path d=\"M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6\" />\n  <path d=\"M11 13l9 -9\" />\n  <path d=\"M15 4h5v5\" />\n</svg>",
  "refresh": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n  class=\"icon icon-tabler icons-tabler-outline icon-tabler-refresh\"\n>\n  <path stroke=\"none\" d=\"M0 0h24v24H0z\" fill=\"none\" />\n  <path d=\"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\" />\n  <path d=\"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4\" />\n</svg>"
};
		function installOrchStyles() {
			const existing = document.querySelector(`style[data-plugin="${STYLE_ID_ORCH}"]`);
			if (existing !== null) {
				// A client-module remount can retain the document's old style tag.
				if (existing.textContent !== ORCH_CSS) existing.textContent = ORCH_CSS;
				return () => {};
			}
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
		const ORCH_LAYOUT = { nodeW: 156, nodeH: 188, gapX: 24, padTop: 16 };

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
					delivered: result ? record.ok !== false && record.delivered !== false : undefined
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
		 * supervisor node centered on top; compact teams below (teams in
		 * first-dispatch order, the ungrouped row LAST); children inside a team in
		 * extraction order (spawn time, then session id). Same input → same
		 * output on every call and every machine.
		 * @returns {{ nodes: Record<string, {x:number,y:number}>, rows: {team:string,y:number,ids:string[]}[], size: {width:number,height:number} }}
		 */
		/** Pack teams by their actual card counts rather than equal-width slots.
		 * Large teams wrap internally; later bands route through the outer gutter. */
		function layoutTopology(extraction, availableWidth = 800) {
			const L = ORCH_LAYOUT;
			const width = Math.max(216, Number.isFinite(availableWidth) ? Math.floor(availableWidth) : 800);
			const groups = new Map();
			for (const child of extraction?.children || []) {
				if (!child || typeof child.sessionId !== "string") continue;
				const team = typeof child.team === "string" ? child.team : "";
				if (!groups.has(team)) groups.set(team, []);
				groups.get(team).push(child);
			}
			const firstDispatch = team => groups.get(team).reduce((first, child) => Math.min(first, child.time || 0), Infinity);
			const teams = [...groups.keys()].filter(Boolean).sort((a,b) => firstDispatch(a) - firstDispatch(b) || (a < b ? -1 : 1));
			if (groups.has("")) teams.push("");
			const innerWidth = width - 24;
			const maxColumns = Math.max(1, Math.min(3, Math.floor((innerWidth - 12) / 122)));
			const minCardWidth = Math.min(110, innerWidth - 24);
			const specifications = teams.map(team => {
				const bucket = groups.get(team).slice().sort((a,b) => ((a.time ?? 0) - (b.time ?? 0)) || (a.sessionId < b.sessionId ? -1 : 1));
				const columns = Math.min(maxColumns, bucket.length);
				return { team, bucket, columns, minWidth: 24 + columns * minCardWidth + (columns - 1) * 12 };
			});
			const bands = [];
			let band = [], usedWidth = 0;
			for (const spec of specifications) {
				const nextWidth = usedWidth + (band.length ? L.gapX : 0) + spec.minWidth;
				if (band.length && (band.length === 3 || nextWidth > innerWidth)) {
					bands.push(band); band = []; usedWidth = 0;
				}
				usedWidth += (band.length ? L.gapX : 0) + spec.minWidth;
				band.push(spec);
			}
			if (band.length) bands.push(band);
			const nodes = Object.create(null);
			const coordWidth = Math.min(258, width - 24);
			nodes[ORCH_COORD] = { x: (width - coordWidth) / 2, y: L.padTop, width: coordWidth, height: 132 };
			const rows = [];
			let y = L.padTop + 132 + 88;
			bands.forEach((members, bandIndex) => {
				const cardColumns = members.reduce((sum,spec) => sum + spec.columns, 0);
				const fixedWidth = members.reduce((sum,spec) => sum + 24 + (spec.columns - 1) * 12, 0) + (members.length - 1) * L.gapX;
				const nodeWidth = Math.min(L.nodeW, Math.floor((innerWidth - fixedWidth) / cardColumns));
				const bandWidth = fixedWidth + cardColumns * nodeWidth;
				let x = (width - bandWidth) / 2;
				let bandHeight = 0;
				for (const {team, bucket, columns} of members) {
					const groupWidth = 24 + columns * nodeWidth + (columns - 1) * 12;
					const height = 64 + Math.ceil(bucket.length / columns) * (L.nodeH + 12);
					const row = { team, x, y, width: groupWidth, height, band: bandIndex, ids: bucket.map(c => c.sessionId) };
					rows.push(row);
					bucket.forEach((child, i) => {
						nodes[child.sessionId] = { x: x + 12 + (i % columns) * (nodeWidth + 12), y: y + 64 + Math.floor(i / columns) * (L.nodeH + 12), width: nodeWidth, height: L.nodeH };
					});
					bandHeight = Math.max(bandHeight, height);
					x += groupWidth + L.gapX;
				}
				y += bandHeight + 56;
			});
			return { nodes, rows, groupColumns: Math.max(1, ...bands.map(members => members.length)), size: { width, height: rows.length ? y - 32 : 168 } };
		}
		/** One visual edge per relation and team, while the inspector retains
		 * individual events. Rejected sends never become successful graph edges. */
		function orchGroupRelations(extraction) {
			const teams = new Map(extraction.children.map(child => [child.sessionId, child.team || ""]));
			const grouped = new Map();
			for (const edge of extraction.edges) {
				const id = edge.kind === "report" ? edge.from : edge.to;
				if (!teams.has(id) || edge.delivered === false) continue;
				const team = teams.get(id);
				const key = JSON.stringify([team, edge.kind]);
				if (!grouped.has(key)) grouped.set(key, { team, kind: edge.kind, count: 0, time: 0, ids: new Set() });
				const row = grouped.get(key);
				row.count++;
				row.time = Math.max(row.time, edge.time || 0);
				row.ids.add(id);
			}
			return [...grouped.values()];
		}
		function orchTaskTitle(title) {
			return String(title || "").replace(/^\d{4}[｜|][^｜|]+[｜|]/u, "").trim();
		}
		function orchSelectedChild(children, selection, owner) {
			return children.find(child => selection?.owner === owner && child.sessionId === selection.id) || children[0] || null;
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
			const [selection, setSelection] = react.useState(null);
			const [viewWidth, setViewWidth] = react.useState(1180);
			const rootRef = react.useRef(null);
			const inspectorRef = react.useRef(null);
			react.useEffect(() => {
				let observer;
				const measure = () => {
					try {
						const width = rootRef.current?.getBoundingClientRect().width;
						if (width > 0) setViewWidth(Math.round(width));
					} catch { /* keep last measured layout */ }
				};
				try {
					measure();
					if (typeof ResizeObserver === "function" && rootRef.current) {
						observer = new ResizeObserver(measure);
						observer.observe(rootRef.current);
					}
					window.addEventListener?.("resize", measure);
				} catch { /* old hosts retain the bounded initial layout */ }
				return () => {
					try { observer?.disconnect(); window.removeEventListener?.("resize", measure); } catch { /* disposed */ }
				};
			}, [props.sessionId]);

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
			const layout = layoutTopology(extraction, viewWidth - (viewWidth > 900 ? 350 : 0) - (viewWidth <= 460 ? 24 : 48));
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
					className: "orchViewLink",
					disabled: loadingOlder,
					onClick: loadOlderHistory
				}, loadingOlder ? t("orch.history.loading") : t("orch.history.more"))
				: null;
			const L = ORCH_LAYOUT;
			const icon = (name, tile = false) => {
				const glyph = h("span", { className: "orchViewIcon", "aria-hidden": true, style: { "--orch-icon": `url("data:image/svg+xml,${encodeURIComponent(ORCH_ICONS[name] || ORCH_ICONS.task)}")` } });
				return tile ? h("span", { className: "orchViewIconTile", "aria-hidden": true }, glyph) : glyph;
			};
			const statusChip = (state) => h("span", { className: "orchViewChip", "data-kind": "status", "data-state": state }, t(`orch.status.${state}`));
			const liveState = live => live ? (live.running ? "running" : live.completed ? "completed" : "idle") : "unknown";
			const selected = orchSelectedChild(children, selection, coordinatorId);
			const selectedId = selected?.sessionId;
			const selectedLive = selected ? orchSessionInfo(byId, selectedId) : null;
			const fullTitle = child => orchSessionInfo(byId, child.sessionId)?.title || child.title || child.sessionId;
			const titleFor = child => orchTaskTitle(fullTitle(child));
			const coordinatorTitle = orchTaskTitle(coordinatorLive?.title || t("orch.coordinator"));
			const todoText = live => live?.todos ? t("orch.todos", live.todos) : t("orch.todos.none");
			const childCard = child => {
				const pos = layout.nodes[child.sessionId];
				if (!pos) return null;
				const live = orchSessionInfo(byId, child.sessionId);
				const state = liveState(live);
				return h("button", {
					type: "button", key: child.sessionId, className: "orchViewNode", "data-role": "child", "data-state": state,
					"aria-pressed": child.sessionId === selectedId,
					"aria-label": `${titleFor(child)} · ${t(`orch.status.${state}`)} · ${todoText(live)}`,
					style: { left: pos.x, top: pos.y, width: pos.width, height: pos.height },
					title: fullTitle(child),
					onClick: () => {
						setSelection({ owner: coordinatorId, id: child.sessionId });
						if (viewWidth <= 900) {
							try { inspectorRef.current?.scrollIntoView({ block: "start", behavior: "instant" }); } catch { /* selection still works */ }
						}
					}
				}, icon(state === "completed" ? "done" : state === "unknown" ? "unknown" : "task", true),
					h("span", { className: "orchViewNodeTitle" }, titleFor(child)),
					statusChip(state),
					h("span", { className: "orchViewNodeTodo" }, todoText(live)),
					h("span", { className: "orchViewId", title: child.sessionId }, child.shortId || child.sessionId.slice(-8)));
			};
			const cp = layout.nodes[ORCH_COORD];
			const coordinatorCard = h("div", { className: "orchViewNode", "data-role": "coordinator", "data-state": liveState(coordinatorLive), style: { left: cp.x, top: cp.y, width: cp.width, minHeight: cp.height }, title: coordinatorLive?.title },
				icon("supervisor", true), h("div", { className: "orchViewCoordinatorCopy" },
					h("div", { className: "orchViewNodeTitle" }, coordinatorTitle),
					h("div", { className: "orchViewNodeChips" }, h("span", { className: "orchViewChip" }, t("orch.coordinator")), statusChip(liveState(coordinatorLive))),
					h("div", { className: "orchViewModel" }, coordinatorLive?.goalPhase ? t("orch.goal", { phase: coordinatorLive.goalPhase }) : t("orch.supervising", { n: children.length }))));
			// SVG is the actual topology geometry, not a replacement for icon art.
			// Inline paths use per-element arrow geometry to avoid global marker-id
			// collisions when two host conversation surfaces are mounted at once.
			const edgeElements = [];
			for (const relation of orchGroupRelations(extraction)) {
				const group = layout.rows.find(row => row.team === relation.team);
				if (!group) continue;
				const active = relation.ids.has(selectedId);
				const report = relation.kind === "report";
				const offset = relation.kind === "send" ? -6 : report ? 6 : 0;
				const x1 = cp.x + cp.width / 2 + offset;
				const y1 = cp.y + cp.height;
				const x2 = group.x + group.width / 2 + offset;
				const y2 = group.y;
				const middleY = y2 - 50 + offset;
				const recent = relation.time > 0 && now >= relation.time && now - relation.time < RECENT_MS;
				const base = `orchViewEdge orchViewEdge${relation.kind === "send" ? "Send" : report ? "Report" : "Spawn"}`;
				const isLowerBand = group.band > 0;
				const railX = isLowerBand ? 6 + offset / 2 : x1;
				const start = isLowerBand ? `M${x1},${y1} V${y1+18} H${railX}` : `M${x1},${y1}`;
				const d = `${start} V${middleY - 6} Q${railX},${middleY} ${railX + Math.sign(x2-railX)*6},${middleY} H${x2-Math.sign(x2-railX)*6} Q${x2},${middleY} ${x2},${middleY+6} V${y2}`;
				edgeElements.push(h("path", { key: `${relation.team}:${relation.kind}`, d, "data-relation": true, className: `${base}${recent && active ? " orchViewFlow" : ""}`, "data-selected": active },
					h("title", null, `${t(`orch.legend.${relation.kind}`)} · ${relation.count}`)));
				edgeElements.push(h("path", { key: `arrow:${relation.team}:${relation.kind}`, d: report ? `M${x1-3},${y1+5} L${x1},${y1} L${x1+3},${y1+5}` : `M${x2-3},${y2-5} L${x2},${y2} L${x2+3},${y2-5}`, className: base, "data-selected": active }));
			}
			// Group membership links stay inside the header-to-card gutter. The
			// selected task gets a blue link without crossing another task's card.
			const memberEdges = layout.rows.flatMap(group => group.ids.map(id => {
				const pos = layout.nodes[id];
				const x = pos.x + pos.width / 2;
				return h("path", { key: `member:${id}`, d: `M${x},${pos.y-12} V${pos.y} m-3,-5 l3,5 l3,-5`, className: id === selectedId ? "orchViewEdge orchViewEdgeSend" : "orchViewEdge" });
			}));
			const groupElements = layout.rows.map(group => h("section", { key: group.team, className: "orchViewGroup", style: { left: group.x, top: group.y, width: group.width, height: group.height }, "aria-label": group.team || t("orch.ungrouped") },
				h("div", { className: "orchViewGroupHeading" }, icon("group"), h("h3", null, group.team || t("orch.ungrouped")), h("span", { className: "orchViewCount" }, `· ${group.ids.length}`))));
			const selectedEvents = selected ? extraction.edges.filter(edge => edge.to === selectedId || edge.from === selectedId).sort((a,b) => (a.time || 0) - (b.time || 0)) : [];
			const eventList = selectedEvents.slice(-20);
			const eventLabel = edge => t(edge.kind === "send" ? (edge.delivered === false ? "orch.event.failed" : edge.delivered === undefined ? "orch.event.unconfirmed" : "orch.event.send") : `orch.event.${edge.kind}`);
			const eventDescription = edge => edge.kind === "send"
				? t(edge.delivered === false ? "orch.event.failedHint" : edge.mode === "steer" ? "orch.event.steerHint" : "orch.event.queueHint")
				: t(edge.kind === "report" ? "orch.event.reportHint" : "orch.event.spawnHint");
			const inspector = selected ? h("aside", { className: "orchViewInspector", ref: inspectorRef, "aria-label": t("orch.detail") },
				h("div", { className: "orchViewInspectorTop" }, h("h2", { title: fullTitle(selected) }, titleFor(selected))),
				h("div", { className: "orchViewInspectorStatus" }, icon("task", true), statusChip(liveState(selectedLive))),
				h("p", { className: "orchViewBreadcrumb" }, selected.team || t("orch.ungrouped")),
				h("dl", { className: "orchViewFacts" },
					h("div", null, h("dt", null, t("orch.detail.todos")), h("dd", { className: "orchViewTodoValue" }, selectedLive?.todos ? `${selectedLive.todos.done} / ${selectedLive.todos.total}` : "—")),
					h("div", null, h("dt", null, t("orch.detail.updated")), h("dd", null, orchAgoText(selectedLive?.updatedAt, now, t))),
					selected.model?.model ? h("div", { className: "orchViewFactModel" }, h("dt", null, t("orch.detail.model")), h("dd", null, selected.model.model)) : null,
					selectedLive?.goalPhase ? h("div", { className: "orchViewFactModel" }, h("dt", null, t("orch.detail.goal")), h("dd", null, selectedLive.goalPhase)) : null),
				h("button", { className: "orchViewPrimary", type: "button", onClick: () => openChild(selected) }, t("orch.open"), icon("external")),
				h("p", { className: "orchViewMeta orchViewId", title: selectedId }, `${t("orch.detail.id")} · ${selectedId}`),
				!selectedLive ? h("p", { className: "orchViewMeta" }, t("orch.detail.unknown")) : null,
				h("section", { className: "orchViewRelations" },
					h("h3", null, t("orch.detail.relations"), h("span", { className: "orchViewCount" }, String(selectedEvents.length))),
					h("p", { className: "orchViewRelationHint" }, t("orch.detail.scope")),
					selectedEvents.length > 20 ? h("p", { className: "orchViewRelationHint" }, t("orch.detail.recent")) : null,
					h("ol", { className: "orchViewEvents" }, ...eventList.map((edge, i) => h("li", { className: "orchViewEvent", key: `${selectedId}:${i}:${edge.time}`, "data-kind": edge.kind, "data-failed": edge.delivered === false },
						h("div", { className: "orchViewEventHeading" }, h("strong", null, eventLabel(edge)), h("time", { title: typeof edge.time === "number" && Number.isFinite(edge.time) ? new Date(edge.time).toLocaleString() : undefined }, orchAgoText(edge.time, now, t))),
						h("p", null, eventDescription(edge))))))) : null;
			const diagnostics = [];
			if (chatError !== null || chat === null) diagnostics.push(h("p", { key: "chat", className: "orchViewFlash", "data-kind": "error" }, t("orch.degraded.chat", { message: chatError || t("orch.service.missing") })));
			if (sessionsError !== null || sessionsList === null) diagnostics.push(h("p", { key: "sessions", className: "orchViewFlash" }, t("orch.degraded.sessions")));
			if (extraction.ok === false) diagnostics.push(h("p", { key: "extract", className: "orchViewFlash", "data-kind": "error" }, t("orch.error.extract", { message: extraction.error })));
			const emptyTitle = chat === null || extraction.ok === false ? "orch.empty.unavailable" : hasMore !== false ? "orch.empty.partial" : "orch.empty.title";
			const emptyHint = chat === null || extraction.ok === false ? "orch.empty.unavailableHint" : hasMore !== false ? "orch.empty.windowHint" : "orch.empty.hint";
			const runningCount = children.filter(child => liveState(orchSessionInfo(byId, child.sessionId)) === "running").length;
			const completedCount = children.filter(child => liveState(orchSessionInfo(byId, child.sessionId)) === "completed").length;
			const tree = h("div", { className: "orchViewRoot", ref: rootRef },
				flash ? h("p", { className: "orchViewFlash", "data-kind": flash.kind, role: "status" }, flash.text) : null,
				...diagnostics,
				h("div", { className: "orchViewWorkspace", style: children.length ? undefined : { gridTemplateColumns: "minmax(0,1fr)" } },
					h("main", { className: "orchViewMain" },
						h("div", { className: "orchViewToolbar" },
							h("div", { className: "orchViewHeading" }, h("div", { className: "orchViewHeadingLine" }, h("h1", { className: "orchViewTitle" }, coordinatorTitle), statusChip(liveState(coordinatorLive)), h("span", { className: "orchViewRole" }, t("orch.coordinator"))),
								h("p", { className: "orchViewMeta" }, t("orch.summary", { n: children.length, running: runningCount, completed: completedCount }))),
							h("div", { className: "orchViewHistory" }, h("span", null, t(hasMore === false ? "orch.history.loaded" : "orch.history.partial")), historyButton,
								h("button", { type: "button", className: "orchViewBtn", title: t("orch.refresh"), "aria-label": t("orch.refresh"), onClick: () => { setRefreshNonce(n => n+1); setNowTick(Date.now()); } }, icon("refresh")))),
						children.length === 0 ? h("div", { className: "orchViewEmpty" }, icon("group", true), h("h2", null, t(emptyTitle)), h("p", null, t(emptyHint)),
							chat !== null && extraction.ok !== false ? h("p", null, t("orch.empty.scanned", { n: extraction.scanned || 0 })) : null)
						: h("div", { className: "orchViewCanvas", "aria-label": t("orch.topology") }, h("div", { className: "orchViewLayer", style: { width: layout.size.width, height: layout.size.height } },
							...groupElements,
							h("svg", { className: "orchViewSvg", width: layout.size.width, height: layout.size.height, viewBox: `0 0 ${layout.size.width} ${layout.size.height}`, "aria-hidden": true }, ...edgeElements, ...memberEdges),
							coordinatorCard, ...children.map(childCard))),
						children.length ? h("div", { className: "orchViewLegend" }, ...["send", "spawn", "report"].map(kind => h("span", { key: kind }, h("i", { className: "orchViewLegendKey", "data-kind": kind }), t(`orch.legend.${kind}`))), h("span", null, t("orch.legend.recent"))) : null),
					inspector));
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
			orchGroupRelations,
			orchSelectedChild,
			orchTaskTitle,
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
