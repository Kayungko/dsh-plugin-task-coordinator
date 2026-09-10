# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.24.1] - 2026-09-10

### Fixed

- **`task_progress.recent` 生产环境恒为空（自功能诞生起的潜伏缺陷，桥首航复盘抓出）**——live agent 路径读的是 `agent.session.events`，而真实宿主 Session 实体暴露的是 `seq + eventAt()/snapshotEvents(from, to)`（dsh-session lib L1331/L1342；宿主消费方 dsh-time-context L137-138 同款 seq 逆序+eventAt 走法实证），虚构属性 → `events ?? []` → recent 永远 []。verify/smoke 的 mock 携带同一虚构形状，缺陷从未被测试面暴露（**mock≠real，与 0.18.4 信封 bug 同类**）。修复：
  - 新增 `tailFromSession(session, limit)`：优先走**带界** `snapshotEvents(max(0, seq-400), seq)`（RECENT_SCAN_WINDOW=400——17 万事件级大会话绝不整表复制）；敌意/异常 snapshotEvents 降级空 recent，绝不破坏 progress 本体；legacy `.events` 数组回退保留（测试宿主用）；
  - cold 路径不变（`sessionController.inspect()` 确实返回 events 数组，宿主源码 L2680 实证）；
  - **mock 全面换真形状**：verify 的 worker mock 故意去掉 `.events` 只留 ranged snapshotEvents（recent 非空即钉死生产 API 路径）；smoke harness 补 snapshotEvents + 新增 0.24.1 回归钉扎块（ranged 语义/敌意降级/legacy 回退三态）。
- 影响面说明：该缺陷只影响 recent 展示字段；queue/todos/goal/agentState 等其余 progress 字段一直正确（不同数据源）。桥端 /v1/progress 透传同一 ops——修复后 Codex 拉模型的「读子任务反馈 / 拉总控回信」通道才真正可用（桥首航复盘的直接产出：探针会话与总控会话的 recent 实测均为空，双路径对照钉死根因在 ops 而非桥）。

### Tests

- smoke 110→111（新增 recent 真 API 回归块）；verify recent 断言改走真形状 mock（length=2 保持，但证明的是 snapshotEvents 路径）。仿真 + 真实安装位 ALL PASSED；活体探针（桥 /v1/progress 读到真实 recent 尾部）待重启后由总控执行。

## [0.24.0] - 2026-09-10

### Added

- **服务缝（service seam）**——把 ops 实例暴露给未来的桥接插件（`dsh-plugin-task-bridge` 的前置依赖），缝面恰为两处、对既有行为零变化（设计蓝图 `research/task-bridge-reanchoring.md` §1）：
  - **provide 载荷扩面**：`ctx.provide('taskCoordinator', { config, version, ops })`——字段名恰为 `ops`，值是现有 `createOps` 产物**同一实例**（tools 已在用，不另建，限流/注册表/确认凭证状态天然共享）。双形状载荷：`enabled` 路径在 `createOps` 之后 provide 全量；`disabled` 早退路径 provide `{ config, version }`（ops 缺席）——服务恒存在，桥侧按 ops 缺席降级 503，而非服务缺失导致桥永不激活；
  - **isolate 改共享 label**：`cordis.patch.yml` 的 `isolate: { taskCoordinator: true }` → `'dsh-task-bridge'`（cordis GlobalRealm 机制：字符串 label = 同 label 插件组共享同一 Symbol，`taskCoordinator@dsh-task-bridge`；布尔 true = entry-local 对外不可见）。可见性只扩大到「声明同 label 的插件组」，不扩大到全宿主——比删除 isolate 声明（回 root 全局）暴露面小。首次部署是冷加载不涉及迁移；已装环境升级会经历一次 loader 实现迁移（isolate.ts patch-context step 5，机制源码已验证，热切换实测未做，见调研 §6 未验证项 2）；
  - **消费方约定**（docs/PROTOCOL.md §17 新增节）：桥侧只读 ops、不得篡改/包装成员；同 label 声明 + `ctx.get('taskCoordinator')` 惰性解析（不硬 inject——coordinator disabled 时桥仍需挂载路由并回 503）；桥不得 provide 同名服务（cordis provide 撞名抛错）。

### Tests

- smoke +2 块（110 全绿）：provide 两分支源形状钉扎（disabled 分支 ops 缺席/enabled 分支含 ops/时序在 createOps 之后/恰好一次 provide + 一次 createOps/registerTools 收同一变量/版本与 package.json 锁步）+ createOps 13 成员面钉扎（pendingCount/listTasks/progress/sendMessage/spawnTask/confirmPlan/confirmSelect/consumeConfirmation/workspaceOp/models/spawnBatch/waitFor/cancelTask 全为 function）。verify-installed：enabled 载荷含 ops 且 13 成员可调 + 经 provide 载荷直调 listTasks 端到端走通（活实例而非序列化副本）+ disabled 载荷 ops 缺席断言。

## [0.23.0] - 2026-09-09

### Added

- **队列深度上限进 GUI 设置页**（设置 → 任务编排，第四字段 `maxQueuePerTask`）——用户问「排队 5/5 是上限么」后拍板可视化可调：
  - 数字输入框（0–50，0 = 跟随部署配置即 config 默认 5）；**硬上限 `MAX_QUEUE_PER_TASK_CAP = 50`**（队列每轮消化约 1 条，更深无编排意义只有刷屏风险）；
  - **免重启生效**：`SendLimiter.check()` 本就在检查时读 `config.maxQueuePerTask`（safety.mjs），index.mjs 把该属性换成活取 getter（`readQueueCap() ?? config`，与 readSpawnDefaults 同款 settings.get 活读）——GUI 保存后下一次 task_send 检查即用新上限；
  - 消费端钳制：`normalizeQueueCap`（settings.mjs 纯函数）整数 ≥1 → `min(value, 50)`，0/缺失/畸形 → null 跟随 config——手改 yaml 超限值也被诚实钳到 50；
  - 写边界维持 0.18.5 纪律：validate 钩子只做类型检查（number），范围执法在消费端钳制 + UI（input min/max + 越界禁 Save + 错误行）；
  - 保存仍为单次原子 `mutate`（现四操作）+ 写后回读核对（sameRoute 扩为四字段等值）；状态行追加「队列深度上限: N / 跟随部署配置」；provider/model 切换不再丢队列字段（草稿保留）；
  - schema `z.number().step(1).min(0).max(50).default(0)`（schemastery 3.18.x 无 .int() 的既定替代，web-search-mana 实测先例）。

### Tests

- smoke +3 块（108 全绿）：normalizeQueueCap 全规则（哨兵/畸形/钳制）、validate 队列字段类型边界（9999 过写边界、字符串拒）、SendLimiter 活 getter（运行中升降上限即时跟随）。verify-installed：settings mock 携 `maxQueuePerTask: 12`，**e2e 判别断言**——深度 7（>config 默认 5）放行证明设置覆盖生效、深度 12 拒绝 queue-full；客户端静态断言（四操作 mutate 含队列字段、QUEUE_CAP 常量镜像）。仿真 + 真实安装位 ALL PASSED。

## [0.22.3] - 2026-09-09

### Changed

- 编排视图宽度**绑定宿主聊天内容列变量**（用户澄清需求：跟随会话区左缘与输入框平齐的拖宽手柄）——`max-width: calc(var(--dsh-chat-content-width, 920px) + 32px)` + 16px 侧衬，内容区与聊天列同宽、外缘与输入框卡片平齐；拖动手柄时宿主在会话壳根上写 `--dsh-chat-user-width`（dsh-client-ui-conversation client.js L14350/14375 实证），派生变量经 CSS 继承直达本视图，**实时跟随、零 JS 监听**。未拖过手柄时走宿主默认 `clamp(680px, 列宽×0.64, 920px)`。0.22.2 的全宽方案被此取代（宽度语义从"铺满面板"改为"与对话列同宽"）。

## [0.22.2] - 2026-09-09

### Changed

- 编排视图宽度改为**全宽自适应**（用户反馈：会话区左缘拖拽调宽后视图应跟随）——去掉固定版心上限（1040→1400→自适应），`width:100%` 随会话面板伸缩；窄舰队时画布内容层 `margin:0 auto` 居中、宽舰队画布内横向滚动不变。页边距 24/32px 保留（0.20.0 的贴边缺陷不回潮）。

## [0.22.1] - 2026-09-09

### Changed

- 编排视图版心加宽：max-width 1040px → **1400px**、左右页边距 24px → 32px（用户真机反馈「背景区域太小」；大屏利用率提升，宽舰队的画布内横向滚动减少）。纯 CSS 一行，卡片/连线/交互零变化。

## [0.22.0] - 2026-09-09

### Changed

