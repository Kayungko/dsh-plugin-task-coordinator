# 主机契约与投递语义（实测版）

本文档描述 `dsh-plugin-task-coordinator` 依赖的 DSH 宿主契约与六个 `task_*` 工具的投递语义。来源为插件开发期的宿主源码通读 + 真实宿主端到端实测（**DSH 0.1.2-alpha.1**，2026-09-04 于 `~/.dsh/profiles/desktop`）。

⚠️ 宿主版本是硬约束：契约按 0.1.2-alpha.1 验证，宿主大版本升级后须重跑 `verify-installed.mjs` 再放行。
📌 标注 **[0.3.0 新增]** 的章节对应工作区在研版本：工具面语义已定型，回归测试补齐中——引用前以当前代码为准。

## 1. 宿主注入面（cordis）

插件声明 `inject = ['agents', 'tools', 'sessionController']`（`index.mjs`），启动时校验可用性，缺失即抛错快速失败（不静默降级）：

| 注入 | 来源 | 用途 |
|---|---|---|
| `ctx.sessionController` | `@deepseek-ai/dsh-api-session-controller` | 会话生命周期与查询（Remote 门面） |
| `ctx.agents` | 宿主活体注册表 | `get(sessionId)` 取运行中 agent（状态 / inbox / 投递） |
| `ctx.tools` | `@deepseek-ai/dsh-tools` | `defineTool` 注册六个工具 |
| `ctx.plugin` | cordis 内核 | 挂载隔离技能 provider（可选，失败降级） |

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
| `create(request)` | 创建会话 | `task_spawn` 第一步 |
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

配置解析拒绝错误类型而不是猜测（`config.mjs` 逐项类型校验，非法直接 `TypeError`）；`maxQueuePerTask`、`titleMaxTopicChars`、`registryMaxEntries` 下限收敛为 1。

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

| code | 含义 |
|---|---|
| `bad-request` | 参数缺失/非法 |
| `spawn-create-failed` | 会话创建失败 |
| `kickoff-rejected` | 开场提示词投递被拒 |
| `target-busy` | 目标忙（不可执行当前操作） |
| `target-vanished` | 目标在操作中途消失 |
| `resolve-failed` | agent 解析失败 |
| `target-cold` | 目标为冷会话且操作需要活体 |
| `wait-failed` | 等待原语失败 |
| `cancel-rejected` | 取消被拒 |

未列出的兜底：`tools.mjs` 捕获未预期异常时回 `code: 'internal'`。

## 7. 持久 spawn 注册表 [0.3.0 新增]

`registry.mjs` 记录协调者 spawn 过的会话——哪个团队、何时、什么意图：

- **文件**：默认 `<DSH_HOME 或 ~/.dsh>/task-coordinator/registry.json`（`registryFile` 可覆盖）；格式版本化（当前 `1`）；
- **消费面**：`task_list({ team })` 的成员判定、列表行与 `task_progress` 结果里的 `team` 富化；
- **容错契约**：读取**永不抛错**——缺失或损坏降级为空注册表；损坏文件保留为 `*.corrupt-<时间戳>` 供检查，不静默丢弃；
- **写入**：近似原子（临时文件 + 重命名）；
- **容量**：`registryMaxEntries`（默认 500）上限，最旧先裁剪。

## 8. 安全守卫（拒绝即终态）

| 守卫 | 拒绝条件 | 实测 |
|---|---|---|
| 自寻址 | `caller.sessionId == target.sessionId` | ✅ 端到端验证（自环守卫） |
| 子代理目标 | 目标会话 `origin == 'subagent'` | 栅栏隔离 |
| 子代理调用方 | 调用方 `origin == 'subagent'` 且 `allowSubagentUse: false` | 默认拒绝 |
| 调用方身份 | 无 agent 上下文 | 每次调用从 `exec.agent` 重新推导，不接受自报 |

0.3.0 起守卫拒绝携带结构化 `{ code, message }`（见 §6），调用方可编程分支。

## 9. 已知边界

- **无删除工具**：作废一个任务 = `task_cancel` + 不再发消息；会话本身保留；
- **cwd 继承**：子任务默认继承发起方工作目录，跨项目需在 `task_spawn` 的 `cwd` 参数显式指定；
- **进度报告裁剪**：`task_progress` 的对话尾部按 `progressTailMessages`（默认 6 条）×`excerptChars`（默认 400 字）裁剪，防止上下文爆炸；
- **技能依赖可缺**：`dsh-skill-filesystem` 不可用时技能不挂载（仅 warning），六工具不受影响；
- **注册表只记 spawn** [0.3.0 新增]：`team` 过滤依赖注册表记录——注册表启用前创建或外部创建的会话无法按团队检索。

## 10. 验证记录

- **单元**：33 个测试（`test/smoke.test.mjs`，mock 宿主，`node --test`）——0.2.0 面全绿；0.3.0 新增面的回归补齐中；
- **集成**：`verify-installed.mjs` 在**安装位置**用真实 `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-skill-filesystem` 包 + mock ctx 跑 `apply()` 全链路（schema 编译、消息构造、6 工具、安全守卫、卸载清理）；
- **端到端**（重启后真实宿主，0.2.0 面）：六项能力全部实测通过——运行中 `steer` 纠偏、取消后恢复、自环守卫；`task_spawn` kickoff 曾发现 prompt 门面缺 AbortSignal 的缺陷，修复后复验通过（`SPAWN_FIXED_OK`）；
- spawn 命名规则升级（`MMDD｜类型｜主题`）回归：33/33 单元 + 集成验证通过（实测任务 `0904｜修复｜回归套件`）。
