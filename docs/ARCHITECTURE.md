# 架构设计

> 本文面向要改插件源码、接宿主契约或维护本仓库的人。普通使用请看 [README](../README.zh-CN.md) 的快速开始。

## 为什么是插件而不是外挂

DSH 宿主已经把跨任务协调需要的原语全部暴露了——`ctx.sessionController`（Remote 门面）、`ctx.agents`（活体注册表）、`ctx.tools`（工具注册）、`api-session/added` 事件（侧栏可见性）。插件形态意味着：

- **零宿主改动**：cordis 插件组隔离挂载（`cordis.patch.yml` 的 `isolate: taskCoordinator`），一个故障不会拖垮宿主；
- **随装随卸**：`install.ps1` / `-Uninstall` 对称，卸载后不留工具、不留命令、不留技能；
- **命令面即合约**：八个 `task_*` 工具全部走 `defineTool` 注册、`/tasks` 斜杠命令走 `ctx.commands.register` 注册，模型面、快速通道与宿主面三者解耦。

## 模块分层

```mermaid
flowchart LR
    host["DSH Desktop<br/>cordis 内核"]

    subgraph plugin["dsh-plugin-task-coordinator · 隔离插件组"]
        direction TB
        index["index.mjs<br/>cordis 入口 · 装配"]
        tools["tools.mjs<br/>九个 task_* 工具"]
        commands["commands.mjs<br/>/tasks 斜杠命令"]
        ops["ops.mjs<br/>会话操作 · DI 工厂"]
        skills["skills.mjs<br/>隔离技能挂载"]
        registry["registry.mjs<br/>持久 spawn 注册表"]
        client["client.js<br/>Web 客户端模块（浏览器侧）"]

        subgraph pure["纯模块（零宿主 import）"]
            direction LR
            config["config.mjs<br/>配置解析"]
            safety["safety.mjs<br/>守卫 + 限流器"]
            title["title.mjs<br/>spawn 命名规则"]
        end

        index --> tools --> ops
        index --> commands --> ops
        index --> skills
        index --> config
        index --> registry --> ops
        ops --> safety
        ops --> title
    end

    sc["ctx.sessionController<br/>list/create/prompt/cancel/<br/>rename/resolveAgent/inspect"]
    agents["ctx.agents<br/>get/status/inbox/<br/>whenIdle/followup/steer"]
    uq["ctx.userQuestions<br/>ask()（惰性解析）"]
    skill["task-coordination 技能<br/>（supervisor playbook）"]
    slot["conversation.session.<br/>header.utilities 槽"]

    host -->|"ctx.provide / inject"| index
    host -->|"dsh.client bundle 路由"| client
    ops -->|"全部经 DI 注入"| sc
    ops --> agents
    ops -.->|"task_confirm 弹窗"| uq
    skills -.->|"fire-and-forget"| skill
    client -.->|"占槽 · 复制 ID"| slot

    classDef host fill:#1E293B,stroke:#64748B,color:#F8FAFC,stroke-width:2px;
    classDef wiring fill:#0F172A,stroke:#38BDF8,color:#F8FAFC,stroke-width:2px;
    classDef core fill:#064E3B,stroke:#34D399,color:#ECFDF5,stroke-width:3px;
    classDef target fill:#1E293B,stroke:#F59E0B,color:#F8FAFC,stroke-width:3px;

    class host host;
    class index,tools,commands,skills,client wiring;
    class ops,config,safety,title,registry core;
    class sc,agents,uq,skill,slot target;
```

> 图注：`registry.mjs` 是唯一碰磁盘的逻辑模块（`node:fs`），职责边界是「近似原子写 + 损坏容错」，通过 DI 注入 `ops`，测试可用假路径隔离。

