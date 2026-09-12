<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/banner-dark.svg">
  <img src="./assets/banner-light.svg" alt="task-coordinator" width="600">
</picture>

**Codex 风格的跨任务协调 · DeepSeek Harness 的总控插件**

[![DSH 0.1.2-rc.1 实测](https://img.shields.io/badge/DSH-0.1.2--rc.1%20实测-16A34A?style=for-the-badge)](docs/PROTOCOL.md)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![105 个单元测试](https://img.shields.io/badge/tests-105%20unit-0EA5E9?style=for-the-badge)](test/smoke.test.mjs)
[![MIT](https://img.shields.io/badge/license-MIT-7C3AED?style=for-the-badge)](LICENSE)

[这是什么](#这是什么) · [界面一览](#界面一览) · [快速开始](#快速开始) · [十一个工具](#十一个工具) · [架构设计](docs/ARCHITECTURE.md) · [主机契约](docs/PROTOCOL.md) · [更新日志](CHANGELOG.md) · [English](README.md)

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

## 界面一览

<table>
  <tr>
    <td><img src="./assets/shot-1.png" alt="task-coordinator 实机界面（1/4）" width="420"></td>
    <td><img src="./assets/shot-2.png" alt="task-coordinator 实机界面（2/4）" width="420"></td>
  </tr>
  <tr>
    <td><img src="./assets/shot-3.png" alt="task-coordinator 实机界面（3/4）" width="420"></td>
    <td><img src="./assets/shot-4.png" alt="task-coordinator 实机界面（4/4）" width="420"></td>
  </tr>
</table>

<sub><i>实机 GUI 截图——同四张图经 <code>screenshots.json</code> 声明给 dsh-market 详情页画廊。</i></sub>

## 快速开始

### 前置条件

- DSH Desktop（主机契约按 0.1.2-alpha.1 验证）；
- Node.js `^22.19.0 || >=24`（宿主运行时通常已满足）；
- PowerShell（部署脚本是 `.ps1`）。

### 安装（一条命令）

> 🛒 **已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（Workflow & Automation 分类）**——装了应用内 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场的话，搜索 “task-coordinator” 一键安装/升级；下面的 git clone 路线是无市场时的等价安装方式。

```powershell
git clone https://github.com/Kayungko/dsh-plugin-task-coordinator.git
cd dsh-plugin-task-coordinator
pwsh install.ps1 -Source .
```

脚本做三件事：把插件复制进 profile 的 `node_modules/`（不跑 `pnpm install`、不碰 lockfile）、在 profile manifest 登记依赖与 bundle、登记 `.package-map.json`——**改前全部自动备份**到 `backups/<时间戳>/`。

装完**重启 DSH Desktop**即可，任何会话都能使用十一个工具和 `/tasks` 命令。

> 💡 `install.ps1` 的默认 `-Source` 是 `$PSScriptRoot/plugin`（工作区布局）；在插件仓库根目录直接运行要**显式传 `-Source .`**。
> 重复执行是安全的：文件覆盖幂等，manifest 登记自动去重。

### 验证

重启后，把这句发给任意会话：

`列一下当前可见的任务`

它调用 `task_list` 并返回任务列表（空列表也算正常回答），即工具已挂载 ✅

卸载：`pwsh install.ps1 -Source . -Uninstall`（同样重启后生效）。

## 怎么指挥总控（真正有效的提示词写法）

模型只有把你的话映射到工具时才会协调。「可以随时使用 /task 插件」这类含糊授权是可做可不做的裁量——会话倾向单干（实测踩过的坑）。两条规则：

1. **点名工具、用要求语气**。例：「用 `task_spawn_batch` 把剩余工作拆成并行子任务会话（附 team 名），用 `task_wait` 收集结果，不要全部自己做。」
2. **/goal 模式下，总控要求必须写进 goal 的 objective**——每个续轮只以它为准。推荐写法：

> 作为总控会话接手接下来的开发：① 可拆分的工作必须用 task_spawn_batch 派发给子任务会话并行执行（附 team 名），不要全部自己做；② 用 task_wait 收集结果并汇总；③ 子任务会话内可再用 subagent 并行；④ 完成里程碑或关键节点及时推送远端 main。

「/task 插件」「协调一下」这类模糊说法也能识别——0.9.0 起技能描述带别名表、工具描述带触发语境——但上面的模板才是可靠写法，goal 的 objective 尤其要用它。

## 十一个工具

| 工具 | 用途 |
|---|---|
| `task_list` | 列出协调可见的任务（含稳定 sessionId、状态、标题、todo/goal 进度）；可按 `team` 过滤；`ungrouped: true`（0.19.0）只列不属于任何工作区的会话——未分组桶的补救视图，配合 `task_workspace` 与注册表 `expectedWorkspace` 归置 |
| `task_progress` | 深入读取单个任务：实时/冷状态、排队消息、对话尾部、todos、goal |
| `task_send` | 投递可见的后续提示词（`mode: queue` 或 `steer`；`reference` 关联先前指令），返回 `messageId` + `queueDepth` 回执 `{nextTurn, nextStep}`（投递后口径；next-turn 每轮恰消费 1 条，深度 N ≈ N 轮后才被读） |
| `task_spawn` | 创建 + 命名 + 启动新任务（标题遵循 `MMDD｜类型｜主题`；可用 `team` 编组），返回 `correlationId`；默认附带回报约定；可选 `externalRef`（0.25.0）携带外部派发方的自由文本对应标识（如经任务桥派发的 Codex 对话——trim 后 ≤200 字符，registry 持久存储，回执/`task_list` 行/`task_progress` 透出，只存储回显不解析）；**工作区落位兜底链**（0.19.0）：精确匹配挂载（0.12.0）→ 子目录挂最近祖先工作区并归一到工作区根（默认 `ancestor` 档，回执+kickoff 双明示）→ git worktree 刻意保隔离落未分组（强警告）→ 未分组必附警告与补救提示；回执必带 `workspace`（{id,title} 或 null）与 `placement` 枚举；可选 `provider`+`model`（+`reasoningEffort`）指定子会话模型路线，开场前安装（0.13.0）；省略时回退插件默认路线（设置 → 任务编排，0.18.0），再回退宿主默认 |
| `task_confirm` | 把拆分/派发方案做成**交互式审批卡**弹给用户，阻塞直到回答；批准返回单次 `confirmationId` |
| `task_confirm_select` | 把任务清单做成**多选卡**（宿主中性提问 UI，非琥珀审批卡）：用户勾选要派发哪些（部分派发），可在自定义输入行写调整意见；批准把 `confirmationId` 绑定到选中子集，`task_spawn_batch` 强制校验（夹带未勾选标题报 `confirmation-mismatch`） |
| `task_spawn_batch` | 一次批量创建整个拆分方案（`tasks: [{title?, prompt}]` + 统一 `team`）；达到确认阈值时必须携带 `confirmationId`；单条失败不中止整批 |
| `task_wait` | 阻塞直到目标任务空闲（或超时）；支持多目标（`sessionIds` + `mode: all/any`）；冷目标（无 live agent）立即返回空闲——冷 ≠ 无待办 |
| `task_cancel` | 取消目标的活动轮次（保留其排队消息；被停目标需下一条消息才被唤醒——取消不自动清队列） |
| `task_workspace` | 列出宿主工作区，把**既有**会话挂入/移出工作区（归置落入「未分组」的会话），或 `migrate` **跨工作区真迁移**（0.16.0）：克隆完整历史到以目标路径为 cwd 出生的新会话、挂载克隆、工作区级归档原会话（展示层折叠：旧会话仍可读可续，对旧 id 发消息会分叉）、返回新 id；运行中的会话拒迁（先 `task_wait`）。直连宿主 workspace 实体，不触碰会话内容 |
| `task_models` | 列出**本部署实际接入**的模型路线——provider/model/reasoning-effort 精确 id（宿主活体目录，GUI 选择器同源）+ 应用级默认 + 插件默认路线 `pluginDefault`（0.18.0）；指定子会话模型前先查这里，永远不要猜 id（0.14.0） |

### `/tasks` —— 不进模型的快速通道

只读查询可以完全绕开模型：`/tasks`（全部任务）、`/tasks team <名称>`（单个工作流编组）、`/tasks <sessionId>`（单任务进度，短 ID 前缀唯一时可解析）。命令在宿主直接执行——零 token、立即出结果。一切**动作类**操作（发消息/派发/等待/取消）仍走工具。

### 复制会话 ID —— 会话头部一键完成

插件随包一个 **Web 客户端模块**（`client.js`，由 `package.json` 的 `dsh.client` 声明），占用三个官方槽位。①`conversation.session.header.utilities`——与自带的 `session-log-export` 同一条接缝：每个会话头部右侧出现「复制会话Id」按钮（面性胶囊，几何参数与「Session 日志」一致：亮色黑底白字、暗色白底黑字），一键复制当前会话的完整 `sessionId`，直接粘给总控侧的 `task_send`、`task_progress` 或 `/tasks <id>`。（侧栏会话行右键菜单为宿主硬编码，实测不可扩展，故选择有官方先例的头部槽位。）②`settings.section`（0.18.1）：设置左侧一级入口「任务编排」页（与 通用/模型/插件/Agent 预设 同级，order 25），可视化配置派发默认模型（见上一节）。③`conversation.view`（0.20.0）：会话页签「编排」——以当前会话为总控的活体拓扑总览（见下节）。

### 编排视图 —— 以当前会话为总控的活体拓扑（0.20.0 首发，0.22.0 卡片形态回归）

会话头部的第三个页签「**编排**」（排在原生 聊天/轨迹 之后，order 20）：把当前会话作为总控，实时渲染它派发的全部子任务——总控节点卡顶部居中，子会话卡片按 team 分组成行排在下方（无 team 归「未编组」行）；派发（实线下行）、指令（steer/queue 强调色下行、带模式标签）、汇报（虚线上行）三类**方向性连线**一目了然；**2 分钟内有活动的连线加流光动画，运行中的节点呼吸脉冲**；版心与聊天内容列同宽（0.22.3：绑定宿主 `--dsh-chat-content-width` 变量，与输入框左缘平齐、随拖宽手柄实时伸缩；窄舰队画布内容居中）。0.21.x 曾改为泳道时间轴形态，用户真机裁决后 0.22.0 回归卡片拓扑（方向感与驻留感更合监督心智），并保留泳道时代的全部改进。

- **节点卡**：标题、短 ID、模型、team 芯片、状态芯片（运行中/空闲/已完成）、todos n/m、goal 阶段、最近活动相对时间——实时状态与 `task_list` 同一条投影线（`useSessions` 活体联查），总控自身状态同源；
- **点击子节点直接跳转**该子会话（侧栏同款导航原语 `sessions.open`，降级复制 ID）；
- **长会话历史分页（0.21.1 起）**：转录是有限窗口，早期派发可能落在未加载的历史里——空态显示已扫描计数，`hasMore` 时出现「载入更早记录」按钮（`sessions.binding(id).session.loadOlder()`，better-display 同款），逐页回溯后自动重提取；
- **只读零写**：数据全部来自转录（`task_spawn` / `task_spawn_batch` / `task_send` 工具记录与子会话汇报消息）和会话列表投影，零宿主改动；窗口截断（`call: null`）、流式未完 JSON 等畸形记录一律静默跳过，绝不抛错；
- **空态即指引**：本会话没派发过子任务时显示引导卡；在子会话或普通会话里打开本页签同样显示空态（视图随会话重挂，始终以当前会话为总控）。

嵌套总控徽章（子会话的子树）与全局舰队视角规划在 B 阶段；「聚焦模式」（选中单会话的真时序视图）与活动流抽屉为调研留档候选。

### 工作区归属：五级兜底链与全链可观测（0.19.0）

派生的子任务默认挂进调用方所在工作区；显式/继承的 `cwd` 归属按五级链逐级判定（配置项 `workspacePolicy`，默认 `ancestor`）：

1. **词法精确匹配**——cwd 与某工作区路径精确一致（大小写/分隔符/尾分隔符/`.` 段归一，如 `D:\repo\.` 等价 `D:\repo`）→ 挂该工作区（0.12.0 行为 + `.` 段修复）；
2. **调用方继承**——调用方的工作区成员归属（含 spawn 祖先链）、`caller.cwd` 精确匹配（既有行为不变）；
3. **最近祖先升级**（默认档新增）——cwd 是某注册工作区路径的**真子目录** → 挂**最近祖先**工作区（嵌套工作区取最近）。宿主以工作区**根**派生会话 cwd，子目录隔离让位于分组：回执带 `placement: 'ancestor-normalized'` + `normalizedFrom`，kickoff 提示词自动追加一句（zh/en 跟随宿主语言）：工作目录已归一到工作区根、任务目标目录在哪、文件/git 操作用显式路径；
4. **git worktree 识别**——cwd 的 `.git` 是**文件**（linked-worktree 标记）且未命中前两级 → **刻意保持未分组**以保隔离（宿主挂载要求 cwd 与工作区路径全等，挂主仓必毁隔离），回执给强警告与补救路径（`task_workspace migrate`，代价同样是丢隔离）；
5. **未分组终点**——其余未命中：回执必带 `workspace: null` + `placement: 'ungrouped'` + 警告 + 补救提示（`task_workspace` attach/migrate、`task_list({ ungrouped: true })` 审计、`team` 编组仍可逻辑分组）。

**可观测性无条件全量**：每次 spawn 回执带 `workspace`（`{id,title}` 或 `null`）与 `placement` 枚举（`exact-match` / `caller-inherited` / `ancestor-normalized` / `ungrouped-worktree` / `ungrouped`）；`task_spawn_batch` 逐项 results 同样携带；注册表记录 `expectedWorkspace`（调用方期望归属路径）供事后补救；`task_list({ ungrouped: true })` 只列不属于任何工作区的会话（判定与 spawn 链共用同一真源函数，子目录 cwd 算未分组——正是待补救对象）。

> 迁移提示：0.18 及以前"显式子目录 cwd 落未分组"的行为，在默认档下变为挂最近祖先工作区；需要旧行为时在 cordis.yml 配 `workspacePolicy: 'exact'`（仅精确匹配的保守回退档）。`grouping` 为保留档位，当前传入会被拒绝。

### 既有会话归置与跨工作区迁移（0.12.0 / 0.16.0）

历史上已落入未分组的会话用 `task_workspace` 迁移：`list` 列出宿主工作区，再按 id 或精确路径 `attach` / `detach`。它直连宿主 workspace 实体——与 `session.create` 内部同一套 `attachSession` API——会话存储的 cwd 会对照工作区路径校验，且**绝不向会话注入消息**。（GUI 没有这个入口：侧栏拖拽走 `insertSessionBefore`，只接受已在工作区内的会话重排序——实测验证。）

跨工作区真迁移（0.16.0）：`attach` 永远挪不动存储 cwd 与工作区路径不一致的会话——宿主校验会拒绝，且没有任何宿主 API 会改写既有会话的 cwd。`action: migrate` 做真正的搬家：读取完整且经重放校验的会话日志（`sessionQuery.readSession`，不激活源会话），以目标工作区路径为 cwd 种子创建一个**新**会话（`sessions.create` + `flush`——宿主自家 `fork()` 内部同款原语；`fork()` 本身刻意保留源 cwd/工作区，不能改道），挂载克隆、工作区级归档原会话（`workspaceRegistry.archiveSession`——归档是展示层折叠：旧会话本体仍可读可续），并把插件注册表记录（team/深度/父链/标题）平移到新 id——编组过滤与递归治理存活迁移。任务在返回的 `sessionId` 下继续：对新 id 发消息，别再碰旧 id——归档不封存本体，对旧 id 发消息会把工作分叉成两条各自演化的副本。运行中的源会话拒迁（`migrate-busy`——克隆只带得走已持久化日志，先用 `task_wait` 收口）；源 cwd 已等于目标路径时拒绝并提示改用 `attach`；任何部分失败都会明确报告是否产生了孤儿克隆、原会话是否**未**被归档。**守卫注记（0.25.1）**：宿主 core ≥0.1.5（含 0.1.5-rc.x 预发布）期间 `migrate` 守卫停用——上游 `sessions.flush` 对插件直建会话静默不落盘（克隆假成功、重启即失，P0）+ `readSession` 对 seeded/forked 会话必抛（上游回归，rc.2 未修，P1）；`ops.mjs` 拒迁报 `migrate-disabled`（两条原因 + 替代 attach/detach + 正修指向 v0.26 接 `sessionPersistence.create(header)` 写句柄 seam 或等宿主修复），探测失败 fail-open 保持旧行为。0.1.2 系克隆+归档五步链零改动——详见 `research/host-upgrade-drift-0.1.2-0.1.5.md` 面 1。

### 子会话模型指定（0.13.0）与路线发现（0.14.0）

`task_spawn` 与 `task_spawn_batch` 的每个条目接受可选 `provider` + `model`（+ `reasoningEffort`）组合。路线先经宿主 LLM 目录在创建会话**之前**预校验（无效组合 `model-unavailable` 直接拒绝，零孤儿），再于**创建之后、开场之前**通过宿主 `sessionController.selectModel` 安装——子会话第一轮就跑在指定模型上；选择以持久会话事件写入，重启存活。预校验通过但安装失败时报 `model-select-failed` 并附可追踪的孤儿 sessionId，**绝不用错误模型开场**。宿主语义如实披露：安装会话级模型会**同时更新应用级默认模型**（GUI 模型选择器「最近选择即默认」的同一行为——`selectModel` 是宿主唯一公开入口），混合模型批量中最后一个子会话的路线会成为应用默认。

市场现实：**每个用户接入的 provider/model 都不一样**，所以 id 从不写死、也不该靠猜——`task_models` 把宿主**活体模型目录**（GUI 模型选择器渲染的同一数据源）投影为 `task_spawn` 可直接使用的精确 id：provider 分组、model id、逐模型的 reasoning effort、应用级默认选择；目录列举失败的 provider 单点隔离上报（`failedProviders`）。`model-unavailable` 的拒绝错误同样自带可行动提示：列出该 provider 实际提供的模型（provider 本身不认识时列出全部可路由 provider）。宿主版本没有 `modelCatalog()` 时 `task_models` 降级为 `catalog-unavailable`，错误提示仍是兜底。

### 派发默认模型：设置界面可视化配置（0.18.0）

省略 `provider`+`model` 的派发不再只能落到宿主默认——**设置 → 任务编排**（设置页左侧一级入口，与 通用/模型/插件/Agent 预设 同级）可视化配置一条默认路线，解析链变为：**工具显式指定 > 插件默认 > 宿主默认**。

- **三级下拉**（Provider → 模型 → 推理力度），候选来自宿主活体模型目录（与 GUI 模型选择器、`task_models` 同一数据源）——自建网关路线（如 mana 接入的 provider）自动出现在列表里，零额外配置；已保存但目录中下线的路线显示为「（已下线）」仍可改选。
- **durable 存储**：值写入宿主设置服务的 `task-coordinator` 命名空间（`installSection` 契约，subagent-model-selection 同款），GUI 改动即时生效于下一次派发，无需重启。
- **同一条校验链**：默认路线与显式指定一样过目录预校验（无效路线 `model-unavailable` 零孤儿）；成对约束在写入边界即校验（半对拒绝）。存储层意外畸形时防御性降级为「未设置」，绝不破坏派发本身。
- **可观测**：spawn 成功载荷回显 `modelSource`（`explicit` / `plugin-default` / `host-default`）；`task_models` 结果带 `pluginDefault`，一次读取看到完整解析链。
- **降级**：宿主无设置服务 / 无模型目录时页签显示降级文案，工具行为回退 0.17（宿主默认），不崩溃。
- **队列深度上限（0.23.0）**：同页第四字段 `maxQueuePerTask`（数字，0–50；0 = 跟随部署配置即默认 5）——`task_send` 对同一目标的排队上限，满了拒绝 `queue-full`。限流器经活取 getter 读上限，**GUI 改动免重启、下一次发送检查即生效**；手改 yaml 超过 50 的值在消费端钳制到 50。

### 界面文案跟随宿主语言（0.15.0）

用户可见文案跟随宿主语言偏好（设置 → 通用 → 语言；持久化 `locale.preference`，zh/en——官方 Session 日志按钮同一通道）。浏览器侧头部按钮向活体 client locale runtime 注册词典并实时翻译，切换语言立即重渲染；宿主侧界面（派发确认卡、汇报约定开场后缀、`/tasks` 元数据）经 `i18n.mjs` 每次调用实时解析——切换语言后下一张卡/下一次开场即生效，无需重启。偏好缺失或不可识别时保持历史中文文案（宿主侧感知不到「未设置=跟随浏览器」的委托语义），绝不猜测未内置的语言。模型面维持文档化协议不变：工具描述为英文模型契约、SKILL 手册为中文、标题遵循 `MMDD｜类型｜主题` 约定。

### 服务缝：面向桥接插件（0.24.0）

插件的 `taskCoordinator` 服务现在在 provide 载荷中携带**活的 ops 实例**（`{ config, version, ops }`——工具面在用的同一对象，限流 / spawn 注册表 / 确认凭证状态与 GUI 内总控天然共享、不分叉），且服务迁入**共享 label 的 isolate realm**（`'dsh-task-bridge'`）：未来声明同一字符串 label 的桥接插件经 `ctx.get('taskCoordinator')` 即可解析，其余插件依旧不可见。插件被配置禁用时服务仍存在但不含 `ops`——这是文档化的桥侧 503 降级信号。消费方约定：**ops 只读**——只调用成员，不包装、不替换。完整缝契约见 [docs/PROTOCOL.md §17](docs/PROTOCOL.md)。

## 派发确认（反信息黑盒闸门）

批量派发曾经是模型的静默决策——现在不是了：

1. 总控调用 `task_confirm({ plan })`，把完整拆分方案（markdown）做成**计划审批卡**——走宿主 `ctx.userQuestions` 接缝，与官方 `exit_plan_mode` 同构，**零客户端改动**；
2. 批准 → 返回绑定调用会话的单次 `confirmationId`；拒绝 → 用户意见随工具结果回传；关窗 → `confirm-cancelled`（总控停手等待）；
3. 达到 `confirmBatchThreshold`（默认 2）的 `task_spawn_batch` **没有有效 `confirmationId` 直接拒绝**（`confirmation-required`）。凭证单次使用、成功派发后消耗；全部失败不消耗——同一方案不会问用户两遍。

**多选变体（0.10.0）**：任务之间可独立取舍时，用 `task_confirm_select({ tasks: [{title, scope}] })`——任务清单渲染进宿主**中性**提问 UI（多选 + 自定义输入行，无琥珀审批卡样式），用户勾选要派发哪些。凭证携带选中子集，`task_spawn_batch` 拒绝任何用户未勾选的标题（`confirmation-mismatch`）。完整方案请先在聊天里给出——通用卡片承载任务清单，不承载计划全文。

**任务级复用凭证（0.11.0）**：长程自主任务（如 goal 模式）**只确认一次**——`task_confirm({ plan, reusable: true })` 铸出的凭证不随批量成功而消耗，同一使命后续的每个批量都凭同一个 `confirmationId` 过闸，不再逐里程碑弹卡。默认仍是单次凭证；复用凭证同样绑定调用会话、进程内存放（宿主重启失效）；`task_confirm_select` 也支持 `reusable`（子集强制对每次复用依然生效）。

降级：无 UI 连接时返回 `no-question-channel`，内置技能指引总控改用聊天文字确认；子代理调用方收到 `delegated-caller`（子代理不能发起人工确认）。

## 结果回报

派发的任务**默认带回报约定**（`reportBack`）：开场提示词尾部自动追加一条指令——任务完成（或确认无法完成）后用 `task_send` 把结果摘要（结论、产出路径、遗留问题）推回派发方会话；发送失败时把摘要写进最终回复兜底。总控因此得到**推送 + `task_wait` 拉取兜底**，不用轮询。确实不需要汇报的一次性任务传 `reportBack: false`。0.17.0 起约定新增两句：**发送后即结束回合**（你的回复会在子任务空闲时自动开新轮送达）；多阶段任务在需评审的阶段**发阶段报告并让位等指示**——配套内置技能的「阶段评审门」模式，**收到阶段报告必须回应**，让位中的子任务不回应就一直挂起。

## 递归治理

被派生的总控可以继续派生——上限 `maxSpawnDepth`（默认 2 代）。持久注册表记录每个任务的 `depth` 与 `parentSessionId`；超限以 `spawn-depth-exceeded` 拒绝，并指引改用 **subagent** 做更深层并行（subagent 不占深度预算）。

## 投递语义（最关键的一节）

| 目标状态 | `task_send` 行为 |
|---|---|
| **空闲** | 立即启动目标的新一轮执行 |
| **运行中** + `queue`（默认） | 消息排队，**下一个轮次边界**消费 |
| **运行中** + `steer` | 消息排队，**下一个步骤边界**消费（更快的中途纠偏） |

队列消化机制（宿主源码实测）：next-turn 队列 FIFO，**每轮恰好消费 1 条**（新轮首步同批顺带吸收全部 next-step 积压）——排队深度 N ≈ 本条 N 轮后才被读。`task_send` 回执携带 `queueDepth {nextTurn, nextStep}`（投递后口径，含本条）。`steer` 在目标健康运行中跳过整个 next-turn 队列，代价是延长当前回合（多条 steer 同批合并）；目标空闲或 abort 收尾期降级为排队。`task_wait` 对冷目标（无 live agent）立即返回——冷 ≠ 无待办。

三级中断阶梯：

| 级 | 工具 | 何时生效 | 跳队 | 代价 |
|---|---|---|---|---|
| 1 | `task_send` queue | 空闲→立即开新轮；运行中→下一轮首步（FIFO，每轮 1 条） | 否 | 无 |
| 2 | `task_send` steer | 健康运行中→下一步边界；空闲/abort 收尾期→降级为排队 | 是（运行中）：先于整个 next-turn 队列 | 延长当前回合；多条同批合并 |
| 3 | `task_cancel` | 请求立即停止（运行中的工具调用先收尾）；排队消息保留 | 是（相对当前轮） | 在跑工作作废；被停目标需新消息唤醒 |

判据：**晚一步 = 白干一步 → 插队**——叫停/纠偏/冲突预警用 steer；放行确认/补充背景/非紧急交接用 queue。单个超长工具调用（如全量测试电池）内部没有步边界——steer 也进不去，只剩第 3 级。

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
- **类型** ∈ 功能 / 设计 / 修复 / 优化 / 发布 / 探索 / 文档 / 研究（`titleTypes`，完全可自定义——英文集开箱即用，任意集合按精确或大小写不敏感匹配）；英文别名（fix/bugfix、feature/feat、design、optimize/perf/refactor、release/publish、explore、doc(s)/documentation、research/investigate）不区分大小写、自动归一到中文规范集；拿不准时用兜底「探索」（`titleFallbackType`），不猜；
- **主题**截断到 16 字（`titleMaxTopicChars`），适合侧栏显示；没给 `title` 时从 kickoff prompt 第一行提取；标题与提示词都为空时兜底「新任务」（`titleFallbackTopic` 可配）；
- 过期的行首 `MMDD｜` 会按真实创建时间重新盖印，半角 `|` 与旧式 `[团队]` 前缀自动归一。

示例：`修复｜对账精度` → `0904｜修复｜对账精度`；`fix｜对账精度` 归一后得到同一标题。

## 内置技能：task-coordination

插件随包携带一个技能（`skills/task-coordination/SKILL.md`），教总控**何时、如何**编排十一个工具：投递语义、三级中断阶梯、拆分判据、确认语义、扇出/监督/交接模式、让位—唤醒（goal 模式事件循环）与阶段评审门编排模式、递归治理、命名规则、反模式。按需加载，不协调就不占上下文。

挂载走隔离 `dsh-skill-filesystem` provider（同 `@openviking/dsh-memory-plugin` 先例）：`providerName: 'task-coordinator'`、`includeDefaultRoots: false`、只见本插件的 `skills/` 目录。效果：编辑热加载、不遮蔽项目/用户技能、随插件卸载一起消失。provider 包不可用时降级为一条 warning，**十一个工具照常工作**。

## 配置（cordis.yml / patch）

```yaml
- id: task-coordinator-runtime
  name: 'dsh-plugin-task-coordinator'
  config:
    enabled: true
    allowSubagentUse: false
    includeSubagentsInList: false
    titleTypes: ['功能', '设计', '修复', '优化', '发布', '探索', '文档', '研究']  # 完全可自定义，英文集开箱即用
    titleFallbackType: '探索'
    titleFallbackTopic: '新任务'    # 标题与开场提示词全空白时的主题兜底
    titleMaxTopicChars: 16
    titleTimeZone: 'Asia/Shanghai'
    registryFile: ''              # 留空 = <DSH_HOME 或 ~/.dsh>/task-coordinator/registry.json
    registryMaxEntries: 500
    workspacePolicy: 'ancestor'   # spawn 工作区归属：exact 仅精确匹配（0.18 行为）| ancestor 子目录挂最近祖先（默认）；grouping 保留档、传入即拒绝
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
node --test test/smoke.test.mjs         # 105 个单元测试（mock 宿主）
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
├── i18n.mjs            界面文案字典（zh/en · 跟随宿主语言偏好）
├── ops.mjs             会话操作 · DI 工厂
├── tools.mjs           十一个 task_* 工具注册
├── commands.mjs        /tasks 斜杠命令（直接执行，不进模型）
├── client.js           Web 客户端模块：复制会话 ID 头部按钮 + 任务编排设置页 + 编排视图页签（dsh.client）
├── skills.mjs          隔离技能挂载（动态 import，fire-and-forget）
├── skills/task-coordination/   supervisor 操作手册（随包分发）
├── cordis.patch.yml    隔离插件组挂载描述
├── install.ps1         部署脚本（复制式安装 + 自动备份）
├── verify-installed.mjs 安装态集成验证
├── test/smoke.test.mjs 105 个单元测试
└── docs/               ARCHITECTURE.md · PROTOCOL.md
```

## 文档

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 架构设计：为什么是插件、模块分层图、安全守卫分层、降级策略
- **[docs/PROTOCOL.md](docs/PROTOCOL.md)** — 主机契约与投递语义实测参考（注入面、门面签名、限流判据、验证记录）
- **[CHANGELOG.md](CHANGELOG.md)** — 版本更新日志
- **[skills/task-coordination/SKILL.md](skills/task-coordination/SKILL.md)** — 模型实际读取的总控操作手册

## 许可

本插件代码 [MIT](LICENSE)。运行时依赖的 `@deepseek-ai/*` 宿主包归 DeepSeek Harness 官方所有与许可，不在本仓库许可范围内。
