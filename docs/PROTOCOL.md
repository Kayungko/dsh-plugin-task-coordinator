# 主机契约与投递语义（实测版）

本文档描述 `dsh-plugin-task-coordinator` 依赖的 DSH 宿主契约与十一个 `task_*` 工具 + `/tasks` 命令的投递语义。来源为插件开发期的宿主源码通读 + 真实宿主端到端实测（初验 **DSH 0.1.2-alpha.1**，2026-09-04 于 `~/.dsh/profiles/desktop`；宿主升级 **DSH Desktop 2.0.5 / core 0.1.2-rc.1** 后经 `verify-installed.mjs` 全量复验通过）。

⚠️ 宿主版本是硬约束：契约按 0.1.2 系列（alpha.1 → rc.1）验证，peer 区间 `>=0.1.2-0 <0.1.3 || >=0.1.3-0 <0.1.4 || >=0.1.4-0 <0.2.0`——node-semver 只放行「比较符元组自身带预发布标签」的预发布版本（awesome-dsh-plugin contributing.md 官方警告的静默排除陷阱），每个显式分支覆盖一个元组的 rc 系；宿主发布**新的预发布元组**（如 0.1.5-rc.x）时须扩一条分支，否则该预发布宿主上的用户装机 ERESOLVE。宿主大版本升级后须重跑 `verify-installed.mjs` 再放行。
📌 章节按引入版本标注 **[0.3.0 新增]** ~ **[0.8.0 新增]**；0.8.1/0.8.2/0.8.4 为既有章节的行内修订与 §16（对应回归测试已全绿，见 §14）。

## 1. 宿主注入面（cordis）

插件声明 `inject = ['agents', 'tools', 'sessionController', 'commands']`（`index.mjs`），启动时校验可用性，缺失即抛错快速失败（不静默降级）：

| 注入 | 来源 | 用途 |
|---|---|---|
| `ctx.sessionController` | `@deepseek-ai/dsh-api-session-controller` | 会话生命周期与查询（Remote 门面） |
| `ctx.agents` | 宿主活体注册表 | `get(sessionId)` 取运行中 agent（状态 / inbox / 投递） |
| `ctx.tools` | `@deepseek-ai/dsh-tools` | `defineTool` 注册十一个工具 |
| `ctx.commands` | 命令注册表 | `register` 注册 `/tasks` [0.4.0 新增]；宿主无此注册表时降级为 warning |
| `ctx.plugin` | cordis 内核 | 挂载隔离技能 provider（可选，失败降级） |

另有**惰性解析**的运行时接缝（不硬注入）：`ctx.get('userQuestions')`——`task_confirm` 的弹窗信道 [0.6.0 新增]。缺失或无 UI 连接时该工具返回 `no-question-channel`，其余工具不受影响。`ctx.get('settings')` / `ctx.get('locale')` / `ctx.get('llm')` / `ctx.get('workspaceRegistry')` / `ctx.get('sessionQuery')` / `ctx.get('sessions')` 同为按调用惰性解析（见各节）。

设置区安装（0.18.0）：`ctx.inject(['settings'], settingsCtx => settingsCtx.settings.installSection(ctx, 'task-coordinator', schema, base, hooks))`——与宿主 `dsh-tool-subagent` 的 `subagent-model-selection` 同款契约（源码 `model-selection-settings.js`）：插件提供 base 层（`{provider:'', model:'', reasoningEffort:''}`），用户层（设置文档 / GUI 写入）叠加合成，`scope.get()` 解析；`hooks.validate` 在写入边界拒绝半对与非字符串（`settings.mjs` 的 `validateSpawnModelsSection`）；读取侧 `ctx.get('settings').get('task-coordinator')` 每次派发活读（与 0.15.0 locale 同纪律，GUI 改动下一次派发即生效）。npm 依赖 `@deepseek-ai/schemastery >=3.18.0 <4`（宿主必有：cordis Config 基石；Desktop 2.0.5 实测 3.18.2）。

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
- `agent.inbox.nextTurn` / `agent.inbox.nextStep` —— 两个排队队列；**排队深度 = 两队列长度之和**（`SendLimiter` 的度量口径）；0.17.0 起 `task_send` 回执分列回传 `queueDepth {nextTurn, nextStep}`（投递后口径，含本条）；
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

### 队列消化与三级中断阶梯 [0.17.0 实测]

宿主源码级实测（`@deepseek-ai/dsh-agent` `Inbox.claim` / `dsh-agent-loop` 主循环）：

- **next-turn 每轮恰好消化 1 条**（`mutate('next-turn', 0, 1, …)`），新轮首步同批吸收全部 next-step 积压——排队深度 N ≈ N 轮后才被读；目标运行中先等当前轮结束；中途出错中断连续消化（剩余滞留待下一条消息唤醒）；
- **steer（目标健康运行中）跳过整个 next-turn 队列**（步边界 claim 不碰 next-turn）；代价是回合不收尾（`nextStep.length === 0` 才 break），多条 steer 同批合并、通常只多延一步；目标空闲或 abort 收尾期（宿主 send 的 `wakingAfterAbort` 重分类），steer 降级为 next-turn 排队；
- **cancel 保留排队但不自动消费**（`keepInbox: true` 链路）：kick 收尾回 idle、无任何 claim，需下一条消息唤醒，唤醒后仍每轮 1 条；
- **单个超长工具调用内部无步边界**——preStep 只在步间触发，steer 也进不去；
- **冷会话即返**：`waitFor` 对无 live agent 目标立即判 idle；`pendingCount` 对冷目标恒 0，`maxQueuePerTask` 深度守卫不覆盖冷目标（见 §13）；
- **回执与提示**：`task_send` 返回 `queueDepth {nextTurn, nextStep}`（投递后口径，含本条）+ 动态 hint（queue→运行中且深度 ≥2 给"~N 轮后读，改变下一步考虑 steer"；steer→运行中给"步边界 + 延轮"）；`task_wait` 超时附"考虑结束回合"提示；`task_send`/`task_progress` 冷路径附冷提示。

