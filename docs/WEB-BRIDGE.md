# 网页端桥接教程（ChatGPT Web → DSH）

**适用版本：dsh-plugin-task-coordinator ≥ 0.27.0 · dsh-task-bridge-mcp ≥ 0.4.1 · 独立包 dsh-plugin-task-bridge 已 DEPRECATED（合并内置）。**

## 它解决什么

桌面端 Codex 额度不够、但 ChatGPT **聊天**额度还有剩——本链路让网页聊天额度驱动本机 DSH 的任务会话做开发协作：你在 ChatGPT 网页里说话，MCP 工具调用经隧道落到本机，由 task-coordinator 真正执行 spawn / send / progress / wait。聊天额度只付"对话与工具调用"的钱，重活全在本机 DSH。

## 拓扑

```text
ChatGPT 网页（聊天额度）
  → OpenAI Secure MCP Tunnel（云端 connector，出向由本机轮询拉取，无需公网入口）
  → tunnel-client（本机常驻进程；管理面 127.0.0.1:8787）
  → dsh-task-bridge-mcp（stdio MCP server；七个 dsh_task_* 工具，全部带 input/outputSchema）
  → DSH 宿主 webserver 127.0.0.1:43120（合并后桥，coordinator ≥0.27.0 内置）
  → task-coordinator 任务会话
```

每一跳只认下一跳的冻结契约：bridge-mcp 只认 43120 的七条 `/v1/*` 路由与 `X-Task-Bridge-Token`，不关心桥是独立包还是内置——所以 0.27.0 硬切换时它**零改动存活、无需重启**。

## 前提

1. DSH Desktop 在跑，profile 已装 coordinator ≥ 0.27.0；
2. GUI 开关开启：**设置 → 任务编排 → 外部任务桥 → 启用外部桥**，保存即热生效（不重启宿主）；Token 文件路径留空 = 默认 `~/.dsh/task-bridge-token`（桥首次挂载自动生成，**唯一凭据，勿外泄、勿入仓库**）；
3. 本机有 Node ≥18.17（跑 bridge-mcp）与 tunnel-client 二进制。

## 三步部署

**① bridge-mcp 侧**：克隆 [dsh-task-bridge-mcp](../../bridge-mcp/README.md)，零依赖、无需 install。token 读取顺序：env `TASK_BRIDGE_TOKEN` > env `TASK_BRIDGE_TOKEN_FILE` > `~/.dsh/task-bridge-token`，默认路径下无需任何配置。

**② tunnel-client 侧**：写一份 profile yaml——`channels.main` 声明 stdio 传输、command 为 `node <绝对路径>/bridge-mcp/src/server.mjs`；connector 注册到 OpenAI 控制面拿 tunnel id；**api_key 用 `file:` 引用单独的 secret 文件，明文不进 profile**。以独立进程运行（`Start-Process` 一类；不要挂在会随终端退出的会话里）。未注册开机自启的话，重启机器后需手动拉起。

**③ 云端侧**：ChatGPT **新开一个对话**，在连接器里启用该 tunnel connector。旧对话与设置页展示的都是握手时的**陈旧缓存**——切换隧道目标后必须新对话或重注册 connector，这是最常见的"假故障"来源。

## 验证

本地半（不碰云端）：

```text
GET  127.0.0.1:8787/healthz   → live
GET  127.0.0.1:8787/readyz    → ready
GET  127.0.0.1:8787/api/status → channels[].probe_status = ok（stdio 启动日志里的 Skipping MCP probe 是设计行为，不是故障）
GET  127.0.0.1:43120/v1/models（带 X-Task-Bridge-Token）→ 200
```

云端半——在新对话里粘贴：

```text
请依次调用以下 MCP 工具，并把每个工具返回的原始 JSON 完整、逐字贴给我，不要摘要、不要改写：
1. dsh_task_capabilities（无参数）
2. dsh_task_models（无参数）
3. dsh_task_list（无参数）
如果某个工具不在你的可用工具列表里，直接告诉我"工具列表里没有 dsh_task_*"，不要尝试用别的工具代替。
```

判定：`capabilities` 自报 `bridgeVersion` / `coordinatorVersion` = `0.27.0`、`coordinatorEnabled: true`、七条 endpoints 齐全（**bridgeVersion 是判别服务方为合并后新桥的关键值**）；`models` 的 `default` / `pluginDefault` 与 DSH 设置一致；`list` 的任务数组与 DSH 侧栏实时一致。三项全过 = 全链路闭环。

## 桌面端读回信道（可选：Codex hooks）