- **「编排」视图回归卡片拓扑形态（用户真机裁决）**——0.21.x 泳道时间轴试用与混合形态样张预览后，用户结论「还是卡片样式合理」：卡片+方向性箭头的信息密度与方向感优于抽象泳道。呈现层从 v0.20.0 完整恢复（总控节点卡顶部居中、子会话卡片按 team 分组行、spawn 实线下行/send 强调色下行带 mode 标签/report 虚线上行的 SVG 连线、RECENT_MS 流光、运行节点呼吸脉冲），并**前向移植泳道时代的全部改进**：
  - 版心修复保留：内容列 max-width 1040px 水平居中 + 24px 页边距（v0.20.0 画布靠左贴边的原始缺陷不回潮）；
  - 长会话历史分页保留（0.21.1）：`useSession` hasMore 席 + 「载入更早记录」按钮（工具栏+空态），`ctx.get("sessions").binding(id).session.loadOlder()` 分页，快照更新自动重提取；
  - 空态扫描计数保留：「已扫描当前转录窗口 N 条节点」+ 窗口截断提示；
  - 泳道纯函数退役（layoutLanes/laneEvents/coordinatorEvents/orchTimeWindow/orchClockLabel/ORCH_ZOOMS），layoutTopology/orchEdgePath/ORCH_LAYOUT 复位；`exports.__orchestration` 测试面随之还原。
- 0.21.x 的调研遗产留档不丢：三份可视化调研（业界盘点/时序可行性/状态流转模式）中的「聚焦模式」（选中单会话的真时序视图）与「活动流抽屉」列为后续候选；子会话历史运行区间不可得的约束下，卡片态芯片+连线流光仍是最诚实的表达。

### Tests

- `verify-installed.mjs` 编排段还原为卡片断言（节点/边/流光/行标签）+ 保留 0.21.1 增量（门控 sessions fake 带 binding、hasMore 席注入、历史按钮点击经门控 face 分页、空态扫描计数探针、`.binding(coordinatorId)` 静态断言）。仿真安装态 + 真实安装位 ALL INTEGRATION CHECKS PASSED；105 单测保持全绿（宿主面零改动，纯客户端变更——硬刷新即生效）。

## [0.21.1] - 2026-09-09

### Fixed

- **编排视图在长总控会话里显示空态（转录窗口截断）**——用户真机反馈：任何缩放档下都是「本会话未派发子任务」。根因即契约调研的「必须注意②」：chat store 只加载有限事件窗口，长会话（如 17 万事件的总控）的 task_spawn 记录落在**未加载的历史窗口外**，提取层在已加载窗口内零命中（节点形状经 records.d.ts 复核完全正确，非解析问题）。修复（better-display 同款手动分页模式）：
  - 空态卡新增**已扫描计数**（「已扫描当前转录窗口 N 条节点，未发现派发记录」）——窗口空/窗口有节点但无派发两种情况可区分；
  - `hasMore` 经标准席 `useSession` 读取（better-display Reader L190 同款），有未加载历史时：空态与工具栏出现**「载入更早记录」**按钮 + 窗口截断提示；
  - 分页走 `ctx.get("sessions").binding(sessionId).session.loadOlder()`（better-display index.tsx L33-38 的同一条 face，slots-only 声明下经 ctx.get 寻视）；加载态禁用按钮，store 更新后快照变化**自动重提取**，可连续点击逐页回溯；
  - 全链守卫：face 缺席/抛错/promise 拒绝一律落 flash 错误行，绝不抛渲染。

### Tests

- verify 门控段：sessions fake 增 `binding(id).session.loadOlder`，注入 `useSession` 席（hasMore:true）断言历史按钮出现且点击经门控 face 分页到位；空态新增「已扫描 N 条」断言（1 节点无派发窗口）；静态断言增 `.binding(coordinatorId)`。仿真安装态 + 真实安装位 ALL INTEGRATION CHECKS PASSED；105 单测保持全绿。

## [0.21.0] - 2026-09-09

### Changed

- **「编排」视图重设计（product-design 方向 2 · 流转泳道）**——用户反馈 0.20.0 拓扑画布靠左贴边且更想要"一屏看到各会话实时流转"；经 /product-design 三方向比选后按**活体泳道时间轴**重构呈现层（数据提取层原样保留）：
  - **版心修复**：内容列 max-width 1040px 水平居中 + 24px 页边距（0.20.0 画布全宽铺开、节点从左侧起排的贴边问题根治）；
  - **泳道结构**：总控泳道置顶贯通（自身活动流：派发/指令/收汇报/等待/取消），子会话每人一条泳道、按 team 分组（组头带 运行 n/m 汇总，未编组居末）；
  - **时间轴**：时间左→右流动，缩放窗口 30分钟/2小时/8小时/全部（fit-all 自动容纳最早事件），**跟随最新**开关（暂停=冻结窗口端点便于回看，恢复=吸附回 now）；轴刻度 HH:MM（末刻度随活体状态显示「现在」）+ 贯穿网格线；
  - **状态段**：每条泳道一段从首个事件延伸到窗口右缘的状态色段——运行中=accent 淡底+内描边+2s 脉冲、已完成=success 淡底、空闲=细中性线、离线=细弱线（R1 调研结论的诚实呈现：子会话历史运行区间不可得，色段表达**当前状态**而非历史区间）；
  - **事件点**：spawn/send/report/wait/cancel 按时间戳落点（spawn 灰、send accent、report 绿环空心、wait 浅灰、cancel danger），hover tooltip 显示 事件名·mode·时刻；RECENT_MS=2 分钟内的事件点 scale 脉冲（prefers-reduced-motion 尊重）；窗口外事件不渲染；
  - **泳道标签**：标题（单行截断）、短 ID、状态芯片、todos n/m、goal 阶段、相对时间（30s 节拍保鲜）；点击标签跳转子会话（`ctx.get('sessions')?.open`，降级复制 id 不变）；总控标签不可点；
  - 工具栏：标题 + 子会话计数 + wait/cancel 汇总 + 缩放按钮组（active 态）+ 跟随最新开关 + 刷新；图例行改点/段语义。
- 纯函数层：`layoutTopology`/`orchEdgePath`/`ORCH_LAYOUT`（节点坐标布局）移除，替换为 `layoutLanes`（team 分组泳道，确定性同前）、`laneEvents`（单泳道事件流，spawn 边缺失时以子记录时间兜底锚点）、`coordinatorEvents`（总控活动流）、`orchTimeWindow`（缩放/暂停/fit-all 窗口解析，最小跨度 60s 防退化）、`orchClockLabel`（locale 无关 HH:MM）；`exports.__orchestration` 测试面同步换血。

### Tests

- `verify-installed.mjs` 编排段按泳道重写（fixture 不变，仍全合成）：测试面新函数存在性 + `ORCH_ZOOMS` 形状；`layoutLanes` 确定性/码元序/未编组居末/组内 spawn 时间序；`laneEvents` 三事件排序与 mode 携带、窗口截断兜底锚点；`coordinatorEvents` 六事件折叠排序；`orchTimeWindow` 固定档/暂停冻结/fit-all 30s pad/无事件默认/最小跨度钳制；渲染探针改断言 泳道数与状态/状态段 3+配色/默认 30m 窗口仅 RECENT 汇报点双泳道渲染且带 ping/轴 5 刻度+「现在」/网格线 15/缩放按钮 4+active 唯一/跟随开关文案；门控探针改走泳道标签按钮（title 定位）跳转。仿真安装态 + 真实安装位均 ALL INTEGRATION CHECKS PASSED；105 单测保持全绿（宿主面零改动）。

## [0.20.0] - 2026-09-09

### Added

- **「编排」会话视图（conversation.view 槽第三个页签）**——以**当前会话为总控**的活体编排拓扑总览（设计蓝图：`research/orchestration-view-contracts.md` 四问契约调研 + `research/orchestration-view-transcript-perf.md` 性能实测）。纯客户端只读视图，**零宿主侧改动、零写操作**：
  - **注册**：`conversation.view` 槽占用者（id `orchestration`、order 20，排在原生 chat(0)/trajectory(10) 之后），字典复用 `task-coordinator` 命名空间（zh「编排」/ en "Orchestration"），语言切换实时跟随；
  - **数据提取（纯函数，经 `exports.__orchestration` 暴露测试面）**：从 `useChat` 快照节点提取 task_spawn / task_spawn_batch（子会话 sessionId/title/team/correlationId/depth/model，结果 JSON 权威、args 兜底，batch 失败项不建节点）、task_send（mode/目标/messageId/reference）、入站 relay 汇报（`context` 节点 + `source={kind:'coordinator',form:'relay',senderSessionId}` → 汇报上行边）、task_wait / task_cancel（状态注记）；容错：call=null 窗口截断结果、流式未完 JSON、非 JSON 结果文本、缺字段、store 抛错、无关工具、RUNNING 未落定调用——一律跳过不抛错；
  - **活体联接**：`useSessions` 按 sessionId 联查 running/completed/updatedAt/title/todos(n/m)/goal.phase（与宿主 task_list 同一条投影线），总控自身状态同源；
  - **布局（纯函数，确定性分层）**：总控节点顶部居中，子会话按 team 分组排下方行（team 码元序、未编组行居末、组内按 spawn 时间+sessionId），坐标纯计算无物理引擎，同输入必同输出；
  - **边语义**：spawn=实线下行、汇报=虚线上行、steer/queue=强调色下行（带 mode 标签）；RECENT_MS=120 秒内有活动的边加 CSS dash-flow 流光；运行中节点呼吸脉冲（prefers-reduced-motion 尊重）；
  - **节点卡**：title、shortId、model、team 芯片、状态芯片（运行中/空闲/已完成/离线）、todos n/m、goal 阶段、最近活动相对时间（30 秒节拍保鲜）；
  - **交互**：点击子节点 → `ctx.get('sessions')?.open(childId)`（侧栏同款权威导航原语；寻视或 open 失败降级为复制 sessionId + 状态行提示）；刷新按钮重读快照；
  - **空态/降级**：无 spawn 记录 → 引导卡「本会话未派发子任务」（子会话/普通会话同款——视图随会话重挂，始终以当前会话为总控）；useChat/useSessions 席缺席或抛错 → 诊断行；提取异常 → 诊断行 + 重试；渲染树整体 try/catch 自渲染错误（0.18.2 SlotErrorBoundary 纪律）；
  - **性能**：提取只跑在转录已加载窗口上（宿主推送已解析事件，每节点 µs 级；实测 176k 事件全量过滤仅 8.25ms），新事件经 chat store 增量到达自动重提取，无全史扫描、无文件读取。