### 关联与追溯 [0.3.0 新增]

- `task_send` 返回 `messageId`；`task_spawn` 返回 `correlationId`——需要被引用的那一条要记下；
- 纠偏/续接先前指令：`task_send({ reference: <messageId 或 correlationId> })`——引用以可见注释行随消息送达；
- 多目标等待：`task_wait({ sessionIds: [...], mode: 'all' | 'any' })`（`all` 等全部空闲，`any` 任一空闲即返回；兼容单目标 `sessionId`）。

## 5. 限流与容量判据

| 判据 | 默认值 | 配置项 | 越限行为 |
|---|---|---|---|
| 同目标最小发送间隔 | 2000ms | `minSendIntervalMs` | `task_send` / `task_spawn` kickoff 拒绝（`rate-limited`），稍等重试即可 |
| 目标排队深度上限 | 5（0.23.0 起 GUI 可改：设置区 `maxQueuePerTask`，0=跟随 config，硬上限 50，限流器活取 getter 免重启生效） | `maxQueuePerTask` | `task_send` 拒绝（`queue-full`），防刷屏 |
| `task_wait` 默认超时 | 120000ms | `waitDefaultTimeoutMs` | 超时返回——**不代表失败**，任务还在跑 |
| `task_wait` 超时上限 | 600000ms | `waitMaxTimeoutMs` | 参数超过则收敛到上限（`waitDefault > waitMax` 时同样收敛） |
| 单次批量上限 | 6 | `maxBatchSpawn` | `task_spawn_batch` 拒绝（`bad-request`），拆小批 [0.5.0 新增] |
| 派生代数上限 | 2 | `maxSpawnDepth` | 超限的派生拒绝（`spawn-depth-exceeded`）[0.5.0 新增] |
| 派发确认闸门 | 开 / 阈值 2 | `confirmBeforeBatch` / `confirmBatchThreshold` | 达阈值的批量缺凭证拒绝（`confirmation-required`）[0.6.0 新增] |
| 工作区归属策略 | `ancestor` | `workspacePolicy`（`exact` \| `ancestor`） | spawn cwd 只精确匹配（`exact`）或加最近祖先升级（`ancestor`，默认）；`grouping` 为保留档、传入即 TypeError [0.19.0 新增] |

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
| `confirmation-mismatch` | 批量夹带了多选确认未勾选的任务标题 | 0.10.0 |
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
- **记录字段**：`team` / `title` / `promptExcerpt`（**用户原始 prompt** 的摘录）/ `depth` / `parentSessionId`（后两者 0.5.0 起）/ `expectedWorkspace`（0.19.0 起：spawn 时调用方期望归属路径——显式 `cwd`，缺省时调用方 cwd；未分组/worktree/归一落位的**事后批量补救**线索）/ `externalRef`（0.25.0 起：外部派发方的自由文本对应标识——建议格式 `<thread短id>:<波次名>`，只存储回显**不解析**；wire 契约 C1 见 §9）；
- **消费面**：`task_list({ team })` 的成员判定、列表行与 `task_progress` 结果里的 `team` 富化、深度推导（§9）；`expectedWorkspace` 供 `task_list({ ungrouped: true })` 之后的补救决策；`externalRef` 经列表行与 `task_progress` 同款 registry 合并路径透出（跨代理会话对应——外部驱动方反查「这个 DSH 会话是我的哪个对话/波次派的」）；
- **容错契约**：读取**永不抛错**——缺失或损坏降级为空注册表；损坏文件保留为 `*.corrupt-<时间戳>` 供检查，不静默丢弃；字段级白名单（非法类型值加载时丢弃）；
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
- **cwd→工作区升级 [0.12.0]**：将发送的 cwd（显式参数或降级路径）与 `workspaceRegistry.list()` 快照的工作区 path **精确匹配**时改发 `workspaceId`——宿主派生同一 cwd 并挂载；未命中保持旧语义。归一按平台分支 [0.12.1]：win32 分隔符归一 + 大小写折叠 + 盘符根保留；darwin 仅大小写折叠；POSIX 保留大小写（反斜杠是普通文件名字符）。归一只是预筛——宿主实体 attach 的 realpath 全等校验才是权威。
- **工作区归属兜底链 [0.19.0]**（设计蓝图 `research/workspace-placement-fallback.md` 定案实施，18 场景 harness 实证驱动）：spawn 的 cwd 归属判定升级为五级链——① **词法精确匹配**：新单一真源纯函数 `matchWorkspacePaths`（`ops.mjs`，spawn 链与 `task_list` 未分组过滤共用）；`normalizeWorkspacePath` 新增剥 `.` 路径段（三平台分支各自处理，UNC 前缀/盘根保留），治愈"宿主 realpath 能解析而词法归一不能"的 canon 分叉；② **调用方继承**（成员归属/祖先链/`caller.cwd` 精确，0.8.1–0.12.0 逻辑原样保留）；③ **最近祖先升级**（`workspacePolicy: 'ancestor'`，默认档）：将要发送的 cwd 是某注册工作区路径的**真子目录** → 挂**最长归一前缀**的祖先工作区（嵌套工作区取最近）；宿主以工作区根派生会话 cwd，回执带 `placement: 'ancestor-normalized'` + `normalizedFrom`，kickoff 在 reportBack 后缀之前追加 i18n 机械提示（`i18n.mjs` 新键 `workspaceNormalizedSuffix`，zh/en，随宿主语言偏好）：告知 cwd 已归一到工作区根、任务目标目录在哪、文件/git 操作用显式路径；④ **git worktree 识别（只分类、绝不升级挂载）**：经 `index.mjs` 注入的 `probeWorktree` 探针（`statSync(<cwd>/.git)` 为**文件**即 linked-worktree 标记；探针异常/缺失一律按"非 worktree"降级；**无子进程 git 调用**，gitdir 反查属未验证机制、留给保留档）判定为 worktree 的未命中 cwd → 保隔离落未分组 + 回执强警告（宿主 attach 校验 cwd 全等，挂主仓必毁隔离；补救 migrate 同样丢隔离）；⑤ **未分组终点必附回执警告**。可观测性无条件全量：spawn 成功载荷新增 `workspace`（`{id,title}` | `null`）与 `placement` 枚举（`exact-match` | `caller-inherited` | `ancestor-normalized` | `ungrouped-worktree` | `ungrouped`，`WORKSPACE_PLACEMENTS` 导出为单一真源），未分组附 `warning` + 补救提示（`task_workspace` attach/migrate、`task_list({ ungrouped: true })` 审计、`team` 编组仍可逻辑分组）；`task_spawn_batch` 逐项 results 同构携带。`task_list({ ungrouped: true })`（新参数）：只列不属于任何工作区的会话——用同一 `matchWorkspacePaths` 的**精确档**镜像宿主 `sessionIds` 桶的口径（会话 cwd 词法精确等于工作区路径才算归属；子目录 cwd **算**未分组，正是待补救对象；无 cwd 行保留）。注册表新增 `expectedWorkspace` 字段（§7）。宿主约束（0.1.2-rc.1 实测）不变且封死组合面：create 互斥（workspaceId XOR cwd）、cwd 派生优先级 `workspace?.path ?? request.cwd ?? defaultCwd`、attach realpath 全等校验——不存在"既挂工作区又保 worktree/子目录 cwd"的组合，唯一出路是③让宿主把 cwd 派生成工作区路径（隔离代价已在回执与 kickoff 双明示）。`workspacePolicy: 'exact'` 档关闭③，保留 0.18 及以前的仅精确匹配行为；`grouping` 档**保留未实现**，配置传入按无效值拒绝。
- **既有会话迁移 [0.12.0]**：`task_workspace` 直连 `workspaceRegistry.get(id)` 返回的**活实体**：`attachSession` 自带宿主校验（读会话头 cwd → realpath → 必须与工作区 path 全等，`dsh-workspace` 实体 87-105 行），幂等；`detachSession` 为逆操作。均不向会话注入消息。GUI 无等价入口：拖拽走 `workspace.insertSessionBefore`，仅接受已在区内会话（否则 `WorkspaceMoveInvalidError`），`workspace/move-invalid` 由此而来；工作区控制器 API 面（create/rename/delete/insertBefore/insertSessionBefore/archiveSession）不含跨区 attach。
- **跨工作区真迁移 [0.16.0]**：宿主从不改写既有会话的存储 cwd（attach 以它为准校验），跨路径移动 = 克隆 + 归档五步：① `sessionQuery.readSession`（`dsh-session-query` 955 行：返回克隆 header + 完整经重放校验的事件日志，**不激活**源会话）；② `sessions.create(undefined, {seed, meta})`（`dsh-session` 1579 行：`meta.cwd` 必须绝对路径——目标工作区路径；保留原 `createdAt`/`agentPreset`；store 铸新 id）；③ `sessions.flush(session)`（1750 行）持久化；④ 目标实体 `attachSession(新id)`（新会话头 cwd = 目标路径，校验天然通过）；⑤ `workspaceRegistry.archiveSession(旧id)`（`dsh-workspace` 422 行：持久、幂等、未知会话抛错；语义经 206-215/408 行与真机验收澄清——归档只把旧 id 记入工作区 `archivedSessionIds`（GUI 据此折叠），`sessionIds` 槽位保留、会话本体仍在 store 且可读可续跑，migrate 回执 note 因此带分叉警告）。宿主自家 `fork()`（`dsh-api-session-controller` 655 行）内部同款种子创建原语，但它刻意保留源 cwd 与工作区（696 行），不能改道——社区 `dsh-session-mover` 实证了这条唯一干净通道。防护：运行中拒迁 `migrate-busy`（克隆只带得走已持久化日志）；源 cwd 已等目标路径 → bad-request 提示 attach；服务缺失 → `migrate-unavailable`；②③④⑤ 任一步失败 → `migrate-failed`，消息明确孤儿克隆 id 与原会话未归档状态；⑤ 失败但④成功 → `ok:true` + `archived:false` + warning。注册表记录（team/depth/parentSessionId/title/createdAt）平移到新 id，旧条目留作归档历史。**守卫注记 [0.25.1]**：宿主 core ≥0.1.5（含 0.1.5-rc.x 预发布）期间 `migrate` 守卫停用——上游 `sessions.flush` 对插件直建会话静默不落盘（克隆假成功、重启即失，P0）+ `readSession` 对 seeded/forked 会话必抛（上游回归，rc.2 未修，P1），`ops.mjs` 经 `shouldGuardMigrate(detectHostCoreVersion())` 拒迁并报 `migrate-disabled`（原因两条 + 替代 attach/detach + 正修指向 v0.26 接 `sessionPersistence.create(header)` 写句柄 seam 或等宿主修复）；探测失败 fail-open 保持旧行为。旧核 0.1.2 系本五步链零改动，详见 `research/host-upgrade-drift-0.1.2-0.1.5.md` 面 1。
- **子会话模型指定 [0.13.0]**：`task_spawn`/`task_spawn_batch` 条目接受可选 `provider`+`model`（+`reasoningEffort`，成对约束）。两级校验：① 创建前经 `llm.resolveCallConfig` 目录预校验——无效路线 `model-unavailable`，**不创建会话**（目录服务缺失时优雅跳过，交②兜底）；② 创建后、开场前经 `sessionController.selectModel` 安装（`dsh-api-session-controller` 600-628 行）——选择经 `model/selection` 会话事件持久化（重启存活），安装失败报 `model-select-failed` 附孤儿 sessionId 且**不开场**。宿主语义：`selectModel` 同时 `agentDefaultModel.saveSelection` 更新应用级默认模型（settings `agent-default-model` 命名空间，GUI 选择器同行为）；它是唯一公开入口（会话本地的 `selectForNextRequest` 为控制器内部方法、非服务 API），插件如实披露而非绕过。
- **模型路由发现 [0.14.0]**：市场分发下每个部署接入的路线都不同，id 从不写死。`task_models` 调 `sessionController.modelCatalog()`（2722 行，Remote 门面公开方法；内部 `buildModelCatalog` 经 `llm.listProviders/listModels/resolveModelInfo` 聚合，1933-1980 行——GUI 模型选择器同源）投影为精确 id：provider 分组、model id、efforts、应用级 `default`、单点失败 `failedProviders`。宿主无此方法的老版本降级 `catalog-unavailable`。`model-unavailable` 错误经 `describeModelRoutes` 附可行动提示（优先该 provider 的 model id 列表，回退可路由 provider 列表；全链失败容忍，任何异常退回原始错误消息）。
- **派发默认模型 [0.18.0]**：解析链三级化——显式工具参数 > 插件默认（durable 设置区 `task-coordinator`，`normalizeSpawnRoute` 纯函数：空对=null 跟随宿主默认、修剪、半对抛错）> 宿主默认。`spawnTask` 在调用未带 provider+model 时回退（reasoningEffort 显式值优先于默认值），回退路线走与显式指定**完全相同**的两级校验链（预校验零孤儿 + selectModel 安装）；ops 层对 `readSpawnDefaults` 包 try/catch——存储层畸形降级为「未设置」，绝不破坏派发。成功载荷回显 `modelSource`（`explicit`/`plugin-default`/`host-default`）；`task_models` 附 `pluginDefault`（读取同防御纪律）。批量逐项经 `spawnTask` 同路覆盖。客户端页签见 §12。
- **界面本地化 [0.15.0]**：用户可见文案跟随宿主语言偏好——持久化于 settings 命名空间 `locale`（字段 `preference`：`zh`|`en`，`@deepseek-ai/dsh-client-locale` 拥有，GUI「设置→通用→语言」行写入；`settings.get(ns)` 直接返回解析值，未注册返回 undefined）。宿主侧每次调用实时解析 `i18n.mjs` 冻结字典（确认卡标签/标题/问题、多选卡、汇报约定后缀；`/tasks` 元数据挂载时捕获）；浏览器侧防御性接入 `LocaleRuntime`（不硬声明 inject，`ctx.locale` 缺失即退回内置中文字典；`register(NS,{zh,en})` + `translate(NS,key)` + `getSnapshot/subscribe` uSES 重渲染，语言切换与词典注册都 bump revision）。迟注册修复 [0.16.1]：locale 插件可能比按钮后装载，apply 一次性读取会漏掉服务，而宿主 `bind(ns)` 对未注册命名空间照发回显裸键的 `t`（`translate` 词典缺失返回原 key，client.js:1294）——改为 `ensureLocale()` 惰性重试（服务一被看见即注册，register bump revision 实时刷新已渲染出口；HMR "already" 拒绝视为已注册）+ `props.t` 裸键防护（返回值等于 key/`NS.key`/非字符串即回落内置 zh 字典）。回退纪律：只认精确 `en`，缺失/不可识别一律 zh——「未设置=跟随浏览器语言」是浏览器侧委托语义，宿主侧不可见，绝不猜测。
- **externalRef 外部对应标识 [0.25.0]**（wire 契约 C1，`research/dshq-ledger-mailbox-spec.md` Part C，与 `dsh-plugin-task-bridge` v0.2.0 两端锁死、不得单方更改）：`task_spawn` 接受可选 `externalRef` 参数——外部派发方（如经桥驱动 DSH 的 Codex 对话）的自由文本标识，语义为**只存储回显、不解析**（建议格式 `<thread短id>:<波次名>`）。校验规则：string、trim 后 ≤200 字符；空串/仅空白视为**缺席**（成功但不携带）；`null`/`undefined` 与其他可选字段同规视为缺席；其余非字符串或超长 → `bad-request`，且校验先于会话创建（**零孤儿**）。落点：registry 记录（§7 字段表，持久化+损坏值加载过滤照 `expectedWorkspace` 0.19.0 先例）→ spawn 成功回执回显（trim 形态）→ `task_list` 行与 `task_progress` 结果透出（照 `team` 的 registry 合并路径，未记录不携带键）。校验实现在 ops 层而非仅工具 schema——桥消费方直接调 ops（§17.2），绕过宿主 schema 编译。**`task_spawn_batch` 本版不接受**（桥 MVP 无 batch 端点）：条目上的该字段被忽略（不转发/不记录/不回显），工具 schema `additionalProperties:false` 在宿主层拒绝。

