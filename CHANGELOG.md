# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.17.0...HEAD
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