- 嵌套总控徽章（子会话的子树）为 **B 阶段**，本版代码注释留位。

### Tests

- `verify-installed.mjs` 追加编排视图断言段（**全合成 fixture**，虚构会话 id/标题/内容，绝不引入真实转录）：①`exports.__orchestration` 测试面存在性；②提取正确性（spawn 字段权威序 / batch 含失败项不建子节点与 team 继承 / steer 模式与 messageId / relay 汇报边 / 畸形容错矩阵 + scanned 计数）；③布局确定性（两次调用 deepEqual、team 码元序 + 未编组居末、行内按 spawn 时间——并驱动布局纯函数改为组内自排序，直接喂未排序 children 也确定）；④门控 Proxy ctx 下 apply + 视图注册（id/order/label/locale）+ 子卡点击经 `ctx.get("sessions").open` 跳转；⑤渲染探针（活体套件不抛错 + 节点/边/流光/标签/todos 断言、空套件出空态卡 + 诊断行、抛错套件出诊断行不抛渲染）；⑥降级导航复制 sessionId；⑦静态断言（sessions 经 ctx.get、无 hostCtx.sessions 属性读）。fakeReact 的 useState 桩补齐惰性初始化器语义（真 React 行为）。repo 无 peer 依赖，以「临时目录仿真安装态」运行（junction 指向宿主 `@deepseek-ai` + 拷贝插件文件）：ALL INTEGRATION CHECKS PASSED；105 单测保持全绿。

## [0.19.0] - 2026-09-09

### Added

- **task_spawn 工作区归属兜底链 + 全链可观测性**（设计蓝图：`research/workspace-placement-fallback.md`，18 场景 harness 实证驱动；其推荐兜底链已定案实施）。spawn 的 cwd 归属从"仅精确匹配"升级为五级链，逐级降级：
  1. **词法精确匹配**：`normalizeWorkspacePath` 微修——新增剥 `.` 路径段（`D:\repo\.` == `D:\repo`，三平台分支各自处理、UNC 前缀与盘根保留），治愈词法/物理 canon 分叉（调研 EDGE S21：宿主 realpath 能解析而插件归一不能）；大小写/分隔符/尾分隔符折叠照旧；
  2. **调用方继承**（现状逻辑原样保留）：调用方工作区成员归属（含 spawn 祖先链 ≤8 跳）→ `caller.cwd` 精确匹配；
  3. **子目录最近祖先升级**（`workspacePolicy: 'ancestor'`，新默认档）：将要发送的 cwd 是某注册工作区路径的**真子目录** → 挂最近祖先工作区（最长归一前缀，嵌套工作区取最近）。宿主以工作区根派生会话 cwd——子目录隔离让位于分组（monorepo 子模块任务的治理成本权衡，蓝图 §4②）；**回执与 kickoff 双明示**：回执带 `placement: 'ancestor-normalized'` + `normalizedFrom` + note；kickoff 在 reportBack 后缀之前追加一句 i18n 机械提示（`i18n.mjs` 新键 `workspaceNormalizedSuffix`，zh/en，走宿主语言偏好），告知"工作目录已归一到工作区根 <path>、任务目标目录在哪、文件/git 操作用显式路径"；
  4. **git worktree 识别（只识别分类，绝不升级挂载）**：未命中链路的 cwd 经**注入的 fs 探针**（`index.mjs` 的 `probeWorktree`：`statSync(<cwd>/.git)` 为**文件**即 linked-worktree 标记；探针异常/缺失一律按"非 worktree"降级；**禁止子进程 git 调用**，gitdir 反查属未验证机制、留给保留档）判定为 worktree → 保隔离落未分组，回执给强警告（说明为何故意不挂：宿主 attach 校验 cwd 全等，挂主仓必毁隔离；补救代价 = migrate 克隆+归档）；回执 `placement: 'ungrouped-worktree'`；
  5. **未分组终点必附回执警告**：`workspace: null` + `placement: 'ungrouped'` + 警告 + 补救提示（`task_workspace` attach/migrate、`task_list({ ungrouped: true })` 审计、`team` 编组仍可逻辑分组）。
- **spawn/batch 回执可观测性（无条件全量）**：每次 spawn 成功载荷新增 `workspace`（`{id,title}` 或 `null`）与 `placement` 枚举（`exact-match` | `caller-inherited` | `ancestor-normalized` | `ungrouped-worktree` | `ungrouped`，`ops.mjs` 导出 `WORKSPACE_PLACEMENTS` 单一真源）；未分组附 `warning`（含补救 hint，`hint` 字段同步变化）；`task_spawn_batch` 逐项 results 同样携带 `workspace`/`placement`/`warning`——批量总控一次调用看到全部落位。
- **`task_list` 未分组过滤（新参数 `ungrouped: true`）**：只列不属于任何工作区的会话（GUI 未分组桶的补救视图）。判定与 spawn 链共用**单一真源纯函数** `matchWorkspacePaths`（`ops.mjs`）：会话 cwd 对注册工作区路径做词法**精确**匹配（与宿主 `sessionIds` getter 同口径）——子目录 cwd **算**未分组（正是待补救对象）、无 cwd 行保留；与 `filter`/`team`/`limit` 可组合。
- **注册表期望归属（`expectedWorkspace`）**：spawn 注册表白名单新增可选字段，spawn 时记录调用方期望归属路径（显式 cwd，缺省时调用方 cwd），供事后批量补救定位"期望挂 X 实际未挂"的会话；持久化落盘、损坏值加载时白名单过滤。
- 新配置项 **`workspacePolicy: 'exact' | 'ancestor'`**（默认 `'ancestor'`，`config.mjs` 导出 `WORKSPACE_POLICIES`）：`exact` 档保留 0.18 及以前的仅精确匹配行为（保守回退档）；**`grouping` 档明确不实现**——为保留档（未来"强制分组含 worktree 挂主仓 + git -C 提示改写"），当前传入按无效值拒绝（TypeError，沿用既有配置校验模式）。

### Changed

- **默认档位行为变化（迁移提示）**：默认 `ancestor` 下，显式 `cwd` 为某工作区**子目录**的 spawn（含继承的 `caller.cwd` 子目录）不再落"未分组"，而是挂最近祖先工作区、会话 cwd 归一为工作区根——需要 0.18 及以前的"保子目录 cwd 落未分组"行为时，在 cordis.yml 配 `workspacePolicy: 'exact'`；无工作区/无关路径/未分组终点的行为不变（只是多了警告与回执字段）。
- `task_spawn`/`task_spawn_batch`/`task_workspace`/`task_list` 工具描述同步兜底链、`cwd` 参数语义、回执新字段与未分组过滤。

### Tests

- 单元测试 95 → 105：新增 config 枚举（默认 ancestor、grouping 拒绝、非法值 TypeError）、`normalizeWorkspacePath` 剥 `.` 段三平台分支（含 UNC/盘根/裸点）、`matchWorkspacePaths` 纯函数（精确≠祖先、最近祖先、盘根祖先、兄弟前缀不误判、异常容忍）、**调研 §2 的 18 场景矩阵整表回归**（S01–S18+S21，逐场景断言 create 形状/workspaceId XOR cwd/placement/workspace 投影/警告/kickoff 后缀/expectedWorkspace；夹具去环境化，POSIX CI 可跑）、exact 档不升级、worktree 探针降级（抛错/缺失/目录 `.git` 均非 worktree）、归一后缀随 uiLocale（en 变体 + reportBack 关闭仍保留归一提示）、batch 逐项回执、`task_list` 未分组过滤（含空注册表/抛错降级/组合过滤）、`expectedWorkspace` 记录-持久化-白名单。
- `verify-installed.mjs`：mock `create` 对齐宿主 cwd 派生语义（`cwd = workspace?.path ?? request.cwd`）；新增 0.19.0 端到端断言——回执 placement/workspace 字段、祖先归一全链（workspaceId 请求 + 根 cwd 回执 + i18n kickoff 提示 + 注册表 expectedWorkspace）、未分组终点（警告 + 补救 hint + `task_list({ ungrouped })` 只捞回该会话）。repo 无 peer 依赖暂不可跑，待总控部署后于安装位置复跑。

## [0.18.5] - 2026-09-09

### Fixed