## 10. 派发确认 [0.6.0 新增]

**弹窗信道**：`ctx.get('userQuestions').ask()`——与官方 `exit_plan_mode` 同构（`intent.kind: 'plan-review'`）。问题构造遵守接缝的收窄校验（单问题、非多选、≤2 选项、`detail` 非空、approve 标签与某个选项**逐字一致**），渲染为计划审批卡。零客户端改动。**卡片视觉 = 宿主官方 plan-review 渲染器**（`dsh-client-ui-user-questions` 的 Plan review 条带 + 可滚动 markdown 主体 + `Chat about it`/`Refuse`/`Approve` 决定行），与 exit_plan_mode 完全同款，风格一致性是结构内禀的；插件只控制文本内容。**内容规范 [0.9.0]**：`plan` 强制 `# ` 一级标题开头（与官方同款校验 `/^#\s+\S/`），保证每张卡片主体与官方计划同构。

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

**多选确认（部分派发）[0.10.0]**：`task_confirm_select` 走**同一接缝的通用提问渲染**（不带 `plan-review` 意图）：单个 `multiSelect: true` 问题，选项 = 拟派发任务（`label` = 标题，`description` = 范围），自定义输入行为宿主原生能力。因此卡片是宿主中性提问 UI（无琥珀 warn 样式）。答案映射：勾选项为空 → 视为调整意见（`approved: false` + feedback）；非空 → 铸 `confirmationId` 并把**选中子集**记入进程内凭证。`spawnBatch` 对带子集的凭证**无论是否达阈**都强制批量标题 ⊆ 选中集（精确匹配，夹带即 `confirmation-mismatch`；无标题项视为未批准）。通用 UI 不渲染 markdown 正文——完整方案由总控先写在聊天里（工具描述已注明）。

