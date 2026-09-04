# dsh-plugin-task-coordinator

**Codex 风格的跨任务协调** —— DeepSeek Harness (DSH) 的总控操作手册。

任意顶层会话（“任务”）都可以：
- 发现其他顶层会话
- 读取进度
- 自动创建任务（会话列表立即可见）
- 发送可见的后续提示词（空闲即启动新一轮，运行中排队到边界）

所有跨任务指令都带 `kind: 'coordinator'` 来源标记，可在目标会话 transcript 中追溯。

## 六个工具

| 工具          | 用途 |
|---------------|------|
| `task_list`   | 列出协调可见的任务（含 sessionId、状态、标题、todo/goal 进度） |
| `task_progress` | 深入读取单个任务（实时/冷状态、队列消息、对话尾部、todos、goal） |
| `task_send`   | 发送可见后续提示词（mode: queue / steer） |
| `task_spawn`  | 创建 + 命名 + 启动新任务（标题 `MMDD｜类型｜主题`） |
| `task_wait`   | 阻塞直到目标任务空闲（或超时） |
| `task_cancel` | 取消目标活动轮次（保留队列消息） |

## Spawn-title 规则（MMDD｜类型｜主题）

任务创建标题统一格式 `MMDD｜类型｜主题`：

- **日期前缀**由插件根据会话**创建时间**（Asia/Shanghai）机械盖印，模型只填 `类型｜主题`
- 允许类型：功能、设计、修复、优化、发布、探索、文档、研究
- 主题最多 16 字，适合侧栏显示
- 拿不准类型用兜底「探索」；无标题时从 kickoff prompt 第一行自动提取

## 内置技能（supervisor playbook）

插件自带 `task-coordination` 技能（`skills/task-coordination/SKILL.md`），教总控“何时、如何”编排六个工具。技能隔离挂载，随插件安装/卸载/编辑热加载。

## 配置示例（cordis.yml）

```yaml
- id: task-coordinator-runtime
  name: 'dsh-plugin-task-coordinator'
  config:
    enabled: true
    allowSubagentUse: false
    titleTypes: ['功能', '设计', '修复', '优化', '发布', '探索', '文档', '研究']
    titleFallbackType: '探索'
    titleMaxTopicChars: 16
    titleTimeZone: 'Asia/Shanghai'
    maxQueuePerTask: 5
    minSendIntervalMs: 2000
```

## 主机合约（已验证 DSH 0.1.2-alpha.1）

- `ctx.sessionController` 支持 list/create/rename/prompt/cancel
- `ctx.agents` 提供 get/status/inbox/whenIdle/followup/steer
- 支持 `@deepseek-ai/dsh-tools` 的 defineTool

新任务创建后会自动出现在 GUI 会话列表（`api-session/added` 事件）。

## 开发与部署

```powershell
cd D:/git/DHS-Tool/plugin
node --check *.mjs
node --test test/smoke.test.mjs
# 安装到桌面 profile
pwsh install.ps1
# 重新部署
pwsh install.ps1
```

## 许可证

MIT