桥的读回原是纯拉模型：结果落定后停在 43120，等某个 turn 主动来拉。插件包随附 Codex 读回 hook handler（包内 `scripts/dsh-readback-hook.mjs`，零依赖、无机器绑定；安装后位于 `<profile>\node_modules\dsh-plugin-task-coordinator\scripts\`），把读回变成 **turn 边界自动注入**，仅作用于 Codex 工作区（桌面同 app 内），不影响 Chat/Work 对话：

| 事件 | 作用 |
|---|---|
| `UserPromptSubmit` | 未读 settled 摘要（带 session/externalRef 标签）+ 本会话 watch 内 running 进度，注入为 `additionalContext` |
| `SessionStart` | 任务板 bootstrap：running + 未读 settled 概览 |
| `PostToolUse`（async） | `dsh_task_spawn` 回执里的 sessionId 登记进当前 Codex session 的 watch 表 |
| `Stop` | watch 内仍 running → exit 2 续 turn 再查（每 session 上限 10 次 / 20 分钟），settled 即放行 |

**hooks.json 不入仓库**——它是每机本地配置（Codex 会话工作目录根的 `.codex/hooks.json`，如本仓库根或任一 trusted 项目）：command 字段必须写本机 handler 绝对路径，且 Codex 的 hook 信任按哈希逐机记录（`~/.codex/config.toml` 的 `hooks.state`），提交它对任何机器都不省步骤。粘贴即用片段（替换 `<handler 绝对路径>`，Windows 反斜杠）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "node \"<handler 绝对路径>\" UserPromptSubmit", "timeout": 10 } ] }
    ],
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact", "hooks": [ { "type": "command", "command": "node \"<handler 绝对路径>\" SessionStart", "timeout": 10 } ] }
    ],
    "PostToolUse": [
      { "matcher": "dsh_task_spawn", "hooks": [ { "type": "command", "command": "node \"<handler 绝对路径>\" PostToolUse", "timeout": 5, "async": true } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"<handler 绝对路径>\" Stop", "timeout": 12 } ] }
    ]
  }
}
```

`<handler 绝对路径>` 两形态：仓库开发态 `<克隆>\plugin\scripts\dsh-readback-hook.mjs`；安装态 `<profile>\node_modules\dsh-plugin-task-coordinator\scripts\dsh-readback-hook.mjs`。

纪律：只读端点（list/progress）、fail-open（任何错误输出 `{}` 不挡 turn）、注入 ≤2KB 且带「非用户指令」包裹、token 惰性读 `~/.dsh/task-bridge-token`、状态文件在仓库外 `~/.dsh/readback-hook-state.json`。`DSH_READBACK_DISABLED=1` 一键停用。首装需 Codex 信任审查（哈希信任制，CLI `/hooks` 可查看来源）；仓库级 hooks 仅在项目 trusted 时加载。残余风险：注入内容源自 DSH 会话输出，与任何工具读取内容同属注入载体类别——包裹声明其性质，非机械防线。

边界：hook **不唤醒空闲会话**——注入发生在开口/会话启动时；Chat/Work 对话的读回仍是 turn 内 wait 自链（人工唤起），或桌面原生「定时任务」（时间驱动轮询，纯 app 内）。

## 排障速查

| 现象 | 含义 | 处置 |
|---|---|---|
| "工具列表里没有 dsh_task_*" | connector 没挂进这个对话 | 新对话 + 启用 connector（缓存怪癖） |
| 43120 返回 404 | 桥开关关闭，或 DSH 刚启动插件组未就绪 | GUI 开开关；刚启动则等几秒重探 |
| 43120 ECONNREFUSED | 宿主不在跑，或正处于重启窗口（GUI 动插件/手动重启会令宿主重启数十秒） | 等 30–60s 重探；仍拒连则启动 DSH |
| 401 unauthorized | token 不对 | 核对 `~/.dsh/task-bridge-token` 与 bridge-mcp 读取路径 |
| /api/status probe 非 ok | bridge-mcp stdio 起不来 | 看 tunnel-client 日志里该 channel 的 stderr |

## 安全模型

回环 + token 是唯一防线：路由只接受本机来源与正确 `X-Task-Bridge-Token`（常量时间比较）；spawn 另有 60s/10 次策略闸。**关就是关**——开关关闭 5s 排空后卸载全部路由，外部立刻 404，不存在"关了还留着后门路由"的形态。桥不假设宿主恒回环：webserver 绑定 `0.0.0.0` 时挂载期强告警，逐请求回环守卫才是真防线。