**任务级复用凭证 [0.11.0]**：`task_confirm` / `task_confirm_select` 可选 `reusable: true`——凭证记录携带 `reusable` 标记，`spawnBatch` 成功消耗逻辑对其跳过（凭证存活于多次成功批量）。语义：长程任务（goal 模式）首次分析后确认一次，同一使命后续批量复用同一 `confirmationId`；默认单次语义不变。约束不变：绑定调用会话（跨会话借用报 `confirmation-required`）、进程内存放（宿主重启失效）、多选子集强制对每次复用生效。

## 11. 结果回报约定 [0.7.0 新增]

`reportBack`（默认开）：`spawnTask` 在**开场提示词尾部**追加汇报指令——完成后 `task_send` 结果摘要（结论、产出路径、遗留问题）回派发方会话；发送失败则写进最终回复。边界：

- **注册表摘录永远是用户原始 prompt**——摘录记意图，不记派生文本；
- 追加是 prompt 级约定，不是硬信道——子任务若被外部中止，总控靠 `task_wait` + `task_progress` 兜底；
- `task_spawn_batch` 的 `reportBack` 批级生效；`reportBack: false` 时开场词保持原样；
- **[0.17.0 升级] 让位协议句**：追加指令新增两句（zh/en 逐句对齐）——①发送后即结束当前回合，不在回合内等待或轮询总控回复（总控回复经"空闲自动开新轮"送达）；②多阶段任务需评审的阶段发阶段报告并让位等指示，未约定评审点的阶段连续执行。前缀不变；失败回退句保留。

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
- **cwd 归属策略 [0.19.0 变更]**：默认档 `ancestor` 下，显式/继承 cwd 命中某工作区**子树**时子会话 cwd 会被宿主归一到最近祖先工作区**根**（回执与 kickoff 双明示）——需要"保子目录 cwd、落未分组"的 0.18 及以前行为时配 `workspacePolicy: 'exact'`；跨项目派发仍应传与目标工作区路径精确匹配的显式 `cwd`；
- **worktree 不升级 [0.19.0]**：linked worktree 的 cwd 刻意保持未分组（隔离优先，见 §9 兜底链④）；若以分组为重，`task_workspace migrate` 是唯一补救，但克隆以工作区根出生、worktree 隔离同样丢失——与挂主仓同价，仅多保留历史；
- **进度报告裁剪**：`task_progress` 的对话尾部按 `progressTailMessages`（默认 6 条）×`excerptChars`（默认 400 字）裁剪，防止上下文爆炸；
- **技能依赖可缺**：`dsh-skill-filesystem` 不可用时技能不挂载（仅 warning），八工具不受影响；
- **注册表只记 spawn** [0.3.0 新增]：`team` 过滤依赖注册表记录——注册表启用前创建或外部创建的会话无法按团队检索；
- **`/tasks` 只读** [0.4.0 新增]：命令面不做任何动作；短 ID 前缀歧义时报错而不是猜第一个；
- **确认凭证进程内** [0.6.0 新增]：宿主重启后需重新确认（设计取舍，见 §10）；
- **回报约定非硬信道** [0.7.0 新增]：子任务被外部中止时不会回报，拉取兜底不可省；
- **冷会话深度守卫盲区** [0.17.0 实测]：`pendingCount` 对无 live agent 的冷目标恒 0——`maxQueuePerTask` 对冷目标不生效；`task_wait` 对冷目标立即返回 already-idle（冷 ≠ 无待办）。回执与 `task_progress` 冷路径带提示；彻底修复（sessionQuery 重放冷 inbox）列二期。

