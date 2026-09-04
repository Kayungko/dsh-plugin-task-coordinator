<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
  <img src="./assets/banner-light.svg" alt="task-coordinator" width="600">
</picture>

**Codex 风格的跨任务协调 · DeepSeek Harness 的总控插件**

[![DSH 0.1.2-alpha.1 实测](https://img.shields.io/badge/DSH-0.1.2--alpha.1%20实测-16A34A?style=for-the-badge)](docs/PROTOCOL.md)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![59 个单元测试](https://img.shields.io/badge/tests-59%20unit-0EA5E9?style=for-the-badge)](test/smoke.test.mjs)
[![MIT](https://img.shields.io/badge/license-MIT-7C3AED?style=for-the-badge)](LICENSE)

[这是什么](#这是什么) · [快速开始](#快速开始) · [八个工具](#八个工具) · [架构设计](docs/ARCHITECTURE.md) · [主机契约](docs/PROTOCOL.md) · [更新日志](CHANGELOG.md) · [English](README.md)

</div>

---

## 这是什么

**装完之后，你只要在一个会话里用大白话说要并行干什么——中间所有调度都是 `task_*` 工具的事：**

```text
把这件事拆成三个任务并行做：A 研究方案，B 写原型，C 跑测试，做完汇总给我。
```

背后发生的事：你（说人话）→ 总控会话 → 拆分分析 → **弹窗确认拆分方案（你点批准）** → 批量创建任务会话 → 各任务完成后主动回报结果 → 总控汇总。中间不需要你盯任何一步，但决策点留在你手上。

- 这是一个 DSH 插件：它让**任意顶层会话**都能发现任务、读进度、建任务、发指令；
- 新建的任务**立即出现在 GUI 会话列表**（走的是侧栏消费的同一个 `api-session/added` 事件）；
- 每条跨任务指令都带 `coordinator` 来源标记，在目标会话的 transcript 里可见、可追溯；
- 前提只有一条：**DSH Desktop 已经装好并能启动**（插件不会替你启动宿主）。

> 📌 主机契约已在 **DSH 0.1.2-alpha.1** 实测；全部能力通过重启后的真实宿主端到端验证（判据见 [主机契约](docs/PROTOCOL.md)）。

## 快速开始

### 前置条件

- DSH Desktop（主机契约按 0.1.2-alpha.1 验证）；
- Node.js `^22.19.0 || >=24`（宿主运行时通常已满足）；
- PowerShell（部署脚本是 `.ps1`）。

### 安装（一条命令）

```powershell
git clone https://github.com/Kayungko/dsh-plugin-task-coordinator.git
cd dsh-plugin-task-coordinator
pwsh install.ps1 -Source .
```

脚本做三件事：把插件复制进 profile 的 `node_modules/`（不跑 `pnpm install`、不碰 lockfile）、在 profile manifest 登记依赖与 bundle、登记 `.package-map.json`——**改前全部自动备份**到 `backups/<时间戳>/`。

装完**重启 DSH Desktop**即可，任何会话都能使用八个工具和 `/tasks` 命令。

> 💡 `install.ps1` 的默认 `-Source` 是 `$PSScriptRoot/plugin`（工作区布局）；在插件仓库根目录直接运行要**显式传 `-Source .`**。
> 重复执行是安全的：文件覆盖幂等，manifest 登记自动去重。

### 验证

重启后，把这句发给任意会话：

`列一下当前可见的任务`

它调用 `task_list` 并返回任务列表（空列表也算正常回答），即工具已挂载 ✅

卸载：`pwsh install.ps1 -Source . -Uninstall`（同样重启后生效）。

## 八个工具

| 工具 | 用途 |
|---|---|
| `task_list` | 列出协调可见的任务（含稳定 sessionId、状态、标题、todo/goal 进度；可按 `team` 过滤） |
| `task_progress` | 深入读取单个任务：实时/冷状态、排队消息、对话尾部、todos、goal |
| `task_send` | 投递可见的后续提示词（`mode: queue` 或 `steer`；`reference` 关联先前指令），返回 `messageId` |
| `task_spawn` | 创建 + 命名 + 启动新任务（标题遵循 `MMDD｜类型｜主题`；可用 `team` 编组），返回 `correlationId`；默认附带回报约定；新任务默认挂进调用方所在工作区（显式传 `cwd` 则不挂工作区） |
| `task_confirm` | 把拆分/派发方案做成**交互式审批卡**弹给用户，阻塞直到回答；批准返回单次 `confirmationId` |
| `task_spawn_batch` | 一次批量创建整个拆分方案（`tasks: [{title?, prompt}]` + 统一 `team`）；达到确认阈值时必须携带 `confirmationId`；单条失败不中止整批 |
| `task_wait` | 阻塞直到目标任务空闲（或超时）；支持多目标（`sessionIds` + `mode: all/any`） |
| `task_cancel` | 取消目标的活动轮次（保留其排队消息） |

### `/tasks` —— 不进模型的快速通道

只读查询可以完全绕开模型：`/tasks`（全部任务）、`/tasks team <名称>`（单个工作流编组）、`/tasks <sessionId>`（单任务进度，短 ID 前缀唯一时可解析）。命令在宿主直接执行——零 token、立即出结果。一切**动作类**操作（发消息/派发/等待/取消）仍走工具。

### 复制会话 ID —— 会话头部一键完成

插件随包一个 **Web 客户端模块**（`client.js`，由 `package.json` 的 `dsh.client` 声明），占用官方 `conversation.session.header.utilities` 槽位——与自带的 `session-log-export` 同一条接缝。每个会话头部右侧会出现「复制 ID」按钮：一键复制当前会话的完整 `sessionId`，直接粘给总控侧的 `task_send`、`task_progress` 或 `/tasks <id>`。（侧栏会话行右键菜单为宿主硬编码，实测不可扩展，故选择有官方先例的头部槽位。）

## 派发确认（反信息黑盒闸门）

批量派发曾经是模型的静默决策——现在不是了：

1. 总控调用 `task_confirm({ plan })`，把完整拆分方案（markdown）做成**计划审批卡**——走宿主 `ctx.userQuestions` 接缝，与官方 `exit_plan_mode` 同构，**零客户端改动**；
2. 批准 → 返回绑定调用会话的单次 `confirmationId`；拒绝 → 用户意见随工具结果回传；关窗 → `confirm-cancelled`（总控停手等待）；
3. 达到 `confirmBatchThreshold`（默认 2）的 `task_spawn_batch` **没有有效 `confirmationId` 直接拒绝**（`confirmation-required`）。凭证单次使用、成功派发后消耗；全部失败不消耗——同一方案不会问用户两遍。

降级：无 UI 连接时返回 `no-question-channel`，内置技能指引总控改用聊天文字确认；子代理调用方收到 `delegated-caller`（子代理不能发起人工确认）。

## 结果回报

派发的任务**默认带回报约定**（`reportBack`）：开场提示词尾部自动追加一条指令——任务完成（或确认无法完成）后用 `task_send` 把结果摘要（结论、产出路径、遗留问题）推回派发方会话；发送失败时把摘要写进最终回复兜底。总控因此得到**推送 + `task_wait` 拉取兜底**，不用轮询。确实不需要汇报的一次性任务传 `reportBack: false`。

## 递归治理

被派生的总控可以继续派生——上限 `maxSpawnDepth`（默认 2 代）。持久注册表记录每个任务的 `depth` 与 `parentSessionId`；超限以 `spawn-depth-exceeded` 拒绝，并指引改用 **subagent** 做更深层并行（subagent 不占深度预算）。

## 投递语义（最关键的一节）

| 目标状态 | `task_send` 行为 |
|---|---|
| **空闲** | 立即启动目标的新一轮执行 |
| **运行中** + `queue`（默认） | 消息排队，**下一个轮次边界**消费 |
| **运行中** + `steer` | 消息排队，**下一个步骤边界**消费（更快的中途纠偏） |

结论：**不需要轮询**——投递后 `task_wait` 等空闲，再 `task_progress` 读结果。要立刻纠偏运行中的任务用 `steer`，发 `queue` 不会提前生效。

> ⚠️ **投递 ≠ 消费**：`delivered: true` 只表示消息进了收件箱。超时、异常或长时间无响应时，先用 `task_progress` 看队列和对话尾部**对账**，再决定补发还是继续等——绝不把不确定的投递当新消息盲发。

## 关联与追溯

- `task_send` 返回 `messageId`，`task_spawn` 返回 `correlationId`——记下需要被引用的那一条；
- 纠偏/续接先前指令时，给 `task_send` 传 `reference: <messageId 或 correlationId>`——引用以**可见注释行**随消息送达，目标任务明确知道"这是对哪条指令的修正"；
- 每条跨任务消息带 `coordinator` 来源标记，在目标会话 transcript 中可回溯到发起方。

## 团队工作流与持久注册表

- `task_spawn` / `task_spawn_batch` 传 `team: <工作流名>` 即可把任务编组，之后 `task_list({ team })` 随时找回整组；
- 编组记录在**持久 spawn 注册表**（默认 `<DSH_HOME 或 ~/.dsh>/task-coordinator/registry.json`），连同每次派生的标题、提示词摘录、`depth`、`parentSessionId`——**宿主重启后依然有效**（原生会话列表回答不了"哪些任务是我的、怎么分组"）；
- 注册表写入近似原子（临时文件 + 重命名）；记录上限 `registryMaxEntries`（默认 500，最旧先裁剪）；损坏文件不静默丢弃，保留为 `*.corrupt-<时间戳>` 供检查。

## 机器可读错误码

失败返回 `{ ok: false, code, error }`——agent 按 `code` 分支，不读文案。两类：守卫拒绝（`self-send-denied` / `subagent-caller-denied` / `subagent-target-denied` / `target-not-found` / `rate-limited` / `queue-full`…）与操作失败（`bad-request` / `target-busy` / `target-cold` / `spawn-create-failed` / `kickoff-rejected` / `spawn-depth-exceeded` / `confirmation-required` / `confirm-cancelled` / `no-question-channel` / `delegated-caller` / `batch-all-failed`…）。完整码表见 [主机契约 §6](docs/PROTOCOL.md#6-错误信封与码表)。

## 安全模型

- 自寻址（给自己发消息）**恒被拒绝**；
- 目标必须是顶层会话——子代理会话被栅栏隔离；
- 子代理调用方默认拒绝（`allowSubagentUse` 显式放行）；
- 达到阈值的批量派发**没有用户显式批准不可能执行**（见上）；
- 递归深度封顶（`maxSpawnDepth`），派生树不会无限生长；
- 同一目标限频（`minSendIntervalMs`）+ 排队深度限制（`maxQueuePerTask`），防失控刷屏；
- 调用方身份**每次工具调用都从执行上下文重新推导**，不接受自报。

## Spawn 命名规则（MMDD｜类型｜主题）

`task_spawn` 的标题分工明确——**模型只填 `类型｜主题`，日期由插件机械盖印**：

- **日期前缀**按会话**创建时间**（`titleTimeZone`，默认 Asia/Shanghai）盖印——永不用 `updatedAt`，永不让模型算；
- **类型** ∈ 功能 / 设计 / 修复 / 优化 / 发布 / 探索 / 文档 / 研究（`titleTypes`）；拿不准时用兜底「探索」（`titleFallbackType`），不猜；
- **主题**截断到 16 字（`titleMaxTopicChars`），适合侧栏显示；没给 `title` 时从 kickoff prompt 第一行提取；
- 过期的行首 `MMDD｜` 会按真实创建时间重新盖印，半角 `|` 与旧式 `[团队]` 前缀自动归一。

示例：`修复｜对账精度` → `0904｜修复｜对账精度`。

## 内置技能：task-coordination

插件随包携带一个技能（`skills/task-coordination/SKILL.md`），教总控**何时、如何**编排八个工具：投递语义、拆分判据、确认语义、扇出/监督/交接模式、递归治理、命名规则、反模式。按需加载，不协调就不占上下文。

挂载走隔离 `dsh-skill-filesystem` provider（同 `@openviking/dsh-memory-plugin` 先例）：`providerName: 'task-coordinator'`、`includeDefaultRoots: false`、只见本插件的 `skills/` 目录。效果：编辑热加载、不遮蔽项目/用户技能、随插件卸载一起消失。provider 包不可用时降级为一条 warning，**八个工具照常工作**。

## 配置（cordis.yml / patch）

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
    registryFile: ''              # 留空 = <DSH_HOME 或 ~/.dsh>/task-coordinator/registry.json
    registryMaxEntries: 500
    maxBatchSpawn: 6              # task_spawn_batch 单次上限
    maxSpawnDepth: 2              # 根会话以下允许的派生代数
    confirmBeforeBatch: true      # 派发确认闸门
    confirmBatchThreshold: 2      # 触发闸门的最小批量
    maxQueuePerTask: 5
    minSendIntervalMs: 2000
    waitDefaultTimeoutMs: 120000
    waitMaxTimeoutMs: 600000
    excerptChars: 400
    progressTailMessages: 6
```

配置解析**拒绝错误类型而不是猜测**：类型不对直接 `TypeError` 快速失败。全部配置项及语义见 [主机契约 §5](docs/PROTOCOL.md#5-限流与容量判据)。

---

## 给开发者

模块分层、DI 边界与降级策略见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。本节只留速查。

### 开发与测试

```powershell
node --check *.mjs                      # 语法检查
node --test test/smoke.test.mjs         # 59 个单元测试（mock 宿主）
# 安装进 profile 后（见快速开始）：
node verify-installed.mjs               # 安装态集成验证：真实宿主包 + mock ctx
```

### 目录

```
dsh-plugin-task-coordinator/
├── index.mjs           cordis 入口 · 装配（唯一直接 import 宿主包的层）
├── config.mjs          配置解析（纯模块）
├── safety.mjs          守卫 + 限流器 + 拒绝码（纯模块）
├── title.mjs           spawn 命名规则（纯模块）
├── registry.mjs        持久 spawn 注册表（近似原子写 · 损坏容错）
├── ops.mjs             会话操作 · DI 工厂
├── tools.mjs           八个 task_* 工具注册
├── commands.mjs        /tasks 斜杠命令（直接执行，不进模型）
├── client.js           Web 客户端模块：复制会话 ID 头部按钮（dsh.client）
├── skills.mjs          隔离技能挂载（动态 import，fire-and-forget）
├── skills/task-coordination/   supervisor 操作手册（随包分发）
├── cordis.patch.yml    隔离插件组挂载描述
├── install.ps1         部署脚本（复制式安装 + 自动备份）
├── verify-installed.mjs 安装态集成验证
├── test/smoke.test.mjs 59 个单元测试
└── docs/               ARCHITECTURE.md · PROTOCOL.md
```

## 文档

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 架构设计：为什么是插件、模块分层图、安全守卫分层、降级策略
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — 主机契约与投递语义实测参考（注入面、门面签名、限流判据、验证记录）
- **[CHANGELOG.md](CHANGELOG.md)** — 版本更新日志
- **[skills/task-coordination/SKILL.md](skills/task-coordination/SKILL.md)** — 模型实际读取的总控操作手册

## 许可

本插件代码 [MIT](LICENSE)。运行时依赖的 `@deepseek-ai/*` 宿主包归 DeepSeek Harness 官方所有与许可，不在本仓库许可范围内。
