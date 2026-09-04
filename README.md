<div align="center">

**Codex-style cross-task coordination · a supervisor plugin for DeepSeek Harness**

[![DSH 0.1.2-alpha.1 verified](https://img.shields.io/badge/DSH-0.1.2--alpha.1%20verified-16A34A?style=for-the-badge)](docs/PROTOCOL.md)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![33 unit tests](https://img.shields.io/badge/tests-33%20unit-0EA5E9?style=for-the-badge)](test/smoke.test.mjs)
[![MIT](https://img.shields.io/badge/license-MIT-7C3AED?style=for-the-badge)](LICENSE)

[What is this](#what-is-this) · [Quick start](#quick-start) · [Tools](#the-six-tools) · [Architecture](docs/ARCHITECTURE.md) · [Host contract](docs/PROTOCOL.md) · [Changelog](CHANGELOG.md) · [中文](README.zh-CN.md)

</div>

---

## What is this

**Once installed, you just say what should run in parallel — the `task_*` tools handle every step of the orchestration:**

```text
Split this into three tasks and run them in parallel: A researches the approach,
B builds the prototype, C runs the tests. Summarize for me when they finish.
```

What happens behind the scenes: you (plain language) → supervisor session → six `task_*` tools → other top-level sessions ("tasks") inside DSH Desktop. You never watch a single step in between.

- This is a DSH plugin: **any top-level session** can discover tasks, read progress, spawn tasks and deliver instructions;
- Spawned tasks **appear in the GUI session list immediately** (the same `api-session/added` event the sidebar consumes);
- Every cross-task message is stamped with a `coordinator` source — visible and attributable in the target session's transcript;
- One prerequisite: **DSH Desktop is installed and starts** (the plugin never launches the host for you).

> 📌 Host contract verified on **DSH 0.1.2-alpha.1**; all six capabilities passed real-host end-to-end testing after restart (criteria in [Host contract](docs/PROTOCOL.md)).

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

**Restart DSH Desktop** afterwards — any session can then use the six tools.

> 💡 `install.ps1` defaults `-Source` to `$PSScriptRoot/plugin` (workspace layout); when running from the plugin repo itself, **pass `-Source .` explicitly**.
> Re-running is safe: file copies are idempotent and manifest registration de-duplicates.

### Verify

After the restart, send this to any session:

`List the currently visible tasks`

It calls `task_list` and returns the task list (an empty list is a valid answer) — the tools are mounted ✅

Uninstall: `pwsh install.ps1 -Source . -Uninstall` (also takes effect after restart).

## The six tools

| Tool | Purpose |
|---|---|
| `task_list` | List coordination-visible tasks with stable session ids, status, titles, todo/goal progress; filterable by `team` |
| `task_progress` | Read one task in depth: live/cold state, queued messages, conversation tail, todos, goal |
| `task_send` | Deliver a visible follow-up prompt (`mode: queue` or `steer`; `reference` links an earlier instruction); returns a `messageId` |
| `task_spawn` | Create + name + kick off a brand-new task (title follows the `MMDD｜type｜topic` rule; groupable via `team`); returns a `correlationId` |
| `task_wait` | Block until one task becomes idle (or timeout); multi-target (`sessionIds` + `mode: all/any`) |
| `task_cancel` | Cancel the target's active turn, keeping its queued messages |

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

- Pass `team: <workstream name>` to `task_spawn` to group tasks; `task_list({ team })` retrieves the whole group later;
- Grouping is recorded in a **durable spawn registry** (default `<DSH_HOME or ~/.dsh>/task-coordinator/registry.json`) — it **survives host restarts** (native session listing cannot answer "which tasks are mine and how do they group");
- Registry writes are near-atomic (temp file + rename); entries are capped by `registryMaxEntries` (default 500, oldest pruned first); a corrupt file is preserved as `*.corrupt-<timestamp>` instead of being silently dropped.

## Machine-readable error codes

Failures return `{ ok: false, code, error }` — agents branch on `code`, never on prose. Two families: guard denials (`self-send-denied` / `subagent-caller-denied` / `subagent-target-denied` / `target-not-found` / `rate-limited` / `queue-full`…) and operation failures (`bad-request` / `target-busy` / `target-cold` / `spawn-create-failed` / `kickoff-rejected`…). Full table in [Host contract §6](docs/PROTOCOL.md).

## Safety model

- Self-addressing is **always rejected**;
- Targets must be top-level sessions — subagent-owned sessions are fenced;
- Subagent callers are denied by default (`allowSubagentUse` to opt in);
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

The plugin ships one skill (`skills/task-coordination/SKILL.md`) teaching the supervisor *when and how* to orchestrate the tools: delivery semantics, fan-out/supervise/handoff patterns, the naming rule, anti-patterns. Loaded on demand — it costs no context until coordination actually happens.

Mounting follows the shipped `@openviking/dsh-memory-plugin` precedent — an **isolated** `dsh-skill-filesystem` provider with `providerName: 'task-coordinator'`, `includeDefaultRoots: false`, seeing only this plugin's `skills/` directory. Consequences: hot-reload on edit, no shadowing of project/user skills, disappears on uninstall. If the provider package is unavailable the mount degrades to a warning — **the six tools keep working**.

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
node --test test/smoke.test.mjs         # 33 unit tests (mocked host)
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
├── tools.mjs           six task_* tool registrations
├── skills.mjs          isolated skill mount (dynamic import, fire-and-forget)
├── skills/task-coordination/   supervisor playbook (shipped with the bundle)
├── cordis.patch.yml    isolated plugin-group mount descriptor
├── install.ps1         deploy script (copy-based install + automatic backups)
├── verify-installed.mjs installed-location integration check
├── test/smoke.test.mjs 33 unit tests
└── docs/               ARCHITECTURE.md · PROTOCOL.md
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — architecture: why a plugin, module layering, guard layers, degradation strategy
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — host contract & delivery semantics, field-tested (injection surface, facade signatures, limits, verification records)
- **[CHANGELOG.md](CHANGELOG.md)** — release history
- **[skills/task-coordination/SKILL.md](skills/task-coordination/SKILL.md)** — the supervisor playbook the model actually reads

## License

This plugin is [MIT](LICENSE). The `@deepseek-ai/*` host packages it runs against belong to and are licensed by DeepSeek Harness; they are not covered by this repository's license.
