# 主机契约与投递语义（实测版）

本文档描述 `dsh-plugin-task-coordinator` 依赖的 DSH 宿主契约与八个 `task_*` 工具 + `/tasks` 命令的投递语义。来源为插件开发期的宿主源码通读 + 真实宿主端到端实测（**DSH 0.1.2-alpha.1**，2026-09-04 于 `~/.dsh/profiles/desktop`）。

⚠️ 宿主版本是硬约束：契约按 0.1.2-alpha.1 验证，宿主大版本升级后须重跑 `verify-installed.mjs` 再放行。
📌 章节按引入版本标注 **[0.3.0 新增]** ~ **[0.7.0 新增]**（对应回归测试已全绿，见 §14）。

## 1. 宿主注入面（cordis）

插件声明 `inject = ['agents', 'tools', 'sessionController', 'commands']`（`index.mjs`），启动时校验可用性，缺失即抛错快速失败（不静默降级）：

| 注入 | 来源 | 用途 |
|---|---|---|
| `ctx.sessionController` | `@deepseek-ai/dsh-api-session-controller` | 会话生命周期与查询（Remote 门面） |
| `ctx.agents` | 宿主活体注册表 | `get(sessionId)` 取运行中 agent（状态 / inbox / 投递） |
| `ctx.tools` | `@deepseek-ai/dsh-tools` | `defineTool` 注册八个工具 |
| `ctx.commands` | 命令注册表 | `register` 注册 `/tasks` [0.4.0 新增]；宿主无此注册表时降级为 warning |
| `ctx.plugin` | cordis 内核 | 挂载隔离技能 provider（可选，失败降级） |

另有**惰性解析**的运行时接缝（不硬注入）：`ctx.get('userQuestions')`——`task_confirm` 的弹窗信道 [0.6.0 新增]。缺失或无 UI 连接时该工具返回 `no-question-channel`，其余工具不受影响。

消息体用 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 构造，来源标记固定为：

```json
{ "kind": "coordinator", "senderSessionId": "<发起方 sessionId>" }
```

这是跨任务指令在目标会话 transcript 中**可见且可追溯**的依据。

## 2. sessionController 门面签名（实测）

| 方法 | 签名要点 | 插件用途 |
|---|---|---|
| `list(request, signal)` | 返回 `{ items }` 或数组 | `task_list` 枚举顶层会话 |
| `search(request, signal)` | 同上 | 过滤查询 |
| `create(request)` | 创建会话 | `task_spawn` / `task_spawn_batch` 第一步 |
| `prompt(request, signal)` | 投递开场提示词 | `task_spawn` kickoff（门面需 AbortSignal） |
| `cancel(request)` | 取消活动轮次 | `task_cancel` |
| `rename(request)` | 改标题 | `task_spawn` 命名落盘 |
| `resolveAgent(sessionId)` | 会话 → agent 标识 | 目标解析 |
| `inspect(sessionId, signal)` | 深度读取 | `task_progress` 冷状态分支 |

新会话创建后宿主发 `api-session/added` 事件——侧栏消费的同一个事件，所以 spawn 出的任务**立即出现在 GUI 会话列表**。

## 3. agents 注册表（活体面）

`ctx.agents.get(sessionId)` 返回运行中 agent 或 `undefined`。插件用到的成员：

- `agent.status` —— 空闲 / 运行中判定（决定投递走立即启动还是排队）；
- `agent.inbox.nextTurn` / `agent.inbox.nextStep` —— 两个排队队列；**排队深度 = 两队列长度之和**（`SendLimiter` 的度量口径）；
- `agent.whenIdle()` —— `task_wait` 的等待原语；
- `agent.followup()` / `agent.steer()` —— `task_send` 的两种投递入口。

目标不在注册表（冷会话）时，`task_progress` 退回 `sessionController.inspect` 读冷状态——两条读取路径对调用方透明。

## 4. 投递语义（核心）