分层约束（与 [unity-pipe](https://github.com/Kayungko/unity-pipe) 的移植边界思路一致，这里用 DI 达成）：

- **纯模块**（`config.mjs` / `safety.mjs` / `title.mjs`）：零宿主 import，全部单测覆盖——59 个单元测试的主体；
- **`registry.mjs`**：持久 spawn 注册表（团队工作流的跨重启记忆）。读写永不抛错：损坏/缺失降级为空注册表，损坏文件保留为 `*.corrupt-<ts>`；写入近似原子（临时文件 + 重命名）；容量上限裁剪（`registryMaxEntries`）；0.5.0 起每条记录还带 `depth` 与 `parentSessionId`（递归治理的依据）；
- **`ops.mjs`**：工厂函数 `createOps(deps)`，宿主对象（sessionController / agents / createUserMessage / limiter / registry / uuid / askUser）**全部经依赖注入**，离开宿主进程可完整测试；
- **`tools.mjs`**：连 `defineTool` 都经注入——模型面注册与宿主包解耦；
- **`commands.mjs`**：`/tasks` 斜杠命令（0.4.0）——仿官方 `dsh-command-goal` 的 `inject=['commands']` + `ctx.commands.register` 模式；宿主无命令注册表时降级为 warning，工具面不受影响；
- **`client.js`**：Web 客户端模块（0.8.0）——插件唯一运行在**浏览器侧**的产物。不经 cordis 入口装配，而是由宿主 `dsh-client-modules` 依 `dsh.client` 声明 + `exports["./client"]` 原样装载（`window.__ModuleLoader__` factory 格式），占 `conversation.session.header.utilities` 槽渲染「复制会话Id」按钮（面性胶囊：亮色黑底白字 / 暗色白底黑字，走 `--dsw-alias-label-primary(-foreground)` 主题 token，几何对齐「Session 日志」）；与宿主侧九个模块完全解耦，缺槽位只影响该按钮；
- **`index.mjs`**：唯一直接 import 宿主包（`dsh-tools` / `dsh-llm`）的装配层；`skills.mjs` 对 `dsh-skill-filesystem` 用**动态 import**；`ctx.get('userQuestions')` 在 `task_confirm` 调用时**惰性解析**（不硬注入，宿主缺该接缝时其余工具不受影响）。

## 机制设计（0.4.0–0.11.0 新增）

### 派发确认链（0.6.0）

`task_confirm` → 批准 → `task_spawn_batch` 携带 `confirmationId`，三段都是纯宿主侧：

1. **弹窗信道**：`ctx.get('userQuestions').ask()`——官方 `exit_plan_mode` 的同构路径（`intent.kind: 'plan-review'`），问题构造严格遵守收窄条件（单问题、≤2 选项、`detail` 非空、approve 标签与选项逐字一致），渲染出计划审批卡。**零客户端改动**；
2. **凭证生命周期**：批准时铸 `confirmationId`，存进程内 `Map`（`confirmationId → {callerSessionId, approvedAt}`）。**进程内、不落盘是有意的**——宿主重启后批准记录失效，总控重新确认一次，而不是拿过期批准派发；
3. **闸门位置**：`spawnBatch` 在校验之后、创建之前检查凭证（存在、属于调用方），成功后消耗；全部失败**不消耗**（同一方案不问第二遍）；
4. **错误映射**：`UserQuestionError.code` 逐一映射为本插件码表（`ASK_CANCELLED → confirm-cancelled` 等），agent 按码分支。

多选变体（0.10.0）：`task_confirm_select` 用**同一接缝的通用提问渲染**（无 `plan-review` 意图 → 宿主中性样式、无琥珀 warn）：`multiSelect` 单问题 + 选项即任务清单 + 原生自定义输入行；凭证携带**选中子集**，`spawnBatch` 对子集凭证强制批量标题 ⊆ 选中集（`confirmation-mismatch`）。通用 UI 无 markdown 主体，完整方案由总控先写在聊天里。

任务级复用凭证（0.11.0）：`reusable: true` 使凭证记录携带 `reusable` 标记，`spawnBatch` 成功后的消耗逻辑对其跳过——同一 `confirmationId` 覆盖长程任务的多个里程碑批量（"首次分析后确认一次"）；跨会话借用仍被拒、子集强制仍逐批生效。

### 结果回报约定（0.7.0）

`reportBack`（默认开）在 `spawnTask` 里实现：开场词 = 用户 prompt + 追加段（`汇报约定：…task_send…<派发方 sessionId>…`）。两条边界：**注册表摘录永远记用户原始 prompt**（摘录是给人看的意图，不是派生文本）；追加段内置失败兜底（发送失败 → 写进最终回复），不依赖子会话的工具可用性。

### 递归治理（0.5.0）

深度不是配置出来的，是**从注册表推导**的：子深度 = 调用方已记录深度 + 1，从未被派生的根会话算 0。闸门在 `spawnTask` 入口（`spawnBatch` 的每一项都过 `spawnTask`，天然同限）。超限拒绝时明确指引用 subagent——subagent 是宿主原生面，不占本插件的深度预算。

### 工作区归属（0.8.1）

宿主 `create` 对 `workspaceId` 与 `cwd` 是**互斥**语义，且只有 `workspaceId` 触发 `workspace.attachSession`。`spawnTask` 因此先解析调用方的工作区成员归属（调用方自身 + `parentSessionId` 祖先链 ≤8 跳，与工作区 `sessionIds` 求交），命中传 `workspaceId`（宿主以工作区路径为 cwd 并挂入），显式 `cwd` 优先、无归属降级为旧语义——子任务与总控在同一工作区侧栏可见。

### 客户端模块装载要点（0.8.0–0.8.2）

两段实测教训沉淀为硬契约：① `dsh.client` 声明 + `exports["./client"]` 之外，**还必须导出 `exports["./package.json"]`**——扫描器经 `createRequire(baseUrl).resolve('<包名>/package.json')` 定位清单，缺该导出会 `ERR_PACKAGE_PATH_NOT_EXPORTED` 且被静默排除（0.8.2 根因）；② bundle 必须是 `window.__ModuleLoader__.load({id, factory})` 注册、原样下发，`apply(ctx)` 在客户端纤维执行、`inject: ["slots"]` 声明依赖。完整五步链见 [PROTOCOL.md §15](PROTOCOL.md)。

### 部署卫生（0.8.4）

`install.ps1` 复制技能目录必须拷**内容**（`skills\*` → 目标）而非目录本身：PowerShell `Copy-Item` 在目标目录已存在时会把源目录拷进去，0.4.0–0.8.3 由此产生嵌套 `skills/skills/`、正式路径 SKILL.md 从未更新（总控一直加载旧版操作手册）。脚本现拷内容并清理历史嵌套残留。

### 总控触发可靠性（0.9.0）

实测失效模式：用户在 goal 会话里含糊授权（「可以随时使用 /task 插件」）→ 名称无法解析 + 授权非要求 → 模型单干。三层加固：**工具描述**带总控触发语境（`task_spawn`/`task_spawn_batch` 描述点名「拆分/并行/协调任意措辞」并指向技能）、**技能描述**带口语别名表（/task 插件、派发子任务会话…）、**手册与 README** 带指令模板（含 /goal objective 写法）。佐证：点名工具的 steer 指令使该 goal 会话立即派发 3 个子任务会话（同工作区）。确认卡同时把 `plan` 收紧为 `# ` 一级标题开头，与官方 `exit_plan_mode` 的 plan-review 校验同式——渲染器本就是宿主官方同款，视觉一致性内禀，此改对齐内容规范。

## 降级策略

技能是伴侣，不是契约——`mountCoordinatorSkills` 是 fire-and-forget：

1. `dsh-skill-filesystem` 动态 import 失败 → 降级为一条 warning，九个工具照常注册；
2. `ctx.plugin(...)` 挂载失败 → 同样只打 warning；
3. 宿主无 `ctx.commands`（旧版本）→ `/tasks` 注册降级为 warning，工具面不受影响；
4. 宿主无 `userQuestions` 接缝或无 UI 连接 → `task_confirm` 返回 `no-question-channel`，其余七个工具不受影响。

工具注册先行、命令与技能挂载在后（`index.mjs` 的装配顺序即优先级）。

技能挂载本身走**隔离 provider**（同 `@openviking/dsh-memory-plugin` 先例）：`providerName: 'task-coordinator'`（永不与 DSH 的 `filesystem` 冲突）、`includeDefaultRoots: false`（只见本插件的 `skills/` 目录）。效果：编辑热加载（目录 watcher）、不遮蔽项目/用户技能、随插件卸载一起消失。

## 安全模型（守卫分层）

| 层 | 守卫 | 拒绝条件 |
|---|---|---|
| 调用方 | `checkCaller` | 无 agent 上下文；子代理来源且未开 `allowSubagentUse` |
| 目标 | `checkTarget` | 自寻址（自己发给自己）；目标不存在；目标是子代理会话（栅栏隔离） |
| 流量 | `SendLimiter` | 同一目标发送间隔 < `minSendIntervalMs`；目标排队深度 ≥ `maxQueuePerTask` |
| 派生治理 | 深度/确认闸门 | 子深度 > `maxSpawnDepth`（`spawn-depth-exceeded`）；达阈值的批量缺有效 `confirmationId`（`confirmation-required`） |

调用方身份**每次工具调用都从 `exec.agent` 重新推导**（`tools.mjs` 的 `callerFrom`），不接受调用方自报身份。

拒绝与失败一律携带**机器可读 `code`**（`DENIAL_CODES` / `OP_CODES`，完整码表见 [PROTOCOL.md §6](PROTOCOL.md)）——agent 按码分支，与 unity-pipe 的"退出码即语义"同一设计动机。

## 相关文档

- [PROTOCOL.md](PROTOCOL.md) — 主机契约与投递语义实测参考（sessionController 签名、queue/steer 边界、限流判据）
- [../skills/task-coordination/SKILL.md](../skills/task-coordination/SKILL.md) — supervisor 操作手册（随插件分发，模型实际读的就是它）
- [CHANGELOG](../CHANGELOG.md) — 版本更新日志