- **真机回归：设置保存后宿主重启即丢（用户报告"无法持久化"）**。取证：`~/.dsh/settings.yaml` 的 `task-coordinator:` 节只存活了 `reasoningEffort: ""`——provider/model 两次写入被自己的 validate 钩子拒掉。完整因果链（三环缺一不可）：①保存走三次**逐字段** `scope.set`，前两次合成出"半对"中间态（只有 provider 或只有 model）；②`validateSpawnModelsSection` 当时把半对判为非法直接抛错，宿主拒绝该次变更；③宿主设置 scope 的写通道**被拒时不 reject**——`recover()` 静默回读折叠最新好值、promise 正常 resolve（dsh-client-ui-settings `mutate`：`if (!response.ok) { await this.recover(generation); return; }`）——界面照常弹「已保存 ✓」，用户无从察觉。重启后 base+user 合成只剩 reasoningEffort → 显示未设置。
- 修复双管齐下：**①原子写**——保存改为单次 `scope.mutate([provider, model, reasoningEffort])`（公开 API，"one atomic namespace mutation"，单次 wire 调用、终态只校验一次，不再经过半对中间态；无 mutate 的老 scope 回退逐字段）；**②写边界校验放宽为纯类型检查**——半对不再在 validate 钩子拒绝（成对规则的诚实执法点：UI 的 Save 禁用 + 消费端 `normalizeSpawnRoute` 抛错→`readSpawnDefaults` 降级为未设置），任何写入路径（含未来逐字段写者）不再踩静默回滚陷阱。
- **诚实保存核对**：因写通道吞拒绝，保存后**回读快照与草稿比对**（`sameRoute(landed, draft)`）——一致才报「已保存 ✓」，否则显示「保存未生效：宿主拒绝了本次写入（已回读核对）」新文案（zh/en）。假成功从机制上不可能再发生。

### Tests

- 单测：validate 边界测试改写（半对通过写边界 + 注释记录因果链；畸形形状仍拒）；95 全绿。
- verify-installed：门控假 scope 增 `mutate`；新增两条源码静态断言（save 必须走 `scope.mutate` 原子写、必须含 `sameRoute(landed, draft)` 回读核对）。

## [0.18.4] - 2026-09-09

### Fixed

- **Provider 下拉无选项（0.18.3 用户报告）**：客户端 `remote.session.modelCatalog()` 的 wire 应答是**结果信封** `{ok, value: {groups, failures, default?}}`（原生 subagent-model-selection 卡片消费形状，settings-plugins client L1405 实证），而宿主侧 facade 返回裸目录——`projectCatalog` 按裸形状读 `payload.groups` 得 undefined，providers 投影为空数组且状态仍是 ready（无错误行，纯静默空下拉）。修复：应答统一防御性解包（`ok === false` 转为带原因的错误行；`"value" in response` 解包，否则按裸目录处理），两种形状都能投影。
- 至此 0.18.x 系列四个真机回归全部闭环：灰下拉（inject 门控）→ 空白面板（SlotErrorBoundary abdicate）→ `{message}` 裸占位符（插值单路径）→ 空下拉（信封形状）。每一发的教训都已固化为验证器探针或防崩溃构造。

### Tests

- verify-installed 门控假服务改为**信封形状**应答（与真实 wire 一致）+ 新增解包源码静态断言；95 单测保持全绿。

## [0.18.3] - 2026-09-09

### Fixed

- **`{message}` 占位符原样上屏（0.18.2 用户报告「模型目录不可用：{message}」）**：`t()` 的参数插值只作用于内置字典回退路径——宿主 locale 运行时命中时直接返回原始字典串。该盲区自 0.15.0 存在，但 0.18.1 修好 `ctx.get()` 寻视后宿主路径才**首次真正生效**，随即暴露。修复：两条解析路径统一走插值。
- **模型目录寻视改走点号服务名**：原生设置卡片注入的是 `remote.session` 点号服务（runner 的 fiber waitingFor 以 `ctx.get(name)` 解析点号名，证明该形状是官方寻视路径）；0.18.2 经 `ctx.get("remote").session` 走 facade 属性链，同步段抛错（facade `.session` 读取被拒/惰性 getter 抛错）正是 0.18.1 空白面板的头号嫌疑——当时未守卫的 effect 同步访问触发 SlotErrorBoundary abdicate。现在 `getCatalogFace()` 先试点号服务、再试 facade 链、全程守卫、成功即缓存；目录不可达时显示带真实原因的错误行 + 重试按钮（面板保持可用，设置读写不依赖目录）。

### Tests

- 95 单测保持全绿；verify-installed 门控渲染探针兼容两种寻视形状（点号服务缺席时走 facade 链命中）。

## [0.18.2] - 2026-09-09

### Fixed

- **真机回归：一级「任务编排」页右侧空白（0.18.1 用户报告）**。宿主渲染器对 slot 占用者有 `SlotErrorBoundary`：组件 render/effect 抛错会被边界捕获、`console.error` 后**abdicate 该条目**（`reportEntryError {abdicate: true}`，条目从 `entriesOfSlot` 投影中除名直至注册生命周期结束）——左侧导航行仍在（导航读全量台账），右侧面板永久空白，且错误只在浏览器控制台，宿主日志无镜像。0.18.2 把组件改为**防崩溃构造**：①服务同步寻视（设置服务是设置页自身的前置依赖，不存在晚到问题；删除 0.18.1 的 setTimeout 定时重试环——客户端 bundle 不该假设定时器环境）；②每个 effect 体独立 try/catch（effect 抛错同样进边界）；③派生计算+整棵渲染树包 try/catch，**崩溃时自渲染错误文本 + 重试按钮**——面板永不空白，故障原因不再依赖控制台取证；④存储值非对象防御（`stored` 仅在 value 为真对象时采纳）；⑤手动重试按钮覆盖服务未寻视/命名空间未注册/读取失败三种降级态。
- 静态排查已穷尽并逐一排除的候选（记录备查）：schema envelope 跨端序列化（无头实验：真实 ui-settings bundle + 本插件 schema → ready/writable/value 全通）、describe redaction（仅剥 `role('secret')` 字段）、`only` 过滤（按 options.id 匹配，契约文档确认）、remote.session 子命名空间门控（facade 无门控）、denyContext 拒绝（session 命名空间是普通方法对象非 cordis Context）、zustand subscribe 返回值（标准反注册函数，React effect 契约安全）、settings.section 注册形状（与官方契约 registerOptions 逐项吻合）。

### Tests

- verify-installed 门控回归块扩展：门控 Proxy 后放置**活体 settingsScope/remote 假服务**，断言设置页组件在“服务可达”状态下渲染不抛错（0.18.2 空白面板回归的正向探针）；95 单测保持全绿。

## [0.18.1] - 2026-09-09

### Fixed

- **真机回归：设置页下拉恒灰（0.18.0 发布当天用户报告）**。根因（源码级实锤）：`dsh-cordis-client-runner` 的 `dynamicCordisContext`（L319-342）把动态插件的 `ctx.serviceName` **直接属性访问**按 fiber 的 inject 声明门控——读本插件未声明的服务（settingsScope/remote/locale）直接抛错；官方旁路是 `ctx.get(name)`（requireDeclaration=false）。0.18.0 的懒寻视用属性访问 + try/catch 吞错 → 永远寻视不到 → `draft` 恒空 → 三个下拉恒灰。修复：三处可选服务读取全部改走 `ctx.get()`（属性访问仅保留为直连测试宿主的回退）。无头实验已先行证明链路其余部分全通（真实 ui-settings bundle + 本插件 schema envelope + describe 视图 → ready/writable/value 齐备）。
- **连带破案（0.16.1 隐藏缺陷）**：同门控下 `ctx.locale` 属性访问同样从未生效——**语言切换在真机上从未真正接入宿主 locale 运行时**（一直静默回退内置 zh 字典）；verify-installed 的 fake ctx 没有复刻 Proxy 门控，属验证盲区。本版一并修复。

### Changed

- **「任务编排」升级为设置页一级入口**（用户需求）：注册槽位从 `settings.plugins.tab`（插件页内页签）改为 `settings.section`（设置左侧导航一级页，与 通用/模型/插件/Agent 预设 同级；原生 order general=0/models=10/plugins=15/agent-presets=20，本插件=25）。
- 每个降级态渲染真实诊断文案（此前 0.18.0 缺 `degraded.*` 字典键会渲染裸键）：设置服务缺失 / 设置区未注册 / 目录失败 / 加载中，各有独立 zh/en 文案；设置页组件增加页面级标题。
- 工具描述/双 README/SKILL/PROTOCOL/ARCHITECTURE 同步位置表述（设置 → 任务编排）与 runner 门控接缝事实。

### 测试

- 单元 95 保持全绿；verify-installed 新增 **runner 门控回归测试**：以复刻 `dynamicCordisContext` 的 Proxy（未声明服务属性读抛错 + `get()` 应答）作为 apply() 与渲染的宿主 ctx，断言 apply 存活、双槽注册、locale 经 `ctx.get()` 完成注册（0.16.1 盲区补防）；另加三处 `ctx.get()` 源码静态断言防止回退为属性访问；安装态端到端 ALL PASSED。

## [0.18.0] - 2026-09-09

### Added