| 目标状态 | `task_send` 行为 |
|---|---|
| **空闲** | 立即启动目标的新一轮执行 |
| **运行中** + `mode: queue`（默认） | 入 `nextTurn` 队列，**下一个轮次边界**消费 |
| **运行中** + `mode: steer` | 入 `nextStep` 队列，**下一个步骤边界**消费（更快的中途纠偏） |

推论（写进了随包技能的反模式表）：

- **不需要轮询**——投递后 `task_wait` 等空闲，再 `task_progress` 读结果；
- 要立刻纠偏运行中的任务用 `steer`，发 `queue` 不会提前生效；
- **[0.3.0 新增] 投递 ≠ 消费**：`delivered: true` 只表示消息进了收件箱。超时、异常或长时间无响应时先用 `task_progress` 对账（队列 + 对话尾部），再决定补发——绝不把不确定的投递当新消息盲发。

### 关联与追溯 [0.3.0 新增]

- `task_send` 返回 `messageId`；`task_spawn` 返回 `correlationId`——需要被引用的那一条要记下；
- 纠偏/续接先前指令：`task_send({ reference: <messageId 或 correlationId> })`——引用以可见注释行随消息送达；
- 多目标等待：`task_wait({ sessionIds: [...], mode: 'all' | 'any' })`（`all` 等全部空闲，`any` 任一空闲即返回；兼容单目标 `sessionId`）。

## 5. 限流与容量判据

| 判据 | 默认值 | 配置项 | 越限行为 |
|---|---|---|---|
| 同目标最小发送间隔 | 2000ms | `minSendIntervalMs` | `task_send` / `task_spawn` kickoff 拒绝（`rate-limited`），稍等重试即可 |
| 目标排队深度上限 | 5 | `maxQueuePerTask` | `task_send` 拒绝（`queue-full`），防刷屏 |
| `task_wait` 默认超时 | 120000ms | `waitDefaultTimeoutMs` | 超时返回——**不代表失败**，任务还在跑 |
| `task_wait` 超时上限 | 600000ms | `waitMaxTimeoutMs` | 参数超过则收敛到上限（`waitDefault > waitMax` 时同样收敛） |
| 单次批量上限 | 6 | `maxBatchSpawn` | `task_spawn_batch` 拒绝（`bad-request`），拆小批 [0.5.0 新增] |
| 派生代数上限 | 2 | `maxSpawnDepth` | 超限的派生拒绝（`spawn-depth-exceeded`）[0.5.0 新增] |
| 派发确认闸门 | 开 / 阈值 2 | `confirmBeforeBatch` / `confirmBatchThreshold` | 达阈值的批量缺凭证拒绝（`confirmation-required`）[0.6.0 新增] |

配置解析拒绝错误类型而不是猜测（`config.mjs` 逐项类型校验，非法直接 `TypeError`）；数值下限统一收敛为 1。

## 6. 错误信封与码表 [0.3.0 新增]

所有工具失败统一返回 `{ ok: false, code, error }`——**agent 按 `code` 分支，不解析文案**（与 unity-pipe 的退出码契约同一设计动机）。

守卫拒绝码（`safety.mjs` 的 `DENIAL_CODES`）：

| code | 含义 | 建议动作 |
|---|---|---|
| `caller-unknown` | 无 agent 上下文 | 在正常会话上下文中调用 |
| `subagent-caller-denied` | 子代理调用方被拒（`allowSubagentUse: false`） | 用顶层会话协调 |
| `target-not-found` | 目标不存在 | `task_list` 重新定位 |
| `target-invalid` | 目标无有效 sessionId | 换目标 |
| `self-send-denied` | 自寻址 | 改发给其他任务 |
| `subagent-target-denied` | 目标是子代理会话（栅栏隔离） | 用顶层会话 |
| `rate-limited` | 同目标限频 | 稍等重试 |
| `queue-full` | 目标排队已满 | 先 `task_wait` 让它消费 |

操作失败码（`ops.mjs` 的 `OP_CODES`）：

