# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]（0.3.0 在研）

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

[Unreleased]: https://github.com/Kayungko/dsh-plugin-task-coordinator/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Kayungko/dsh-plugin-task-coordinator/releases/tag/v0.2.0