- **编排模型设置入口（GUI 可视化配置派发默认模型）**：设置 → 插件 → 「任务编排」新页签，可视化选择 `task_spawn` / `task_spawn_batch` 未显式指定 provider+model 时使用的默认模型路线。三级下拉（Provider → 模型 → 推理力度）候选来自**宿主活体模型目录**（`remote.session.modelCatalog()`，GUI 模型选择器同一数据源——自建网关如 mana 路线自动出现，无需任何额外配置）；已保存但目录下线的路线仍显示为「（已下线）」可改选（对齐原生 subagent-model-selection 卡的 stored/available 合并纪律）；状态行常显「当前默认」与「宿主默认」对照。
- **宿主侧 durable 设置区**：新 `settings.mjs`（纯模块）+ `ctx.inject(['settings'])` → `settings.installSection('task-coordinator', schema, base, hooks)`（subagent-model-selection 同款契约）：插件提供 base 层，用户层（设置文档/GUI 写入）叠加合成，`scope.get()` 解析。缺设置服务的宿主优雅降级（工具保持 0.17 行为）。写入边界经 `validateSpawnModelsSection` 校验（半对拒绝、非字符串拒绝）；空 = 跟随宿主默认。
- **派发解析链三级化**：显式工具参数 > 插件默认 > 宿主默认。`spawnTask` 在调用未带 provider+model 时回退到存储的默认路线（含 reasoningEffort；显式 effort 优先），回退路线走**同一两级校验链**（`llm.resolveCallConfig` 目录预校验零孤儿 → `selectModel` 安装）；批量逐项走同一条路天然覆盖。成功载荷新增 `modelSource`（`explicit` / `plugin-default` / `host-default`）如实披露路线来源。`task_models` 结果新增 `pluginDefault` 字段（未设置时省略），一次读取看到完整解析链。
- **懒服务纪律延续**：客户端 bundle 保持只 inject `["slots"]`，`settingsScope` / `remote` 按需防御性寻视（0.16.1 locale 同款：短重试 ~32s 封顶、降级文案而非崩溃）；settings 页签照抄 dsh-community-market 第三方注册先例（`settings.plugins.tab` slot）。

### Changed

- peer 依赖新增 `@deepseek-ai/schemastery >=3.18.0 <4`（宿主必有：cordis 生态 Config 基石，Desktop 2.0.5 实测 3.18.2）。
- `task_spawn` / `task_spawn_batch` 的 provider/model 参数描述与 `task_models` 描述同步三级解析链；`model-unavailable`/成对约束错误文案指向「configured default / host default」。
- 安装脚本 `install.ps1` 文件清单收录 `settings.mjs`；`verify-installed.mjs` 版本断言改为动态对齐 `package.json`（消除每次发版的手工硬编码）。

### 测试

- 单元 89 → 95：`normalizeSpawnRoute` 纯规则（空对/修剪/半对抛错）、`validateSpawnModelsSection` 写边界、fallback 链（默认安装+modelSource、显式优先、未设置走宿主默认零 selectModel、**畸形存储降级不破坏 spawn**——测试还抓住了 ops 层直接调用未包 try/catch 的真缺陷并修复）、默认路线同过预校验（零孤儿）、孤独 reasoningEffort 搭乘、批量继承、`pluginDefault` 投影（缺失/抛错降级）。
- 安装态端到端全绿：设置区安装日志 + 省略路线的 spawn 走存储默认（create→selectModel→prompt 时序保持）+ 客户端 bundle 双 slot 注册断言（页签 id/order/label、无服务时降级渲染不崩溃，document/navigator 桩）。

## [0.17.0] - 2026-09-07

### Added

- 标题类型双语归一（`title.mjs` 新增 `TYPE_ALIASES` + `resolveTitleType`）：fix/bugfix、feature/feat、design、optimize/optimise/perf/refactor、release/publish、explore/exploration、doc(s)/documentation、research/investigate 等英文别名在类型匹配前**不区分大小写**归一到中文规范集——英文环境的模型传 `fix｜topic` 不再被静默错标成兜底「探索」（此前 `types.includes` 精确匹配失败走裸主题分支，类型词还会泄进主题）。成员检查保持权威：自定义 `titleTypes` 时别名只在规范型被允许时才生效，绝不覆盖用户集合；未映射的词（如 `deploy`）仍是主题、不猜类型。`task_spawn`/`task_spawn_batch` 工具描述、双 README、SKILL 同步说明；别名回归织入三个既有标题测试块（含 `constructor` 原型键防御断言），测试总数保持 89。
- 英文部署全链路补全：① 新配置项 `titleFallbackTopic`（标题与开场提示词全空白时的主题兜底，默认「新任务」，英文部署可配 'New task'）；② 类型匹配第三级——自定义类型集内大小写不敏感精确匹配（英文集 `'Fix'` 直接匹配 `fix`/`FIX`，别名机制不再只服务默认中文集）；③ 英文 README 去中文化（Copy Session ID / `MMDD｜type｜topic` / 英文类型集示例与配置样例，默认中文集字面值改为指向中文 README + 英文顺序对照）；④ 删除 `ops.mjs` 两个零引用的硬编码中文确认卡常量（运行路径 0.15.0 起已走 `i18n.mjs`，全仓库 grep 证实无引用）；⑤ 双 README/SKILL/工具描述补自定义英文集与 `titleFallbackTopic` 说明。
- 市场截图声明：`screenshots.json`（awesome-dsh-plugin 官方契约，1–8 个仓库相对路径）+ 4 张实机 GUI 截图（`assets/shot-{1..4}.png`，用户确认无敏感内容，按拍摄时序排列）。dsh-market 详情页/官网插件页经 nightly build 自动抓取展示，列表侧无需 PR；清单按官方 CI 同款规则自检（JSON 数组、条数、路径不逃逸、文件存在）。`package.json files[]` 同步收录 `screenshots.json` 与 `assets/`（未来 npm publish 及 README banner SVG 一并随行）。
- **投递回执与排队可观测性（评审闭环停摆修复包）**：`task_send` 回执新增 `queueDepth {nextTurn, nextStep}`（投递后口径，含本条——nextTurn 深度 N 即本条 N 轮后才被读）+ 动态 hint 三分支：queue 落运行中目标且深度 ≥2 时提示"~N 轮后读（每轮恰消费 1 条），改变下一步考虑 steer"；steer 落运行中目标提示"步边界送达并延长当前回合（多条同批合并）"；基础 hint 保持"delivered != consumed"。`task_wait` 超时返回新增 hint——"考虑结束回合：空闲会话的排队消息自动逐条开新轮"（超时时刻恰是总控该想起让位的时刻）。`task_send`/`task_progress` 冷会话路径新增提示：冷 ≠ 无待办，`maxQueuePerTask` 深度守卫不覆盖冷目标（`pendingCount` 对冷目标恒 0——已知边界，PROTOCOL §13 登记，彻底修复列二期）。
- **投递语义四事实 + 三个编排模式成文**（全部宿主源码实测：`Inbox.claim` 每轮恰取 1 条 next-turn、next-step 步边界整批且跳队、`nextStep.length === 0` 才收尾、cancel `keepInbox: true` 终止后不自动消费、preStep 只在步间触发）：①next-turn FIFO 每轮 1 条（新轮首步同批吸收全部 next-step 积压）；②steer 健康运行中跳整个 next-turn 队列、代价是延轮（多条同批合并通常只多延一步），空闲/abort 收尾期降级排队；③cancel 终止后需新消息唤醒；④冷会话 task_wait 即返。SKILL 新增「三级中断阶梯」（queue/steer/cancel + 判据"晚一步=白干一步→插队" + 反模式 + 马拉松硬地板）、「让位—唤醒」（goal 模式事件循环；马拉松回合驻留是评审闭环停摆根因——实测现场：总控 69 分钟单回合锁死 3 条子任务报告、子任务 93 分钟连跑评审意见进不去）、「阶段评审门」（连续跑 vs 阶段让位二选一写进 spawn prompt；总控必须回应阶段报告，否则子任务永久挂起）三节；双 README 投递语义节、PROTOCOL §4/§13 同步。

### Changed

- peer 范围扩显式预发布分支（三个 peer 依赖）：`>=0.1.2-0 <0.2.0` → `>=0.1.2-0 <0.1.3 || >=0.1.3-0 <0.1.4 || >=0.1.4-0 <0.2.0`。node-semver 只放行「比较符元组自身带预发布标签」的预发布版本（awesome-dsh-plugin contributing.md 官方警告的静默排除陷阱）：旧区间对当前 0.1.2-rc.1 有效，但会静默排除未来的 0.1.3-rc.x / 0.1.4-rc.x，让预发布宿主上的装机用户遇到需手工绕行的 ERESOLVE。经真 semver 引擎 8 版本实测：0.1.2-rc.1 / 0.1.3-rc.1 / 0.1.4-rc.2 / 0.1.9 全部 MATCH（现网行为不变），0.2.0-rc.1 保守排除；0.1.5-rc.x 为文档化绊线——宿主发布新预发布元组时须再扩一条分支（PROTOCOL 版本硬约束段已记规则）。
- **reportBack 汇报约定注入文案升级（行为协议变更）**：zh/en 双语逐句对齐新增两句——①"发送后即结束当前回合，不要在回合内等待或轮询总控的回复（它会在你空闲时自动开新轮送达）"：封死子任务发完报告驻留等待的停摆形态；②"多阶段任务：需总控评审的阶段发阶段报告并结束回合等待指示，未约定评审点的阶段连续执行"：阶段评审门机制的子任务侧约定。前缀不变（5 条前缀断言零改动），失败回退句保留；`task_spawn`/`task_spawn_batch` 描述同步总控视角（子任务发完即让位，你的回复会在它空闲时自动开新轮送达）。测试断言织入既有块（queueDepth 分列/动态 hint/让位句/超时 hint），总数保持 89。