| code | 含义 | 版本 |
|---|---|---|
| `bad-request` | 参数缺失/非法 | |
| `spawn-create-failed` | 会话创建失败 | |
| `kickoff-rejected` | 开场提示词投递被拒 | |
| `spawn-depth-exceeded` | 超出 `maxSpawnDepth`；改用 subagent | 0.5.0 |
| `batch-all-failed` | 批量派发全部失败（逐项 `results` 带独立 code） | 0.5.0 |
| `confirmation-required` | 达阈值的批量缺有效 `confirmationId` | 0.6.0 |
| `confirm-cancelled` | 用户关闭确认卡片；停手等用户 | 0.6.0 |
| `confirm-aborted` | 确认在用户作答前被中止 | 0.6.0 |
| `no-question-channel` | 无 UI/接缝，弹不了窗；降级聊天文字确认 | 0.6.0 |
| `delegated-caller` | 子代理不能发起人工确认 | 0.6.0 |
| `caller-not-live` | 调用 agent 已非活体实例 | 0.6.0 |
| `target-busy` | 目标忙（不可执行当前操作） | |
| `target-vanished` | 目标在操作中途消失 | |
| `resolve-failed` | agent 解析失败 | |
| `target-cold` | 目标为冷会话且操作需要活体 | |
| `wait-failed` | 等待原语失败 | |
| `cancel-rejected` | 取消被拒 | |

未列出的兜底：`tools.mjs` 捕获未预期异常时回 `code: 'internal'`。

## 7. 持久 spawn 注册表 [0.3.0 新增]

`registry.mjs` 记录协调者 spawn 过的会话——哪个团队、何时、什么意图、派生自谁：

- **文件**：默认 `<DSH_HOME 或 ~/.dsh>/task-coordinator/registry.json`（`registryFile` 可覆盖）；格式版本化（当前 `1`）；
- **记录字段**：`team` / `title` / `promptExcerpt`（**用户原始 prompt** 的摘录）/ `depth` / `parentSessionId`（后两者 0.5.0 起）；
- **消费面**：`task_list({ team })` 的成员判定、列表行与 `task_progress` 结果里的 `team` 富化；深度推导（§9）；
- **容错契约**：读取**永不抛错**——缺失或损坏降级为空注册表；损坏文件保留为 `*.corrupt-<时间戳>` 供检查，不静默丢弃；
- **写入**：近似原子（临时文件 + 重命名）；
- **容量**：`registryMaxEntries`（默认 500）上限，最旧先裁剪。

## 8. 斜杠命令契约 [0.4.0 新增]

`/tasks` 走官方命令面（仿 `dsh-command-goal` 注册模式）：`inject=['commands']` + `ctx.commands.register({ name, description, input, handler })`。

- **执行语义**：命令**直接执行、不进模型、零 token**——handler 返回 `{ kind: 'success'|'error', text }`，没有第三种形态；
- **只读边界**：命令面只做查询（列表 / 编组 / 单任务进度 / 短 ID 前缀唯一解析）；一切动作类操作仍走 `task_*` 工具；
- **调用上下文**：`invocation.agent` 与工具面的 `exec.agent` 同源，`callerFromInvocation` 与 `callerFrom` 走同一推导；
- **降级**：宿主无命令注册表 → 注册跳过 + warning，工具面不受影响。

## 9. 批量派发与递归治理 [0.5.0 新增]

- **批量原子性**：`task_spawn_batch` 先全量校验（数组非空、≤ `maxBatchSpawn`、每项 `prompt` 非空），再逐项走 `spawnTask`——标题规则、注册表、深度治理与单发完全一致；**单条失败不中止其余**，逐项 `results` 带独立 `code`；
- **深度推导**：子深度 = 调用方在注册表的已记录深度 + 1；从未被派生的会话算根（深度 0）。闸门在 `spawnTask` 入口，批量每一项天然同限；
- **超限指引**：`spawn-depth-exceeded` 的 `error` 文案明确要求改用 subagent——subagent 是宿主原生面，不占本插件深度预算；
- **工作区归属 [0.8.1]**：宿主 `create` 接受 `workspaceId` 或 `cwd`（互斥，见 `dsh-api-session-controller.create`）；`spawnTask` 解析调用方的工作区成员归属（含注册表祖先链回溯）并传 `workspaceId`——宿主以工作区路径为 cwd 并 `attachSession`，子任务与总控同工作区可见；显式 `cwd` 优先、无工作区降级为 cwd 语义。

