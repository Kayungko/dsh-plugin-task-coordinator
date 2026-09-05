<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
  <img src="./assets/banner-light.svg" alt="task-coordinator" width="600">
</picture>

**Codex-style cross-task coordination · a supervisor plugin for DeepSeek Harness**

[![DSH 0.1.2-rc.1 verified](https://img.shields.io/badge/DSH-0.1.2--rc.1%20verified-16A34A?style=for-the-badge)](docs/PROTOCOL.md)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![80 unit tests](https://img.shields.io/badge/tests-80%20unit-0EA5E9?style=for-the-badge)](test/smoke.test.mjs)
[![MIT](https://img.shields.io/badge/license-MIT-7C3AED?style=for-the-badge)](LICENSE)

[What is this](#what-is-this) · [Quick start](#quick-start) · [Tools](#the-eleven-tools) · [Architecture](docs/ARCHITECTURE.md) · [Host contract](docs/PROTOCOL.md) · [Changelog](CHANGELOG.md) · [中文](README.zh-CN.md)

</div>

---

## What is this

**Once installed, you just say what should run in parallel — the `task_*` tools handle every step of the orchestration:**

```text
Split this into three tasks and run them in parallel: A researches the approach,
B builds the prototype, C runs the tests. Summarize for me when they finish.
```

What happens behind the scenes: you (plain language) → supervisor session → decomposition analysis → **an approval card you confirm** → batch-spawned task sessions → each task reports its result back when done → the supervisor summarizes. You never watch a single step in between, but the decision points stay in your hands.

- This is a DSH plugin: **any top-level session** can discover tasks, read progress, spawn tasks and deliver instructions;
- Spawned tasks **appear in the GUI session list immediately** (the same `api-session/added` event the sidebar consumes);
- Every cross-task message is stamped with a `coordinator` source — visible and attributable in the target session's transcript;
- One prerequisite: **DSH Desktop is installed and starts** (the plugin never launches the host for you).

> 📌 Host contract verified on **DSH 0.1.2-alpha.1**; every capability passed real-host end-to-end testing after restart (criteria in [Host contract](docs/PROTOCOL.md)).

## Quick start

### Prerequisites

- DSH Desktop (contract verified on 0.1.2-alpha.1);
- Node.js `^22.19.0 || >=24` (the host runtime usually satisfies this already);
- PowerShell (the deploy script is `.ps1`).

### Install (one command)

```powershell
git clone https://github.com/Kayungko/dsh-plugin-task-coordinator.git
cd dsh-plugin-task-coordinator
pwsh install.ps1 -Source .
```

The script does three things: copies the plugin into the profile's `node_modules/` (no `pnpm install`, the lockfile stays untouched), registers the dependency + bundle in the profile manifest, and updates `.package-map.json` — **everything is backed up first** into `backups/<timestamp>/`.

**Restart DSH Desktop** afterwards — any session can then use the eleven tools and the `/tasks` command.

> 💡 `install.ps1` defaults `-Source` to `$PSScriptRoot/plugin` (workspace layout); when running from the plugin repo itself, **pass `-Source .` explicitly**.
> Re-running is safe: file copies are idempotent and manifest registration de-duplicates.

### Verify

After the restart, send this to any session:

`List the currently visible tasks`

It calls `task_list` and returns the task list (an empty list is a valid answer) — the tools are mounted ✅

Uninstall: `pwsh install.ps1 -Source . -Uninstall` (also takes effect after restart).

## Directing the supervisor (prompting that actually works)

The model only coordinates when it can map your words to the tools. Vague prompts like "you may use the /task plugin whenever you want" are discretionary — sessions tend to default to working solo (field-verified failure mode). Two rules:

1. **Name the tools, use imperative mood.** Example: "Split the remaining work with `task_spawn_batch` into parallel sub-task sessions (give them a team name); collect results with `task_wait`. Don't do everything in this session."
2. **In /goal mode the coordination mandate must live inside the goal objective** — every continuation round re-anchors on that text alone. Recommended objective:

> As the supervisor session, take over the remaining development: ① splittable work MUST be dispatched to parallel sub-task sessions via task_spawn_batch (attach a team name) — do not do everything yourself; ② collect results with task_wait and integrate them; ③ sub-task sessions may further parallelize with their own subagents; ④ push to remote main at every milestone.

Loose wordings ("/task plugin", "coordinate things") are recognized too — the bundled skill carries an alias table and the tool descriptions carry trigger context since 0.9.0 — but the imperative template above is the reliable form, especially for goal objectives.

## The eleven tools

| Tool | Purpose |
|---|---|
| `task_list` | List coordination-visible tasks with stable session ids, status, titles, todo/goal progress; filterable by `team` |
| `task_progress` | Read one task in depth: live/cold state, queued messages, conversation tail, todos, goal |
| `task_send` | Deliver a visible follow-up prompt (`mode: queue` or `steer`; `reference` links an earlier instruction); returns a `messageId` |
| `task_spawn` | Create + name + kick off a brand-new task (title follows the `MMDD｜type｜topic` rule; groupable via `team`); returns a `correlationId`; appends the report-back convention by default; the child attaches to the caller's workspace, and an explicit `cwd` exactly matching a workspace path is upgraded to that workspace's attachment (0.12.0); optional `provider`+`model` (+`reasoningEffort`) select the child's LLM route, installed before the kickoff (0.13.0) |
| `task_confirm` | Present a decomposition/dispatch plan as an **interactive approval card** and block until the user answers; approval mints a single-use `confirmationId` |
| `task_confirm_select` | Present the proposed task list as a **multi-select card** (host's neutral question UI — no amber styling): the user checks which tasks to dispatch (partial dispatch) with an optional custom-feedback row; approval binds the `confirmationId` to the selected subset and `task_spawn_batch` enforces it (`confirmation-mismatch` otherwise) |
| `task_spawn_batch` | Spawn a whole decomposition plan in one call (`tasks: [{title?, prompt}]` + one `team`); requires the `confirmationId` once the batch reaches the confirmation threshold; one failed item does not abort the rest |
| `task_wait` | Block until one task becomes idle (or timeout); multi-target (`sessionIds` + `mode: all/any`) |
| `task_cancel` | Cancel the target's active turn, keeping its queued messages |
| `task_workspace` | List host workspaces, or `attach` / `detach` an **existing** session (migrate sessions that landed in the ungrouped bucket); goes through the live workspace entity and never touches the session's conversation |
| `task_models` | List the **exact model routes this deployment serves** — provider/model/reasoning-effort ids from the host's live catalog (the GUI picker's source) plus the app-wide default; consult before spawning with `provider`+`model`, never guess ids (0.14.0) |

### `/tasks` — the no-model fast lane

Read-only lookups can bypass the model entirely: `/tasks` (all tasks), `/tasks team <name>` (one workstream), `/tasks <sessionId>` (one task's progress, short-id prefixes resolve when unique). The command executes directly in the host — zero tokens, instant answer. Anything that *acts* (send/spawn/wait/cancel) still goes through the tools.

### Copying session ids — one click in the session header

The plugin ships a small **web client module** (`client.js`, declared via `dsh.client` in `package.json`) that occupies the official `conversation.session.header.utilities` slot — the same seam the shipped `session-log-export` package uses. Every session header gets a **「复制会话Id」** button (filled pill matching the Session-log button geometry: black-on-white in light mode, white-on-black in dark mode) that copies the session's full `sessionId` to the clipboard, ready to paste into `task_send`, `task_progress` or `/tasks <id>` on the supervisor side. (The sidebar's per-session context menu is hard-coded in the host and cannot be extended — field-verified — so the header slot is the sanctioned place.)

### Workspace placement & migration (0.12.0)

Spawned children attach to the caller's workspace by default; an explicit `cwd` that exactly matches a workspace path (case- and separator-insensitive) is **upgraded to a workspace attachment** automatically, so cross-directory dispatch no longer drops sessions into the ungrouped bucket. Sessions that landed ungrouped earlier migrate via `task_workspace`: `list` the host workspaces, then `attach` / `detach` by id or exact path. It calls the live workspace entity — the same `attachSession` API the host's `session.create` uses internally — so the session's stored cwd is validated against the workspace path and its conversation is never touched. (The GUI offers no such entry: sidebar dragging calls `insertSessionBefore`, which only reorders sessions already inside a workspace — field-verified.)

### Per-child model selection (0.13.0) & route discovery (0.14.0)

`task_spawn` — and every item of `task_spawn_batch` — accepts an optional `provider` + `model` pair (+ `reasoningEffort`). The route is validated against the host LLM catalog **before** the session is created (`model-unavailable` rejects an invalid pair with zero orphans), then installed through the host's `sessionController.selectModel` **between creation and kickoff**, so the child's very first turn runs on the requested model; the selection persists as a durable session event and survives restarts. Should installation fail after pre-validation, the spawn reports `model-select-failed` with the traceable orphan id and never kicks off on the wrong model. Host semantics, disclosed as-is: installing a session-local model **also updates the app-wide default model** (the GUI picker's "last selection wins" behavior — `selectModel` is the host's only public entry point), so in a mixed-model batch the last child's route becomes the app default.

Marketplace reality: **every user connects different providers/models**, so ids are never hardcoded and never guessed — `task_models` projects the host's **live** model catalog (the same source the GUI model picker renders) into the exact ids `task_spawn` accepts, including per-model reasoning efforts and the app-wide default; providers whose catalog listing fails are reported in isolation (`failedProviders`). A rejected `model-unavailable` spawn carries an actionable hint too: the error lists what the requested provider actually serves (or the routable providers when the provider itself is unknown). On host builds without `modelCatalog()`, `task_models` degrades to `catalog-unavailable` and the error hints remain the fallback.

## Dispatch confirmation (the anti-black-box gate)

Batch dispatches used to be a silent model decision — not anymore:

1. The supervisor calls `task_confirm({ plan })` with the full decomposition plan (markdown); the user gets a **plan-review card** rendered through the host's `ctx.userQuestions` seam — the same isomorphic path the official `exit_plan_mode` uses, so **no client-side changes are needed**;
2. Approve → the tool returns a `confirmationId` bound to the calling session; decline → the user's feedback comes back as the tool result; close the card → `confirm-cancelled` (the supervisor stops and waits);
3. `task_spawn_batch` at or above `confirmBatchThreshold` (default 2) **refuses to run without a valid `confirmationId`** (`confirmation-required`). The credential is single-use and consumed on success; an all-failed batch keeps it so the user is not asked twice for the same plan.

**Multi-select variant (0.10.0)**: when the tasks are independently droppable, `task_confirm_select({ tasks: [{title, scope}] })` renders the list in the host's **neutral** question UI (multi-select + custom input row, no amber plan-review styling) and the user checks which tasks to dispatch. The minted credential carries the selected subset, and `task_spawn_batch` rejects any batch title the user did not check (`confirmation-mismatch`). Present the full plan in chat first — the generic card carries the task list, not the plan body.

**Mission-scoped approval (0.11.0)**: for a long autonomous run (e.g. goal mode), confirm ONCE — `task_confirm({ plan, reusable: true })` mints a **reusable** credential that survives successful batches, so every later batch of the same mission passes the gate with the same `confirmationId` instead of raising a card per milestone. Single-use stays the default; reusable credentials are still caller-bound and in-process (a host restart clears them); `task_confirm_select` supports `reusable` too (subset enforcement applies on every reuse).

Degradation: with no UI connected, `task_confirm` returns `no-question-channel` and the bundled skill instructs the supervisor to fall back to a plain-text confirmation in chat. Subagent callers get `delegated-caller` (a child agent cannot ask a human).

## Result report-back

Spawned tasks come with a **report-back convention by default** (`reportBack`): the kickoff prompt ends with an instruction to push a result summary (conclusion, output paths, remaining issues) back to the spawning session via `task_send` when the task finishes — with "write the summary into your final reply" as the fallback when the send fails. The supervisor therefore gets **push + `task_wait` as the pull fallback** instead of polling. Pass `reportBack: false` for fire-and-forget tasks you will read with `task_progress` anyway.

## Recursion governance

Spawned coordinators can spawn further tasks — up to `maxSpawnDepth` (default 2) generations from the root session. The durable registry records each task's `depth` and `parentSessionId`; going deeper fails with `spawn-depth-exceeded` and the guidance to use **subagents** for deeper parallelism instead (subagents never consume depth budget).

## Delivery semantics (the important part)

| Target state | `task_send` behavior |
|---|---|
| **idle** | Immediately starts a new round on the target |
| **running** + `queue` (default) | Message queues, claimed at the next **turn** boundary |
| **running** + `steer` | Message queues, claimed at the next **step** boundary (faster mid-course correction) |

Conclusion: **no polling needed** — deliver, `task_wait` for idle, then `task_progress` for the result. To correct a running task right away use `steer`; a `queue` message will not take effect earlier.

> ⚠️ **Delivered ≠ consumed**: `delivered: true` only means the message was accepted into the inbox. On timeout, errors or long silence, reconcile first with `task_progress` (queued messages + conversation tail), then decide to resend or keep waiting — never blind-resend an uncertain delivery as a new message.

## Correlation & traceability

- `task_send` returns a `messageId`; `task_spawn` returns a `correlationId` — note down the ones you will need to reference;
- To correct or continue an earlier instruction, pass `reference: <messageId or correlationId>` to `task_send` — the reference is quoted as a **visible annotation line** in the delivered message, so the target knows exactly which instruction is being amended;
- Every cross-task message carries the `coordinator` source, attributable in the target's transcript.

## Team workstreams & durable registry

- Pass `team: <workstream name>` to `task_spawn` / `task_spawn_batch` to group tasks; `task_list({ team })` retrieves the whole group later;
- Grouping is recorded in a **durable spawn registry** (default `<DSH_HOME or ~/.dsh>/task-coordinator/registry.json`) together with each spawn's title, prompt excerpt, `depth` and `parentSessionId` — it **survives host restarts** (native session listing cannot answer "which tasks are mine and how do they group");
- Registry writes are near-atomic (temp file + rename); entries are capped by `registryMaxEntries` (default 500, oldest pruned first); a corrupt file is preserved as `*.corrupt-<timestamp>` instead of being silently dropped.

## Machine-readable error codes

Failures return `{ ok: false, code, error }` — agents branch on `code`, never on prose. Two families: guard denials (`self-send-denied` / `subagent-caller-denied` / `subagent-target-denied` / `target-not-found` / `rate-limited` / `queue-full`…) and operation failures (`bad-request` / `target-busy` / `target-cold` / `spawn-create-failed` / `kickoff-rejected` / `spawn-depth-exceeded` / `confirmation-required` / `confirm-cancelled` / `no-question-channel` / `delegated-caller` / `batch-all-failed`…). Full table in [Host contract §6](docs/PROTOCOL.md).

## Safety model

- Self-addressing is **always rejected**;
- Targets must be top-level sessions — subagent-owned sessions are fenced;
- Subagent callers are denied by default (`allowSubagentUse` to opt in);
- Batch dispatches above the threshold are impossible without explicit user approval (see above);
- Recursion depth is capped (`maxSpawnDepth`) so spawn trees cannot grow unbounded;
- Per-target rate limit (`minSendIntervalMs`) and queue-depth limit (`maxQueuePerTask`) prevent runaway spam;
- Caller identity is **re-derived from the executing agent context on every tool call** — never self-reported.

## Spawn-title rule (MMDD｜type｜topic)

`task_spawn` splits the title responsibilities — **the model supplies `type｜topic`; the plugin stamps the date mechanically**:

- The **date prefix** is stamped from the session *creation* time in `titleTimeZone` (default `Asia/Shanghai`) — never `updatedAt`, never model-computed;
- **type** must be one of `titleTypes` (功能、设计、修复、优化、发布、探索、文档、研究); unclear types fall back to `titleFallbackType` (default 探索) instead of guessing;
- **topic** is truncated to `titleMaxTopicChars` (default 16) for sidebar display; with no `title`, the topic is derived from the kickoff prompt's first line;
- A stale leading `MMDD｜` is re-stamped from the real creation time; halfwidth `|` and legacy `[team]` prefixes are normalized.

Example: `修复｜对账精度` → `0904｜修复｜对账精度`.

## Bundled skill: task-coordination

The plugin ships one skill (`skills/task-coordination/SKILL.md`) teaching the supervisor *when and how* to orchestrate the tools: delivery semantics, decomposition criteria, confirmation semantics, fan-out/supervise/handoff patterns, recursion governance, the naming rule, anti-patterns. Loaded on demand — it costs no context until coordination actually happens.

Mounting follows the shipped `@openviking/dsh-memory-plugin` precedent — an **isolated** `dsh-skill-filesystem` provider with `providerName: 'task-coordinator'`, `includeDefaultRoots: false`, seeing only this plugin's `skills/` directory. Consequences: hot-reload on edit, no shadowing of project/user skills, disappears on uninstall. If the provider package is unavailable the mount degrades to a warning — **the eleven tools keep working**.

## Configuration (cordis.yml / patch)

```yaml
- id: task-coordinator-runtime
  name: 'dsh-plugin-task-coordinator'
  config:
    enabled: true
    allowSubagentUse: false
    includeSubagentsInList: false
    titleTypes: ['功能', '设计', '修复', '优化', '发布', '探索', '文档', '研究']
    titleFallbackType: '探索'
    titleMaxTopicChars: 16
    titleTimeZone: 'Asia/Shanghai'
    registryFile: ''              # empty = <DSH_HOME or ~/.dsh>/task-coordinator/registry.json
    registryMaxEntries: 500
    maxBatchSpawn: 6              # per-call cap for task_spawn_batch
    maxSpawnDepth: 2              # spawn generations allowed below the root session
    confirmBeforeBatch: true      # dispatch confirmation gate
    confirmBatchThreshold: 2      # batch size (>=) at which the gate engages
    maxQueuePerTask: 5
    minSendIntervalMs: 2000
    waitDefaultTimeoutMs: 120000
    waitMaxTimeoutMs: 600000
    excerptChars: 400
    progressTailMessages: 6
```

Config resolution **rejects wrong types instead of guessing**: a bad type fails fast with `TypeError`. See [Host contract §5](docs/PROTOCOL.md) for every option's semantics.

---

## For developers

Module layering, DI boundaries and the degradation strategy live in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Quick reference only here.

### Development & tests

```powershell
node --check *.mjs                      # syntax check
node --test test/smoke.test.mjs         # 59 unit tests (mocked host)
# after installing into a profile (see Quick start):
node verify-installed.mjs               # installed-location integration check: real host packages + mock ctx
```

### Directory

```
dsh-plugin-task-coordinator/
├── index.mjs           cordis entry · wiring (only layer importing host packages directly)
├── config.mjs          config resolution (pure module)
├── safety.mjs          guards + rate limiter + denial codes (pure module)
├── title.mjs           spawn-title rule (pure module)
├── registry.mjs        durable spawn registry (near-atomic writes, corruption-tolerant)
├── ops.mjs             session operations · DI factory
├── tools.mjs           eleven task_* tool registrations
├── commands.mjs        /tasks slash command (direct execution, no model turn)
├── client.js           web client module: copy-session-id header button (dsh.client)
├── skills.mjs          isolated skill mount (dynamic import, fire-and-forget)
├── skills/task-coordination/   supervisor playbook (shipped with the bundle)
├── cordis.patch.yml    isolated plugin-group mount descriptor
├── install.ps1         deploy script (copy-based install + automatic backups)
├── verify-installed.mjs installed-location integration check
├── test/smoke.test.mjs 59 unit tests
└── docs/               ARCHITECTURE.md · PROTOCOL.md
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — architecture: why a plugin, module layering, guard layers, degradation strategy
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — host contract & delivery semantics, field-tested (injection surface, facade signatures, limits, verification records)
- **[CHANGELOG.md](CHANGELOG.md)** — release history
- **[skills/task-coordination/SKILL.md](skills/task-coordination/SKILL.md)** — the supervisor playbook the model actually reads

## License

This plugin is [MIT](LICENSE). The `@deepseek-ai/*` host packages it runs against belong to and are licensed by DeepSeek Harness; they are not covered by this repository's license.