## [0.16.2] - 2026-09-06

### Fixed

- **migrate 归档语义对齐宿主真实行为（真机验收产物）**：v0.16.0 发布后实测迁移 6 个跨项目会话，对照宿主源码（`dsh-workspace` lib/index.js 206-215/408 行）澄清：`archiveSession` 只把旧 id 记入工作区 `archivedSessionIds`（GUI 工作区面板据此折叠），**`sessionIds` 槽位保留、会话本体仍在 store、依旧可读且可被 `task_send` 续跑**——「归档」是工作区展示层语义，不是会话退役；对旧 id 发消息会唤醒旧副本、与新副本分叉。本版把说重的文案全部对齐：migrate 回执 note 扩为含分叉警告（旧 id 仍可读写，绝不再发消息）、工具描述、SKILL 反模式与工具表、PROTOCOL/ARCHITECTURE 同步宿主行号证据。零行为改动；单测保持 89。

## [0.16.1] - 2026-09-06

### Fixed

- **头部按钮裸键真机回归**：v0.15.0 的「复制会话Id」按钮在真机中文界面渲染出裸键 `header.action`。双重故障（宿主源码证实）：① 客户端 bundle 的 `inject` 只有 `["slots"]`，`@deepseek-ai/dsh-client-locale` 比按钮后装载时 apply() 拿不到 `ctx.locale`，词典注册被一次性跳过且永不重试；② 宿主仍会为槽位注册声明的 `locale: NS` 命名空间向组件传 `t` prop——`bind(ns)` 对未注册命名空间照发 `t`，而 `LocaleRuntime.translate` 词典缺失时**返回裸键**（dsh-client-locale client.js:1294 `?? key`），组件却无条件信任 `props.t`。修复：`ensureLocale()` 惰性重试注册——保存 ctx 引用、服务一被看见立即注册（宿主契约：register bump revision，已渲染出口拾取迟注册词典实时刷新；HMR 重复 apply 的 "already" 拒绝视为已注册）；`props.t` 裸键防护——`t(key)` 返回非字符串/空/等于 key/等于 `NS.key` 一律回落 `translateNow`（→ 内置 zh 字典）。任一层都保证最坏显示内置中文，绝不再出裸键。
- 安装态自检补真机回归断言：裸键 echo `t` 必须回落 zh 字典；locale 服务迟到（apply 之后才出现）必须在下一次渲染完成注册并经宿主 runtime 解析 zh/en。v0.15.0 自检因未传 `props.t` 而全绿——正是本回归的漏网盲区。

### Notes

- 纯浏览器侧修复，宿主侧 ops/tools/SKILL 不变；单测保持 89。

## [0.16.0] - 2026-09-05

### Added

- **跨工作区真迁移**：`task_workspace` 新增 `action: migrate`——宿主从不改写会话存储的 cwd（`attachSession` 以它为准校验），跨路径移动因此是「克隆 + 归档」：`sessionQuery.readSession` 读取完整且经重放校验的会话日志（不激活源会话）→ `sessions.create` 以目标工作区路径为 cwd 种子创建**新**会话（保留原 `createdAt`/`agentPreset`；宿主自家 `fork()` 内部同款原语——`fork` 本身刻意保留源 cwd/工作区，不能改道）→ `flush` 持久化 → 目标实体 `attachSession` → `workspaceRegistry.archiveSession` 持久归档原会话。结果返回**新 sessionId**（任务在其下继续，注册表记录 team/depth/父链/标题平移到新 id，编组与递归治理存活迁移）。
- **迁移防护**：运行中的源会话拒迁（`migrate-busy`——克隆只带得走已持久化日志，先 `task_wait` 收口）；源 cwd 已等于目标路径时拒绝并提示改用 `attach`（不产生冗余克隆）；宿主缺少快照/种子创建服务时报 `migrate-unavailable`；每一步部分失败（`migrate-failed`）都明确报告是否产生了孤儿克隆、原会话是否**未**被归档；移动成功但归档失败时保持 `ok: true` + `archived: false` + warning。
- SKILL 反模式清单补上本功能诞生的两条实战教训：**跨项目派发必须带与目标工作区路径精确匹配的显式 `cwd`**（否则子会话继承总控 cwd 落错工作区）；migrate 成功后对新 id 发消息、旧 id 已归档。

### Notes

- 仍是 11 个工具——migrate 是 `task_workspace` 的新 action，不是新工具。克隆+挂载+归档路线为社区 `dsh-session-mover` 插件实证、宿主 `fork()` 内部同源（`sessions.create` 带 seed + meta）。
- 单元测试 87 → 89（happy path 五步时序 read→create→attach→archive→注册表平移与元数据全携带；八个防护/部分失败分支）。

## [0.15.0] - 2026-09-05

### Added

- **界面文案跟随宿主语言（zh/en）**：所有用户可见字符串接入宿主官方语言通道（`@deepseek-ai/dsh-client-locale`——GUI「设置 → 通用 → 语言」同一来源，持久化于 settings 命名空间 `locale` 字段 `preference`）：
  - **浏览器侧按钮**（复制会话Id/已复制 ✓/复制失败 ↔ Copy Session ID/Copied ✓/Copy failed）向 client locale runtime 注册词典（NS `task-coordinator`）并经 `translate` 实时解析，语言切换即重渲染（`getSnapshot/subscribe`，uSES 安全）——官方 session-log-export 按钮同款接线；locale 服务缺失/注册被拒/React 过老任一情况退回内置中文字典，永不崩溃。
  - **宿主侧字符串**经新纯模块 `i18n.mjs` 每次调用实时解析：派发确认卡（标题/问题/「按计划派发（推荐）」↔「Dispatch as planned (Recommended)」/「暂不派发」↔「Not now」/选项说明）、多选卡默认问题与空选反馈、开场汇报约定后缀、`/tasks` 命令描述与提示（挂载时捕获）。切换语言后下一张卡/下一次开场即生效，无需重启。
  - **回退纪律**：只认精确 `en`；偏好缺失或不可识别一律保持历史中文——「未设置=跟随浏览器」是浏览器侧委托语义，宿主侧不可见，绝不猜测未内置的语言。
- 单元测试 80 → 87。

### Notes

- 模型面不变：工具描述仍是英文模型契约、SKILL 手册仍是中文、会话命名沿用 `MMDD｜类型｜主题` 约定——三者是文档化协议而非 UI 装饰。

## [0.14.0] - 2026-09-05

### Added

- **模型路由发现 `task_models`（第 11 个工具）**：市场分发场景下每个用户接入的 provider/model 都不同，id 永远不该靠猜——`task_models` 把宿主**活体模型目录**（`sessionController.modelCatalog()`，GUI 模型选择器同一数据源）投影为 `task_spawn` 可直接使用的精确 id：provider 分组、model id、reasoning effort 列表 + 应用级默认选择 + 单点失败的 provider（`failedProviders`）。只读、无需会话。宿主无此方法的老版本降级为 `catalog-unavailable`（提示改靠 spawn 错误提示）。
- **`model-unavailable` 错误自带可行动提示**：预校验拒绝时经 `describeModelRoutes` 附上真实可用路线——优先列出该 provider 实际提供的 model id，provider 本身不存在则回退列出全部可路由 provider，并指向 `task_models`。全链失败容忍：目录依赖任何异常都只退回原始错误消息。
- 单元测试 76 → 80。

## [0.13.0] - 2026-09-05

### Added

- **子会话模型指定**：`task_spawn` 与 `task_spawn_batch` 的每个条目接受可选 `provider` + `model`（+ `reasoningEffort`）为子会话选定 LLM 路线。安装走宿主 `sessionController.selectModel`（GUI 模型选择器同一 API），发生在**创建之后、开场提示词之前**——子会话第一轮就跑在指定模型上；选择以持久 `model/selection` 会话事件写入事件日志（重启存活）。成功载荷以 `model` 回显实际安装的选择。
- **目录预校验**：宿主 LLM 服务可达时，路线先经 `llm.resolveCallConfig` 在创建会话**之前**校验——无效组合返回 `model-unavailable`，不产生孤儿会话；目录服务缺失时优雅降级为仅靠 `selectModel` 自身校验，若安装仍失败则报 `model-select-failed` 并附可追踪的孤儿 `sessionId`，**绝不用错误模型开场**。
- 新错误码：`model-unavailable`、`model-select-failed`；`provider`/`model` 成对约束（缺一报 `bad-request`，单独 `reasoningEffort` 忽略）。单元测试 70 → 76。

### Notes

- 宿主语义如实披露：安装会话级模型会**同时更新应用级默认模型**（`agentDefaultModel.saveSelection` → settings `agent-default-model` 命名空间，即 GUI 选择器「最近选择即默认」行为）。混合模型批量中最后一个子会话的路线成为应用默认。`selectModel` 是宿主唯一公开入口（真正会话本地的 `selectForNextRequest` 为控制器内部方法、非服务 API），插件选择如实披露而非绕过。

