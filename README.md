# dsh-plugin-task-coordinator

**Codex-style cross-task coordination** for DeepSeek Harness (DSH).

A supervisor agent can discover other top-level sessions (“tasks”), read their progress, spawn new tasks (visible in the session list immediately), and deliver visible follow-up prompts with the exact delivery semantics of the agent inbox:

- target **idle** → the message starts a new round immediately;
- target **running** → the message queues and is claimed at the next turn boundary (`queue`) or the next step boundary (`steer`).

Messages are recorded with the `{ kind: 'coordinator', senderSessionId }` source, so every cross-task instruction is attributable and visible in the target session's transcript.

## Tools

| Tool          | Purpose |
|---------------|---------|
| `task_list`   | List coordination-visible tasks with stable session ids, status, titles, todo/goal progress |
| `task_progress` | Read one task in depth: live/cold state, queued messages, conversation tail, todos, goal |
| `task_send`   | Deliver a visible follow-up prompt (`mode: queue` or `mode: steer`) |
| `task_spawn`  | Create + name + kick off a brand-new task; it shows up in the session list (title follows the `MMDD｜类型｜主题` rule) |
| `task_wait`   | Block until one task becomes idle (or timeout) |
| `task_cancel` | Cancel the target's active turn, keeping its queued messages |

## Safety model

- self-addressing is always rejected;
- targets must be top-level sessions (subagent-owned sessions are fenced);
- subagent callers are denied by default (`allowSubagentUse`);
- per-target rate limit (`minSendIntervalMs`) and queue-depth limit (`maxQueuePerTask`) prevent runaway spam;
- every tool call re-derives the caller from the executing agent context.

## Spawn-title rule (MMDD｜类型｜主题)

`task_spawn` names every new session with the unified format `MMDD｜类型｜主题` (fullwidth `｜`):

- the **date prefix** is stamped mechanically from the session *creation* time in `titleTimeZone` (default `Asia/Shanghai`) — never `updatedAt`, never model-computed;
- the **类型** must be one of `titleTypes` (功能、设计、修复、优化、发布、探索、文档、研究);
- the **主题** is truncated to `titleMaxTopicChars` (default 16) for sidebar display;
- if the type is unclear the plugin uses `titleFallbackType` (default 探索) instead of guessing; if no `title` is given, the topic is derived from the kickoff prompt's first line. A stale leading `MMDD｜` is re-stamped from the real creation time, and halfwidth `|` / legacy `[团队]` prefixes are normalized.

## Bundled skill (supervisor playbook)

The plugin ships one skill, `task-coordination`, inside the bundle at `skills/task-coordination/SKILL.md`. It teaches the supervisor *when and how* to orchestrate the tools (delivery semantics, fan-out/supervise/handoff patterns, the spawn-title rule, anti-patterns) — loaded on demand, so it costs no context until coordination actually happens.

Mounting follows the shipped `@openviking/dsh-memory-plugin` precedent: the plugin mounts an **isolated** `@deepseek-ai/dsh-skill-filesystem` provider (`ctx.plugin(...)`) with:

- `providerName: 'task-coordinator'` (never collides with DSH's `filesystem`);
- `includeDefaultRoots: false` (sees only the bundle's own `skills/` dir);
- `customSkillDirs: [<plugin>/skills]`.

Consequences: the skill hot-reloads when edited (directory watcher), it cannot shadow project/user skills, and it disappears together with the plugin on uninstall. The provider package is imported **dynamically**: if it is ever unavailable, the mount degrades to a warning and the six tools still work.

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
    maxQueuePerTask: 5
    minSendIntervalMs: 2000
    waitDefaultTimeoutMs: 120000
    waitMaxTimeoutMs: 600000
    excerptChars: 400
    progressTailMessages: 6
```

## Host contract (verified on DSH 0.1.2-alpha.1)

- `ctx.sessionController` (`@deepseek-ai/dsh-api-session-controller`):
  `list / create / rename / prompt / cancel / resolveAgent / inspect`;
- `ctx.agents`: live agent registry (`get(sessionId)`, `agent.status`, `agent.inbox`, `agent.whenIdle()`, `agent.followup()/steer()`);
- `ctx.tools.register(defineTool(...))` from `@deepseek-ai/dsh-tools`;
- messages built with `createUserMessage` from `@deepseek-ai/dsh-llm`.

New sessions appear in the GUI session list because the host emits `api-session/added` on creation — the same event the sidebar already consumes for user-created sessions.

## Development

```powershell
node --check index.mjs config.mjs safety.mjs ops.mjs tools.mjs title.mjs
node --test test/smoke.test.mjs          # unit tests, mocked host
# after installing into a profile (see repository root install.ps1):
node verify-installed.mjs                # integration test with REAL host packages
```

Files: `index.mjs` (cordis entry) · `config.mjs` (config resolution) · `safety.mjs` (guards + limiter) · `title.mjs` (spawn-title rule) · `ops.mjs` (session operations) · `tools.mjs` (tool registration) · `skills.mjs` + `skills/` (bundled `task-coordination` skill).

## License

MIT