## 10. 派发确认 [0.6.0 新增]

**弹窗信道**：`ctx.get('userQuestions').ask()`——与官方 `exit_plan_mode` 同构（`intent.kind: 'plan-review'`）。问题构造遵守接缝的收窄校验（单问题、非多选、≤2 选项、`detail` 非空、approve 标签与某个选项**逐字一致**），渲染为计划审批卡。零客户端改动。

**凭证生命周期**：

| 事件 | 行为 |
|---|---|
| 批准 | 铸 `confirmationId`（绑定调用方会话），存**进程内** Map |
| 拒绝 | 用户意见（`custom` 或所选标签）随工具结果回传 |
| 关窗 | `ASK_CANCELLED → confirm-cancelled`：停手等用户，不重试弹窗 |
| 达阈值批量缺凭证/凭证属他人 | `confirmation-required` |
| 批量成功（≥1 启动） | 凭证消耗（单次使用） |
| 批量全部失败 | 凭证**保留**——同一方案不问第二遍 |
| 宿主重启 | 进程内记录清空，重新确认（刻意不落盘：不拿过期批准派发） |

**子代理边界**：`userQuestions` 接缝本身拒绝非根活体（`DELEGATED_CALLER`），插件映射为 `delegated-caller`——总控会话不受影响。

## 11. 结果回报约定 [0.7.0 新增]

`reportBack`（默认开）：`spawnTask` 在**开场提示词尾部**追加汇报指令——完成后 `task_send` 结果摘要（结论、产出路径、遗留问题）回派发方会话；发送失败则写进最终回复。边界：

- **注册表摘录永远是用户原始 prompt**——摘录记意图，不记派生文本；
- 追加是 prompt 级约定，不是硬信道——子任务若被外部中止，总控靠 `task_wait` + `task_progress` 兜底；
- `task_spawn_batch` 的 `reportBack` 批级生效；`reportBack: false` 时开场词保持原样。

## 12. 安全守卫（拒绝即终态）

| 守卫 | 拒绝条件 | 实测 |
|---|---|---|
| 自寻址 | `caller.sessionId == target.sessionId` | ✅ 端到端验证（自环守卫） |
| 子代理目标 | 目标会话 `origin == 'subagent'` | 栅栏隔离 |
| 子代理调用方 | 调用方 `origin == 'subagent'` 且 `allowSubagentUse: false` | 默认拒绝 |
| 调用方身份 | 无 agent 上下文 | 每次调用从 `exec.agent` 重新推导，不接受自报 |
| 派生深度 | 子深度 > `maxSpawnDepth` | `spawn-depth-exceeded` [0.5.0 新增] |
| 派发确认 | 达阈值批量无有效凭证 | `confirmation-required` [0.6.0 新增] |

0.3.0 起守卫拒绝携带结构化 `{ code, message }`（见 §6），调用方可编程分支。

## 13. 已知边界

- **无删除工具**：作废一个任务 = `task_cancel` + 不再发消息；会话本身保留；
- **cwd 继承**：子任务默认继承发起方工作目录，跨项目需在 `task_spawn` 的 `cwd` 参数显式指定；
- **进度报告裁剪**：`task_progress` 的对话尾部按 `progressTailMessages`（默认 6 条）×`excerptChars`（默认 400 字）裁剪，防止上下文爆炸；
- **技能依赖可缺**：`dsh-skill-filesystem` 不可用时技能不挂载（仅 warning），八工具不受影响；
- **注册表只记 spawn** [0.3.0 新增]：`team` 过滤依赖注册表记录——注册表启用前创建或外部创建的会话无法按团队检索；
- **`/tasks` 只读** [0.4.0 新增]：命令面不做任何动作；短 ID 前缀歧义时报错而不是猜第一个；
- **确认凭证进程内** [0.6.0 新增]：宿主重启后需重新确认（设计取舍，见 §10）；
- **回报约定非硬信道** [0.7.0 新增]：子任务被外部中止时不会回报，拉取兜底不可省。

