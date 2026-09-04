# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[Unreleased]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/releases/tag/v0.2.0