## 14. 验证记录

- **单元**：95 个测试（`test/smoke.test.mjs`，mock 宿主，`node --test`）全绿——覆盖 0.3.0 注册表/编组/引用/多目标等待、0.4.0 命令语法/渲染/注册降级、0.5.0 批量（部分失败/超上限/深度链）、0.6.0 确认（批准/拒绝/取消/无信道/子代理拒答/闸门五态）、0.7.0 回报（默认开/关/批量逐项）、0.8.1 工作区归属（继承/显式 cwd 覆盖/祖先链/降级/批量逐项）、0.9.0 确认卡标题规范（无标题/二级标题拒绝）、0.10.0 多选确认（子集批准/夹带拒绝/无标题拒绝/空选反馈/关窗/无信道/子代理拒答/子集凭证消耗）、0.11.0 复用凭证（跨批存活/跨会话拒借/子集强制持续）、0.12.0 工作区迁移（路径归一/精确匹配升级/list-attach-detach 实体链/五类失败模式/平台分支 win32-darwin-linux）、0.13.0 模型指定（成对校验/目录预校验零孤儿/安装时序 create→selectModel→prompt/安装失败孤儿不开场/目录缺失降级/批量逐项转发）、0.14.0 路线发现（目录投影/老宿主与坏目录降级/提示纯函数失败容忍/model-unavailable 错误附路线提示）、0.15.0 界面本地化（偏好解析回退纪律/字典插值/en 确认卡标签批准闭环/拒绝回退标签/多选 en 问题与空选反馈/开场后缀随语言/命令元数据）、0.16.0 跨工作区真迁移（五步时序 read→create→attach→archive→注册表平移、克隆元数据全携带[目标 cwd/原 createdAt/agentPreset/完整 seed]、运行中拒迁、同 cwd 拒绝提示 attach、服务缺失降级、克隆失败零副作用、挂载失败孤儿报告、归档失败仍算移动成功、日志不可读、未知 action 消息含 migrate）、0.17.0 投递回执（queueDepth 分列/动态 hint 三分支/冷会话 note/回报让位协议句/超时 hint）、0.18.0 派发默认模型（normalizeSpawnRoute 纯规则/validate 写边界/fallback 链+modelSource/畸形存储降级不破坏 spawn/默认路线同过预校验/孤独 effort 搭乘/批量继承/pluginDefault 投影与降级）、0.19.0 工作区归属兜底链（config 枚举默认 ancestor+grouping 拒绝、normalizeWorkspacePath 剥 `.` 段三平台分支、matchWorkspacePaths 精确/最近祖先/盘根/兄弟前缀/异常容忍、**调研 §2 的 18 场景矩阵整表回归**、exact 档不升级、worktree 探针三级降级、归一 kickoff 后缀随 uiLocale、batch 逐项回执、task_list 未分组过滤、expectedWorkspace 记录-持久化-白名单）；
- **集成**：`verify-installed.mjs` 在**安装位置**用真实 `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-skill-filesystem` 包 + mock ctx 跑 `apply()` 全链路（schema 编译、消息构造、9 工具、`/tasks` 五路径、确认闸门全链、多选确认子集强制、安全守卫、卸载清理、0.8.0 客户端模块全链）；宿主升级 2.0.5（core **0.1.2-rc.1**）后重跑全绿；
- **端到端**（重启后真实宿主）：0.2.0 六项能力实测通过（运行中 `steer` 纠偏、取消后恢复、自环守卫；`task_spawn` kickoff 曾发现 prompt 门面缺 AbortSignal 的缺陷，修复后复验 `SPAWN_FIXED_OK`）；命名规则实测 `0904｜修复｜回归套件`；0.6.0 确认卡经官方 `userQuestions` 接缝同构路径构造（`exit_plan_mode` 先例 + 接缝错误码逐项核对）。