## [0.12.1] - 2026-09-05

### Fixed

- **路径归一平台分支**（市场分发自查）：0.12.0 的 `normalizeWorkspacePath` 无条件小写化并把 `/` 折叠为 `\`——这是 Windows 假设，在大小写敏感文件系统（Linux）上可能把仅大小写不同的两个目录误判为同一工作区。现按 `process.platform` 分支：win32 分隔符归一 + 大小写折叠（NTFS 不敏感）+ 盘符根保留；darwin 仅大小写折叠（默认卷不敏感）；POSIX 保留大小写、反斜杠视为普通文件名字符。归一仅是**预筛**，宿主实体 attach 时的 realpath 全等校验仍是最终权威。
- 测试夹具去环境化：单测/安装态验证不再出现真实项目路径与 Windows 专属断言（平台行为由显式传 `platform` 参数的纯函数测试覆盖，全套件可在 POSIX CI 跑通）。单元测试 69 → 70。

## [0.12.0] - 2026-09-05

### Added

- **工作区迁移（`task_workspace`，第 10 个工具）**：`list` 列出宿主工作区；`attach` / `detach` 把**既有**顶层会话挂入/移出工作区——直连宿主 workspace 实体（`attachSession` / `detachSession`，与 `session.create` 内部同一 API），自带 cwd 与工作区路径一致性校验，**不向会话注入任何消息**。修复历史显式 `cwd` 派发落入「未分组」的会话（GUI 无此入口：拖拽走 `insertSessionBefore`，只接受已在区内的会话）。新错误码 `workspace-not-found` / `workspace-op-failed`。

### Changed

- **spawn cwd→工作区自动升级**：`task_spawn` / `task_spawn_batch` 将要发送的 cwd 与某工作区路径**精确匹配**（大小写/分隔符/尾分隔符归一）时，改发 `workspaceId`——宿主挂载工作区并派生同一 cwd，子任务不再落入未分组；未命中时保持旧语义。未分组的总控（自身 cwd 即工作区路径）派发的子任务同样自动归组。
- 技能手册、双 README、PROTOCOL、ARCHITECTURE 同步；单元测试 64 → 69；`verify-installed.mjs` 增加 task_workspace 全链与 spawn 升级断言。

## [0.11.0] - 2026-09-04

### Added

- **任务级复用凭证（`reusable: true`）**：`task_confirm` 与 `task_confirm_select` 新增可选 `reusable` 参数。长线任务（如 goal 模式）首次分析后确认一次，铸出的 `confirmationId` 不随批量成功而消耗，同一使命的后续批量全部复用——消除"每里程碑一张确认卡"的摩擦；默认行为（单次凭证）不变，向后兼容。复用凭证仍绑定调用会话、进程内存放（宿主重启失效）；多选变体的子集强制对每次复用依然生效。技能手册、双 README、PROTOCOL 同步。单元测试 62 → 64；`verify-installed.mjs` 增加复用凭证跨批断言。

## [0.10.0] - 2026-09-04

### Added

- **多选确认 / 部分派发（`task_confirm_select`，第 9 个工具）**：任务清单渲染为宿主通用提问 UI 的多选卡（`multiSelect` + 原生自定义输入行）——**中性样式，无琥珀 warn**（用户诉求）；用户勾选要派发哪些任务，批准把 `confirmationId` 绑定到**选中子集**；`task_spawn_batch` 强制批量标题 ⊆ 选中集（精确匹配，夹带未勾选标题报新错误码 `confirmation-mismatch`，无标题项视为未批准）；空选视为调整意见回传。通用 UI 不渲染 markdown 正文，工具描述要求总控先在聊天里给出完整方案。凭证同样单次使用、绑定调用方、进程内存放。
- 技能手册新增「部分派发」编排模式与 `confirmation-mismatch` 错误码；双 README 工具表扩为九个；`verify-installed.mjs` 增加多选确认全链断言。单元测试 59 → 62。

## [0.9.0] - 2026-09-04

### Added

- **总控触发可靠性**（实测失效场景驱动）：用户在 goal 会话里说「可以随时使用 /task 插件分发子任务会话」但模型未派发（名称无法解析 + 授权非要求）。三层修复：① `task_spawn` / `task_spawn_batch` 工具描述加入总控触发语境（任意措辞、含「/task 插件」类指代，并指向 task-coordination 技能）；② 技能描述 frontmatter 增加口语别名表；③ SKILL.md 新增「指令识别」与「总控指令模板（含 /goal objective 写法）」两节，双 README 新增「怎么指挥总控」。实测佐证：steer 指令点名工具后，该 goal 会话立即派发 3 个子任务会话（team `sgame-dev-batch`，同工作区）。

### Changed

- **确认卡规范对齐宿主**：`task_confirm` 的 plan 现强制 `# ` 一级标题开头——与官方 `exit_plan_mode` 的 plan-review 校验同式（`/^#\s+\S/`）；卡片视觉本就走宿主官方 plan-review 渲染器（与 exit_plan_mode 同款），此改对齐的是内容规范。`task_confirm.plan` 参数描述同步注明。

## [0.8.4] - 2026-09-04

### Fixed

- **技能部署错位**（影响 0.4.0–0.8.3 全部部署）：`install.ps1` 的 `Copy-Item $skillsSrc <target>/skills` 在目标目录已存在时会把源目录拷**进去**，形成嵌套 `skills/skills/`，而正式路径 `skills/task-coordination/SKILL.md` 自 0.4.0 起从未更新——总控实际加载的操作手册一直是旧版（缺 `task_confirm`/批量/回报/复制按钮等语义）。改为复制目录**内容**并清理历史嵌套残留；重启后技能目录描述与正文恢复同步。

## [0.8.3] - 2026-09-04

### Changed

- **复制按钮改版**：文案改为「复制会话Id」；样式由描边改为**面性设计**——亮色模式黑底白字、暗色模式白底黑字（走宿主主题 alias token `--dsw-alias-label-primary` / `--dsw-alias-label-primary-foreground`，自动跟随 light/dark/system）；几何参数对齐「Session 日志」按钮（圆角 18px、高 32px、13px 文字、`--dsw-font-family`）。

## [0.8.2] - 2026-09-04

### Fixed

- **客户端模块未装载**（0.8.0 按钮不出现的根因）：宿主 `dsh-client-modules` 扫描插件时经 `createRequire(baseUrl).resolve('<包名>/package.json')` 定位清单，而我们的 `exports` 未导出 `./package.json` → `ERR_PACKAGE_PATH_NOT_EXPORTED` → 插件被静默排除出客户端模块图（对照实测：同环境第三方插件 `dsh-better-sidebar` 因导出该项而正常装载）。补上 `"./package.json": "./package.json"` 导出；安装态验证新增该断言。

## [0.8.1] - 2026-09-04

### Fixed

- **派发的工作区归属**（实测缺陷修复）：此前 `task_spawn` / `task_spawn_batch` 只向 `sessionController.create` 传 `cwd`，子任务会话全部落进「未分组工作区」。现在解析调用方所在工作区（`workspaceRegistry` 成员归属，含经 spawn 注册表的祖先链回溯），改传 `workspaceId`（宿主语义：与 `cwd` 互斥，自动以工作区路径为 cwd 并 `attachSession`），子任务与总控同工作区可见。显式 `cwd` 参数仍优先（保持旧语义）；宿主无工作区注册表时降级为 cwd 语义，派发不受影响。单元测试 55 → 59，安装态验证新增归属断言。

## [0.8.0] - 2026-09-04

### Added

- **Web 客户端模块（复制会话 ID 按钮）**：插件首个客户端侧能力。`package.json` 声明 `dsh.client.platform: "web"` + `exports["./client"]`，`client.js`（`window.__ModuleLoader__` factory 格式，官方 `dsh-session-log-export` 同构）占用 `conversation.session.header.utilities` 槽，在每个会话头部右侧加「复制 ID」按钮：一键复制当前会话完整 `sessionId` 到剪贴板（`execCommand` 降级兜底），复制后短暂显示「已复制 ✓」。配合协调场景：复制即可粘进 `task_send` / `task_progress` / `/tasks <id>`。侧栏会话行右键菜单为宿主硬编码（实测不可扩展），故选有官方先例的头部槽位。
- 安装态集成验证新增客户端模块全链检查：声明解析、bundle 加载、槽位占用、点击复制行为。

### Changed

- `install.ps1` 文件清单补齐遗漏（`registry.mjs` / `commands.mjs` / `client.js`）。
- 确认兼容 DSH Desktop 2.0.5 / core **0.1.2-rc.1**（宿主升级后契约重验全绿：8 工具真实 `defineTool`、消息构造、技能挂载、命令注册、确认链）。

## [0.7.0] - 2026-09-04

### Added