## 14. 验证记录

- **单元**：59 个测试（`test/smoke.test.mjs`，mock 宿主，`node --test`）全绿——覆盖 0.3.0 注册表/编组/引用/多目标等待、0.4.0 命令语法/渲染/注册降级、0.5.0 批量（部分失败/超上限/深度链）、0.6.0 确认（批准/拒绝/取消/无信道/子代理拒答/闸门五态）、0.7.0 回报（默认开/关/批量逐项）、0.8.1 工作区归属（继承/显式 cwd 覆盖/祖先链/降级/批量逐项）；
- **集成**：`verify-installed.mjs` 在**安装位置**用真实 `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-skill-filesystem` 包 + mock ctx 跑 `apply()` 全链路（schema 编译、消息构造、8 工具、`/tasks` 五路径、确认闸门全链、安全守卫、卸载清理、0.8.0 客户端模块全链）；宿主升级 2.0.5（core **0.1.2-rc.1**）后重跑全绿；
- **端到端**（重启后真实宿主）：0.2.0 六项能力实测通过（运行中 `steer` 纠偏、取消后恢复、自环守卫；`task_spawn` kickoff 曾发现 prompt 门面缺 AbortSignal 的缺陷，修复后复验 `SPAWN_FIXED_OK`）；命名规则实测 `0904｜修复｜回归套件`；0.6.0 确认卡经官方 `userQuestions` 接缝同构路径构造（`exit_plan_mode` 先例 + 接缝错误码逐项核对）。

## 15. 客户端模块契约 [0.8.0 新增]

插件首次进入浏览器侧。装载链逐段实测（DSH Desktop 2.0.5 / core 0.1.2-rc.1）：

1. **声明**：`package.json` 的 `dsh.client` 必须含 `platform: "web"`；`dsh-client-modules` 的 `parseDshClient` 对其余字段（`inject?`、`external?`、`immediately?`）做窄化校验，非法即抛。
2. **入口解析**：`exports["./client"]`（字符串或含字符串 `default` 的对象）解析为相对包根的路径；缺失则 `declares dsh.client but exports no "./client" bundle`。
3. **bundle 格式**：该文件被**原样** `readFileSync` 装载并经 `/plugins/<id>/client.js` combo 路由下发，必须是 `window.__ModuleLoader__.load({ id, factory })` 注册（官方 `dsh-session-log-export` 编译产物同构）；`factory(require)` 中 `require` 绑定共享客户端图（`react` 等），返回 `module.exports`，导出 `apply` 与 `inject`（服务名数组，如 `["slots"]`）。
4. **槽位占用**：`apply(ctx)` 在客户端 cordis 纤维执行；`ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name, id, order?, label? }, Component))`。占用者组件收到标准会话 props（含 `sessionId`）+ `inject()` 返回的附加 props。
5. **本插件占用**：`id: "copy-session-id"`，渲染「复制 ID」按钮——点击 `navigator.clipboard.writeText(sessionId)`（`document.execCommand('copy')` 降级），1.5s 状态反馈（已复制 ✓ / 复制失败）。

**已验证**：1–4 为源码级实测（`dsh-client-modules/lib/index.js` resolveMeta/parseDshClient/clientExportOf + 槽契约总目 + 官方占用者先例），`verify-installed.mjs` 覆盖声明/bundle/占槽/点击复制。**未验证**：真实 GUI 渲染（需一次宿主重启后目视确认按钮出现）。