## 15. 客户端模块契约 [0.8.0 新增]

插件首次进入浏览器侧。装载链逐段实测（DSH Desktop 2.0.5 / core 0.1.2-rc.1）：

1. **声明**：`package.json` 的 `dsh.client` 必须含 `platform: "web"`；`dsh-client-modules` 的 `parseDshClient` 对其余字段（`inject?`、`external?`、`immediately?`）做窄化校验，非法即抛。
2. **入口解析**：`exports["./client"]`（字符串或含字符串 `default` 的对象）解析为相对包根的路径；缺失则 `declares dsh.client but exports no "./client" bundle`。**另需 `exports["./package.json"]`**：扫描器经 `createRequire(baseUrl).resolve('<包名>/package.json')` 定位清单，未导出该子路径会 `ERR_PACKAGE_PATH_NOT_EXPORTED`，插件被**静默排除**出客户端模块图（0.8.2 实测根因；同环境 `dsh-better-sidebar` 有该导出而正常装载）。
3. **bundle 格式**：该文件被**原样** `readFileSync` 装载并经 `/plugins/<id>/client.js` combo 路由下发，必须是 `window.__ModuleLoader__.load({ id, factory })` 注册（官方 `dsh-session-log-export` 编译产物同构）；`factory(require)` 中 `require` 绑定共享客户端图（`react` 等），返回 `module.exports`，导出 `apply` 与 `inject`（服务名数组，如 `["slots"]`）。
4. **槽位占用**：`apply(ctx)` 在客户端 cordis 纤维执行；`ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name, id, order?, label? }, Component))`。占用者组件收到标准会话 props（含 `sessionId`）+ `inject()` 返回的附加 props。
5. **本插件占用**：`id: "copy-session-id"`，渲染「复制会话Id」按钮——面性设计（亮色黑底白字 / 暗色白底黑字，走 `--dsw-alias-label-primary` / `--dsw-alias-label-primary-foreground` 主题 token），几何对齐「Session 日志」按钮（圆角 18px / 高 32px / 13px 文字）；点击 `navigator.clipboard.writeText(sessionId)`（`document.execCommand('copy')` 降级），1.5s 状态反馈（已复制 ✓ / 复制失败）。
6. **设置一级页占用 [0.18.0 → 0.18.1]**：`settings.section` 槽注册 `id: "task-coordinator"` 一级页（设置左侧导航，与 通用/模型/插件/Agent 预设 同级；原生 order：general=0/models=10/plugins=15/agent-presets=20，我们=25）。数据面：候选经 `remote.session.modelCatalog()`（GUI 选择器同源，宿主目录含自建网关路线时自动出现）；读写经 `settingsScope.bind({namespace: 'task-coordinator'})`（`getSnapshot/subscribe` 跟随 describe 镜像，`set(field, value)` 三次队列写回 provider/model/reasoningEffort）。**关键接缝事实（0.18.1 修复，源码 dsh-cordis-client-runner `dynamicCordisContext` L319-342）**：动态插件的 `ctx.serviceName` 直接属性访问受 fiber 的 inject 声明门控——读**未声明**服务直接抛错；官方旁路是 `ctx.get(name)`（requireDeclaration=false）。本 bundle 只 inject `["slots"]`，故 locale/settingsScope/remote 一律经 `ctx.get()` 寻视（0.16.1 的属性访问式懒寻视在生产上从未真正生效——语言切换一直静默回退内置 zh；0.18.0 的设置页下拉因此恒灰）。每个降级态渲染真实文案（缺服务/命名空间未注册/目录失败）；已保存但目录下线的路线显示「（已下线）」仍可改选（对齐原生 subagent-model-selection 卡 stored/available 合并语义）。verify-installed 以复刻门控的 Proxy（未声明属性读抛错 + get() 应答）做回归。