- **结果回报约定（`reportBack`，默认开）**：`task_spawn` / `task_spawn_batch` 默认在开场提示词尾部自动追加汇报约定——子任务完成（或确认无法完成）后主动 `task_send` 结果摘要（结论、产出路径、遗留问题）回派发方会话；发送失败则写进最终回复。总控从纯拉取（`task_wait`+`task_progress`）升级为推送+兜底。不需要汇报的一次性任务传 `reportBack: false`（开场词保持原样，注册表摘录始终记原始 prompt）。
- 随包技能新增「结果汇报」段：收到汇报即记录、`task_wait` 兜底语义、opt-out 场景。

### Changed

- 单元测试 54 → 55（回报默认开/关、批量逐项生效、批量 opt-out），安装态集成验证新增开场词回报断言与 `reportBack: false` 原样校验。

## [0.6.0] - 2026-09-04

### Added

- **`task_confirm` 派发确认弹窗**（第 8 个工具）：把拆分方案做成计划审批卡（`ctx.userQuestions` 接缝，官方 `exit_plan_mode` 同构路径，零客户端改动），阻塞直到用户作答；批准返回单次 `confirmationId`，拒绝回传用户意见，关窗（`confirm-cancelled`）即停等；无 UI 时降级为聊天文字确认（`no-question-channel`）。
- **派发确认硬闸门**：`confirmBeforeBatch`（默认开）+ `confirmBatchThreshold`（默认 2）——达到阈值的 `task_spawn_batch` 必须携带本会话批准的 `confirmationId`（单次使用、绑定调用方），否则 `confirmation-required`；全部失败不消耗确认。消除"模型静默决定批量派发"的信息黑盒。
- **随包技能同步**：工具速览 8 工具、拆分决策加入"确认语义"四条、编排模式 1 流程加确认步、错误码表新增 5 行、反模式新增两条。

### Changed

- 工具面 7 → 8；`task_spawn_batch` 新增 `confirmationId` 参数；`index.mjs` 惰性解析 `ctx.get('userQuestions')`（不硬注入，宿主缺该接缝时其余工具不受影响）。
- 单元测试 52 → 54（确认批准/拒绝/取消/无信道/子代理拒答、闸门五态），安装态集成验证覆盖"未批准被拒 → 确认 → 批量派发 → 凭证复用被拒"全链。

## [0.5.0] - 2026-09-04

### Added

- **自动拆分执行：`task_spawn_batch` 工具**：一次调用批量创建任务会话（`tasks: [{title?, prompt, cwd?}]` + 统一 `team`），单个失败不中止其余（逐项 `results` 带独立 `code`）；批上限 `maxBatchSpawn`（默认 6）。工具面从 6 → 7。
- **递归治理：`maxSpawnDepth`（默认 2）**：注册表记录每个派生会话的 `depth` 与 `parentSessionId`；子深度 = 调用方深度 + 1，超限以新错误码 `spawn-depth-exceeded` 拒绝并指引改用 subagent；批量派生同样受限（全被拒时报 `batch-all-failed`）。
- **随包技能两章**：「拆分决策」（三维独立性判据、何时不拆、派发前汇报拆分方案）与「递归治理」（深度上限、并行/串行判据、任务会话 vs subagent 选择标准）；工具速览与错误码表同步更新为 7 工具。

### Fixed

- **真实 `defineTool` 契约对齐**：嵌套 object schema 必须显式 `additionalProperties`（集成验证实测捕获）；安装态验证 mock 修复（批量场景需唯一 session id、短 ID 歧义应报错而非命中第一个）。
- 单元测试 48 → 52，安装态集成验证覆盖批量派发、深度链（1→2→拒）、短 ID 歧义路径。

## [0.4.0] - 2026-09-04

### Added

- **`/tasks` 斜杠命令**（`commands.mjs`）：注入 `commands` 服务（仿官方 `dsh-command-goal` 注册模式）注册 `/tasks`、`/tasks team <名称>`、`/tasks <sessionId>`（支持短 ID 前缀唯一解析）。命令**直接执行、不进模型、零 token**——只读查询走 GUI 快速通道，动作类操作（发消息/派发/等待/取消）仍走 `task_*` 工具；宿主无命令注册表时降级为 warning，不影响工具面。随包技能补充「快速通道」用法。
- 单元测试 44 → 48（新增命令语法/渲染/注册降级用例），安装态集成验证覆盖 list/team/inspect/short-id/usage 五条命令路径。

## [0.3.0] - 2026-09-04

### Added

- **团队工作流（workstream）**：`task_spawn` 新增 `team` 参数，`task_list` 新增 `team` 过滤——同一批任务编组后可整组找回。
- **持久 spawn 注册表**（`registry.mjs`）：记录协调者 spawn 过的会话（团队 / 创建时间 / 标题 / 意图摘录），默认落盘 `<DSH_HOME 或 ~/.dsh>/task-coordinator/registry.json`，**宿主重启后编组依然有效**；写入近似原子（临时文件 + 重命名）、损坏文件保留为 `*.corrupt-<时间戳>` 不静默丢弃、`registryMaxEntries`（默认 500）最旧先裁剪。配置新增 `registryFile` / `registryMaxEntries`。
- **关联 ID 与引用追溯**：`task_send` 返回 `messageId`、`task_spawn` 返回 `correlationId`；`task_send` 新增 `reference` 参数引用先前指令，引用以可见注释行随消息送达。
- **多目标等待**：`task_wait` 支持 `sessionIds` 数组 + `mode: 'all' | 'any'`（兼容单目标 `sessionId`）。
- **机器可读错误码**：全部工具失败统一 `{ ok: false, code, error }`——守卫拒绝码 `DENIAL_CODES`（safety.mjs）+ 操作失败码 `OP_CODES`（ops.mjs），agent 按码分支不读文案；未预期异常兜底 `code: 'internal'`。

### Changed

- **文档迭代（对齐 unity-pipe 文档架构）**：README.md / README.zh-CN.md 重构为统一结构（徽章条 + 快速导航 +「这是什么」+ 快速开始 + 工具面 + 目录树 + 文档索引）；新增 `docs/ARCHITECTURE.md`（模块分层、DI 边界、降级策略）、`docs/PROTOCOL.md`（主机契约与投递语义实测参考）与本文件；`package.json` 的 `files` 补录 `docs/` 与 `CHANGELOG.md`。
- **投递语义文档化**：`delivered: true` 仅代表进入收件箱（投递 ≠ 消费），对账流程写入随包技能与主机契约参考。

### Fixed

- **`index.mjs` 的 `ctx.provide('taskCoordinator', …)` 版本号停在 `0.1.0`**：随本轮统一为 `0.3.0`，与 `package.json` 一致。

## [0.2.0] - 2026-09-04

从 DHS-Tool 工程工作区（`D:/git/DHS-Tool`）抽出、以独立仓库在 GitHub 发布的首个版本。以下内容均在工作区阶段完成交付，随初始提交入库；主机契约在 **DSH 0.1.2-alpha.1** 实测，重启后端到端六项能力全部通过。

### Added

- **六个协调工具**（`task_list` / `task_progress` / `task_send` / `task_spawn` / `task_wait` / `task_cancel`）：总控会话可发现其他顶层会话、读取进度（实时/冷状态、队列消息、对话尾部、todos、goal）、创建新任务（立即出现在 GUI 会话列表）、投递可见后续提示词——`queue`（轮次边界）/ `steer`（步骤边界）双模式，外加等待空闲与取消活动轮次。
- **安全模型**：自寻址恒拒、子代理会话栅栏隔离、子代理调用方默认拒绝（`allowSubagentUse`）、同目标限频（`minSendIntervalMs`）与排队深度限制（`maxQueuePerTask`）；调用方身份每次工具调用从执行上下文重新推导。
- **Spawn 命名规则**（`MMDD｜类型｜主题`）：日期前缀由插件按会话**创建时间**机械盖印（`titleTimeZone`，默认 Asia/Shanghai），模型只填 `类型｜主题`；类型枚举 + 兜底「探索」、主题截断 16 字、半角竖线与旧式 `[团队]` 前缀自动归一。
- **内置 `task-coordination` 技能**（supervisor playbook）：投递语义、扇出/监督/交接编排模式、命名规则与反模式；隔离 `dsh-skill-filesystem` provider 挂载（不遮蔽项目/用户技能、编辑热加载、随插件卸载消失），provider 包不可用时降级为 warning 不影响工具。
- **部署脚本** `install.ps1`：复制式安装进 `~/.dsh/profiles/desktop`（不跑 `pnpm install`、不碰 lockfile），profile manifest 与 `.package-map.json` 登记前自动备份，支持 `-Uninstall` 对称卸载。
- **测试**：33 个单元测试（`test/smoke.test.mjs`，mock 宿主）+ `verify-installed.mjs` 安装态集成验证（真实 `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-skill-filesystem` 包 + mock ctx）。

### Fixed

- **`task_spawn` kickoff 缺陷**（端到端实测发现）：prompt 门面需要 AbortSignal——修复后重启复验，创建 + 命名 + 开场提示词准入 + 列表实时可见全链路通过（`SPAWN_FIXED_OK`）。

[Unreleased]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.18.5...v0.19.0
[0.17.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.16.2...v0.17.0
[0.16.2]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.8.4...v0.9.0
[0.8.4]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.3.0...v0.7.0
[0.6.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/commit/5599b2e
[0.5.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/commit/5599b2e
[0.4.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/commit/5599b2e
[0.3.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/releases/tag/v0.2.0