**已验证**：1–4 为源码级实测（`dsh-client-modules/lib/index.js` resolveMeta/parseDshClient/clientExportOf + 槽契约总目 + 官方占用者先例），`verify-installed.mjs` 覆盖声明/bundle/占槽/点击复制；`./package.json` 导出缺失 → `ERR_PACKAGE_PATH_NOT_EXPORTED` 的排除路径已离线复现（0.8.2）。**渲染链路活体通过**：0.8.2 修复后按钮在真实 GUI 出现，用户基于描边版提出样式改版；0.8.3 面性版（亮色黑底白字 / 暗色反转、对齐「Session 日志」几何）经用户目视确认通过（2026-09-04）。**本章无遗留未验证项。**

## 16. 部署约定 [0.8.4 新增]

- **安装入口**：`install.ps1`（仓库根为工作区便捷包装，`plugin/install.ps1` 为仓内等价版）——复制包文件、保证 profile `package.json` 的 `dependencies` + `dsh.profile.bundles` 登记，然后**必须重启宿主**才装载新 bundle。
- **技能目录拷内容不拷目录**：`Copy-Item` 的源是目录且目标目录已存在时会拷**进去**（嵌套 `skills/skills/`），正式路径技能文件从此不再更新——0.4.0–0.8.3 的实际事故。现行脚本复制 `skills\*` 内容并清理历史嵌套残留；技能走 `patchReload: live`，内容更新**无需重启**即刻热刷新。
- **安装态自检**：任何宿主/插件变更后，把 `verify-installed.mjs` 复制进安装目录运行（跑完删除），全绿才放行；它断言服务版本、11 工具、`/tasks`、确认闸门、多选确认子集强制、复用凭证跨批、task_workspace 实体链与 migrate 克隆五步链（目标 cwd 出生/元数据携带/同 cwd 拒绝零副作用）、spawn cwd 升级、**0.19.0 工作区落位（回执 placement/workspace 字段、祖先归一全链 workspaceId+根 cwd+i18n kickoff 提示+注册表 expectedWorkspace、未分组警告+task_list ungrouped 过滤）**、子会话模型指定（预校验拒绝/安装时序/成对约束/错误路线提示）、task_models 目录投影、客户端 i18n 回归（0.16.1：裸键 `t()` 回退内置词典、迟注册 locale 服务首见即注册、zh/en 实时解析）、工作区归属与客户端模块全链、0.17.0 投递回执（task_send queueDepth 分列断言、回报后缀让位协议句断言）、**0.24.0 服务缝（enabled 载荷含活 ops 且 13 成员可调、经载荷直调 listTasks 端到端、disabled 载荷 ops 缺席）**、**0.25.0 externalRef（spawn 带 ref → 回执 trim 回显 + registry 落盘 + list 行/progress 透出、超长 bad-request 零孤儿）**。

## 17. 服务缝（0.24.0 新增）

本插件在宿主进程内 provide 一个 `taskCoordinator` 服务，供未来的桥接插件（`dsh-plugin-task-bridge`——Codex→DSH 控制面桥，进程外 HTTP 消费方的进程内代理）解析并复用。缝面恰为两处改动，对既有工具行为零变化（设计蓝图 `research/task-bridge-reanchoring.md` §1）。

### 17.1 provide 契约（双形状载荷）

```js
ctx.provide('taskCoordinator', { config, version, ops });
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `config` | object | `resolveConfig` 产物（含 `minSendIntervalMs`/`maxQueuePerTask` 等限流参数——桥侧据此计算 429 的 `retryAfterMs`） |
| `version` | string | 与 package.json 锁步的插件版本（当前 `0.24.0`） |
| `ops` | object | **`createOps` 产物同一实例**——`registerTools` 已在用的那个，不另建。13 成员：`pendingCount`、`listTasks`、`progress`、`sendMessage`、`spawnTask`、`confirmPlan`、`confirmSelect`、`consumeConfirmation`、`workspaceOp`、`models`、`spawnBatch`、`waitFor`、`cancelTask` |

**时序与形状规则**：

- **enabled 路径**（默认）：`ops` 在 `createOps(...)` 之后随全量载荷 provide——桥拿到的是活的实例，限流计数（`SendLimiter`）、spawn 注册表（`SpawnRegistry` 单写者）、确认凭证（进程内 Map）与 GUI 内总控**天然共享同一状态**，不存在双写者分叉；
- **disabled 路径**（`config.enabled: false`）：早退分支 provide `{ config, version }`——**`ops` 缺席但服务存在**。这是刻意的降级信号：桥侧把 ops 缺席映射为 503（对齐 webhook-github 的 503 语义），而不是服务整体缺失导致桥永不激活；
- provide 恰好一次（每分支一次）；`createOps` 恰好一次——不存在「先 provide 占位、后补 ops」的二次 provide（cordis 同名 provide 撞名抛错）。

### 17.2 消费方约定（桥侧必守）

1. **只读 ops**：桥只**调用** ops 成员，不得篡改、替换、包装（monkey-patch）任何成员或内部状态。ops 是 tools 面与桥面共享的活实例，任何篡改直接破坏 GUI 内总控的工具行为；
2. **同 label 声明**：桥的 `cordis.patch.yml` 声明**同一字符串 label**（见 §17.3），否则宿主其他插件（含桥）用 root Symbol 查不到该服务实现；
3. **惰性解析**：桥对 `taskCoordinator` 用 **`ctx.get('taskCoordinator')`** 按调用惰性解析，**不硬 inject**——coordinator disabled 或后装载时桥仍需挂载自己的路由并回 503/降级（同款先例：本插件对 `userQuestions` 的惰性解析，index.mjs）；
4. **不得 provide 同名服务**：cordis 的 provide 撞名抛错（`reflect.ts`）——桥绝不 provide `taskCoordinator`；
5. **伪 caller 语义**：桥没有 agent 上下文，须合成伪 caller（如 `{ sessionId: 'task-bridge-external', origin: undefined, cwd }`）。`checkCaller` 只校验 sessionId 非空 + origin ≠ subagent，可通过；连带语义：消息 source 落伪 senderSessionId（审计可辨）、registry 落伪 parentSessionId（桥 spawn 恒 depth 1）、**reportBack 必须强制 false**（伪 id 非真实会话，回报后缀指向不存在的目标）、确认凭证绑定伪 callerSessionId（GUI 会话预批的凭证桥用不了，桥须自走 confirm 闭环）；
6. **方法白名单收敛**：桥获得的是 ops 全能力（含 `workspaceOp` migrate 等重操作）——桥侧只透传 MVP 端点所需的 6 方法子集（spawnTask/waitFor/progress/sendMessage/listTasks/models），其余不暴露。

### 17.3 isolate 共享 label 语义

`cordis.patch.yml`：

```yaml
- insert:
    - id: task-coordinator
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      isolate:
        taskCoordinator: 'dsh-task-bridge'   # 0.24.0 前是 true（entry-local）
```

cordis 加载器的 isolate 机制（`@deepseek-ai/cordis-plugin-loader/src/config/isolate.ts`）：

- `isolate: { <service>: true }` → **LocalRealm**（Symbol 后缀 `#<entry-id>`，仅该 entry 可见）——0.23.0 及以前的状态：服务实现存在 `Symbol('taskCoordinator#task-coordinator')` 下，宿主其他任何插件默认查不到；
- `isolate: { <service>: '<label>' }`（字符串）→ **GlobalRealm**（后缀 `@<label>`，**同 label 的 entries 共享同一 Symbol**）——0.24.0 起：实现存在 `Symbol('taskCoordinator@dsh-task-bridge')` 下，声明同 label 的桥插件可解析，其余插件（root Symbol）仍不可见。

**暴露面评估**：改共享 label 只把服务可见性扩大到「声明同 label 的插件组」，不扩大到全宿主——比「直接删除 isolate 声明（回 root 全局可见）」暴露面小，符合最小暴露原则。故障隔离（group 插件组结构）不受 label 改动影响。

**热切换说明**（升级场景）：已装环境从 `true` 升级到共享 label 时，loader 的 `loader/patch-context` 钩子会走一次实现迁移（isolate.ts:96-153：新 isolate map → 服务 diff → fiber reload → 实现从旧 Symbol 迁到新 Symbol → notify 依赖方）。机制源码已验证（isolate.ts step 5, L132-136）；**热切换实测未做**（调研 §6 未验证项 2——需在测试宿主上验证「旧 label 运行中 → 热更 patch → 服务连续性」，总控部署后补跑）。首次部署是冷加载，不涉及迁移。

**Realm GC**：entry dispose 时若无其他 entry 引用同 label 则回收（isolate.ts:155-172）。桥卸载不影响 coordinator；coordinator 卸载则桥的惰性 `ctx.get('taskCoordinator')` 返回 undefined → 桥降级 503。
