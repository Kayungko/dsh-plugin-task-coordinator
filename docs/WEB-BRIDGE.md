# 网页端桥接教程（ChatGPT Web → DSH）

**适用版本：dsh-plugin-task-coordinator ≥ 0.27.0（token 文件自动生成需 ≥ 0.27.2）· dsh-task-bridge-mcp ≥ 0.4.1（网页侧直接读写本机文件的 `local_*` 工具需 ≥ 0.5.0）· 独立包 dsh-plugin-task-bridge 已 DEPRECATED（合并内置）。**

## 它解决什么

桌面端 Codex 额度不够、但 ChatGPT **聊天**额度还有剩——本链路让网页聊天额度驱动本机 DSH 的任务会话做开发协作：你在 ChatGPT 网页里说话，MCP 工具调用经隧道落到本机，由 task-coordinator 真正执行 spawn / send / progress / wait。聊天额度只付"对话与工具调用"的钱，重活全在本机 DSH。

### 两种工作模式（bridge-mcp ≥ 0.5.0）

同一个隧道、同一个 connector，网页侧可以按需走两条路：

| | **A. 派给 DSH**（`dsh_task_*`，默认） | **B. 直接操作本机**（`local_*`，默认关闭） |
|---|---|---|
| 谁干活 | DSH 任务会话里的 agent | bridge-mcp 进程自己 |
| 额度 | 消耗 DSH 侧模型额度 | **零模型额度** |
| 延迟 | 秒级到分钟级 | 毫秒级 |
| 拿到的 | agent 的转述 + 尾部摘要（默认 6 条消息，可 cursor 分页） | 文件原文 / 命令原始输出 |
| 人在环 | **部分**：任务在 DSH 侧栏实时可见、可随时 steer/cancel；但网页发起的 spawn **不弹确认卡**（确认门只在 `task_spawn_batch`），桥侧只有 60s/10 次策略闸 | **没有**（网页侧静默执行） |
| 适合 | 需要推理、改多处、跑测试的开发任务 | 查代码、读配置、看日志、跑一条命令 |

模式 B 让网页 GPT 能直接读你本机的文件（不用先派个任务让 DSH agent 去读再把摘要转回来），
代价是**没有人在环**：网页会话里的提示注入可直接指挥它读写文件、执行命令。因此 B 默认一个
工具都不注册，需要显式 opt-in，且内置了强制凭据保护与写/执行审计日志。启用方式、五个工具
的参数、六层防护与有界性详见 bridge-mcp 仓 README 的「本地文件与命令工具」节。

**建议的启用梯度**（bridge-mcp ≥0.5.2）：

1. **只开文件、不开 shell**：`DSH_BRIDGE_LOCAL_FS=1`。"网页侧查代码"的绝大部分需求这一档就够了。
2. **同时把范围收窄到项目目录**：再加 `DSH_BRIDGE_FS_ALLOW=<项目根>`。白名单与凭据保护是
   **AND** 关系（只收窄、永不放宽：把 home 加进白名单，`~/.ssh/id_rsa` 与桥 token 照样被拒），
   且递归遍历内逐条目生效、`..` 穿越与 junction 逃逸都以 canonical 结果判定。
3. **确需跑命令再另开** `DSH_BRIDGE_LOCAL_EXEC=1`，并且要清楚：**开了 exec 就没有文件级边界了**。
   凭据保护、白名单、自身完整性保护全都是文件工具层的约束，而 shell 不受它们管
   （`type C:\Users\you\.ssh\id_rsa`、`echo x > <工作树>\src\local-fs.mjs` 一条命令就够）。
   这不是实现缺陷而是「给出 shell」的定义本身——所以别把六层防护当成开了 exec 之后还在生效。
   这一条是 bridge-mcp 0.5.2 用独立脚本实测确认的边界，不是推断。

另：`local_write_file` 不得改写 bridge-mcp **自己的包目录**（生产 profile 直接跑工作树，
改写源码会在下次重启后被加载，属持久化通道），也不得改写审计日志文件。前者可用
`DSH_BRIDGE_FS_ALLOW_SELF_WRITE=1` 解除，后者不可解除。审计行本身做了防注入编码
（命令里的换行不能再伪造审计记录），但**命令原文会逐字落盘**，所以内联了秘密的命令
（`curl -H "Authorization: Bearer …"`）会把秘密写进审计文件——`DSH_BRIDGE_AUDIT_FILE`
要按凭据来管，别放在会被 `local_grep` 扫到的项目目录里。

## 拓扑

```text
ChatGPT 网页（聊天额度）
  → OpenAI Secure MCP Tunnel（云端 connector，出向由本机轮询拉取，无需公网入口）
  → tunnel-client（本机常驻进程；管理面默认 127.0.0.1:8080，由 profile 的 health.listen_addr 决定——本文示例用 8787）
  → dsh-task-bridge-mcp（stdio MCP server；七个 dsh_task_* 工具，全部带 input/outputSchema）
      ├─ 模式 A：→ DSH 宿主 webserver 127.0.0.1:43120（合并后桥，coordinator ≥0.27.0 内置）→ task-coordinator 任务会话
      └─ 模式 B：→ 本机文件系统 / shell（0.5.0 起的 local_* 工具，默认关闭；**不经 43120、不消耗模型额度**）
```

每一跳只认下一跳的冻结契约：bridge-mcp 只认 43120 的七条 `/v1/*` 路由与 `X-Task-Bridge-Token`，不关心桥是独立包还是内置——所以 0.27.0 硬切换时它**零改动存活、无需重启**。模式 B 是 bridge-mcp 进程内的本地能力，**不走桥、不改 wire 契约**，因此它的增删对 DSH 侧与既有消费方零影响。

## 前提

1. DSH Desktop 在跑，profile 已装 coordinator ≥ 0.27.0；
2. GUI 开关开启：**设置 → 任务编排 → 外部任务桥 → 启用外部桥**，保存即热生效（不重启宿主）；Token 文件路径留空 = 默认 `~/.dsh/task-bridge-token`。
   - **≥ 0.27.2**：该文件由桥在挂载时自动生成（32 随机字节 → 64 位小写十六进制；**已存在则绝不覆盖**，以保护你手工轮换过的 token）。生成失败只留告警、不阻断挂载——此时七条路由一律回 503，去宿主日志看 `task-bridge: could not generate token file` 定位原因。
   - **0.27.0 / 0.27.1**：合并时把旧独立包 `install.ps1`（当时唯一的 token 生成者）一并废弃，却没有接替者。这两个版本上文件**不会自动生成**，必须按下方「① 之前」手工建好，否则一律回 **503 `bridge token is unavailable`**。
   - token 是唯一凭据，勿外泄、勿入仓库。
3. 本机有 Node ≥18.17（跑 bridge-mcp；与宿主自身的 Node 版本要求互不相干）与 tunnel-client 二进制（本文在 **v0.0.14** Windows 版上端到端验证；获取渠道与校验以 OpenAI 控制面创建通道时给出的官方指引为准，建议核对 SHA256）。

## 三步部署

**① 之前：token 文件（仅 coordinator < 0.27.2 需要；≥ 0.27.2 由桥自动生成，跳过本步）**

```powershell
$tokenFile = Join-Path $env:USERPROFILE '.dsh\task-bridge-token'
$dir = Split-Path $tokenFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
if (Test-Path $tokenFile) {
  Write-Host "已存在，保持不动（不覆盖你可能轮换过的值）: $tokenFile"
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  Set-Content -Path $tokenFile -Value (-join ($bytes | ForEach-Object { $_.ToString('x2') })) -NoNewline -Encoding ascii
  Write-Host "已生成 64 位十六进制 token: $tokenFile"
}
```

别把 token 值本身打印出来或贴进任何仓库内文件。轮换 = 覆写该文件；桥与 bridge-mcp 都按 `(mtime, size)` 惰性重读，**无需重启宿主或 tunnel-client**。

**① bridge-mcp 侧**：取得 [dsh-task-bridge-mcp](https://github.com/Kayungko/dsh-task-bridge-mcp)（相邻仓链接供本工作区查阅；各包独立部署时以其随包 README 为入口），零依赖、无需 `npm install`。三种取法，按「profile 里还要不要写绝对路径」排序：

| 取法 | profile 的 `command:` 写法 | 仓库搬家是否受影响 |
|---|---|---|
| **A. 全局安装（推荐）** `npm i -g <clone 目录>` | `dsh-task-bridge-mcp`（走 PATH shim，**完全无路径**） | 否——shim 按自身目录相对解析，且 `-g` 是拷贝安装 |
| **B. 全局安装 + node 直调** | `node <npm 全局 node_modules>/dsh-task-bridge-mcp/src/server.mjs` | 否（路径在用户目录，不在 git 工作树） |
| **C. 仅 clone（本文验证所用）** | `node <clone 目录>/src/server.mjs` | **是**——仓库一挪就得改 profile |

> 查 npm 全局根目录：`npm root -g`。A 方案的 shim 名来自包 `package.json` 的 `bin` 字段。
> **`npx -y dsh-task-bridge-mcp` 目前不可用**：tunnel-client 内嵌文档确实把 `npx -y @org/main-mcp` 列为官方形态、且解析层完全支持（`.cmd` 可被直接执行），但该包**尚未发布到 npm registry**（2026-09-23 核实返回 404）。即便将来发布，`npx -y` 首跑要联网下载解包，会把 MCP 启动从毫秒级拖到秒级、离线即不可用——生产链路不建议。

token 读取顺序：env `TASK_BRIDGE_TOKEN` > env `TASK_BRIDGE_TOKEN_FILE` > `~/.dsh/task-bridge-token`。走默认路径时无需配置任何 env，**但文件必须已存在**（见「① 之前」）。

**② tunnel-client 侧**：写一份 profile yaml。通道字段是 **`mcp.commands[]`**（每项一个 `channel` + 一条 `command` 串），**不是** `channels.*`——`/api/status` 回显里的 `channels[]` 是运行态投影，别照着它反推配置结构。connector 在 OpenAI 控制面创建通道后拿 `tunnel_...` id（资源标识符，非密钥）；**api_key 用 `file:` 引用单独的 secret 文件，明文不进 profile**。

脱敏模板（**放仓库外**——profile 里有本机绝对路径与 tunnel id，secret 文件同理）：

```yaml
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "<创建通道时得到的 tunnel_... ID>"
  # 只支持 env:VARNAME 与 file:/path 两种引用形式，且在启动时解析。
  # 注意：这是 YAML 值里的前缀约定，不是 OS 环境变量插值；env: 优先级高于 YAML 明文。
  api_key: "file:C:/repo-outside/dir/api-key.secret"
health:
  # 默认 127.0.0.1:8080（非必填）。同机跑第二个实例必须改这里，否则端口冲突、进程直接退出。
  # 想要 OS 分配临时端口用 "127.0.0.1:0"，并配 url_file 让别的进程能发现解析后的地址。
  listen_addr: "127.0.0.1:8787"
  # url_file: "C:/repo-outside/dir/tunnel-client-health.url"
admin_ui:
  open_browser: false          # UI 与 health 同端口（GET / 或 /ui），不额外占端口
log:
  level: info
  format: json
  # 同样是绝对路径：搬 profile 目录要同步改，否则日志写不出来。
  # 多实例必须各用独立路径——同路径会让 JSON 行交错。
  file: "C:/repo-outside/dir/tunnel-client.log"
mcp:
  commands:
    - channel: main
      # command 只接受 channel 与 command 两个字段：没有 argv/env/cwd 逃生口。
      # 路径写法见下方「command 串的分词规则」。
      command: 'dsh-task-bridge-mcp'
```

**`command` 串的分词规则**（实测 tunnel-client v0.0.14；官方 help 与内嵌文档对此零说明，以下是实测结论）：

- 走的是 **POSIX shell-word 分词**，**不经 shell**（自己 token 化 → `exec.LookPath` → CreateProcess → 接管子进程 stdin/stdout）。
- **`\` 是转义符**：在引号外和双引号内都会吃掉下一个字符。这就是「Windows 反斜杠路径被吃」的根因——`D:\git\x` 会变成 `D:gitx`，报错只说"script not found"，不会告诉你因为反斜杠。
- **单引号内完全字面**，反斜杠存活：`node 'D:\git\x\server.mjs'` 可行。
- **不做任何展开**：`${VAR}`、`%VAR%`、`~` 全部按字面量传给子进程。
- **正斜杠最稳**（官方 samples 与本文验证均用它）：`node D:/git/x/server.mjs`。
- **YAML 自己还有一层转义**：双引号 YAML 标量里 `\g` 是非法转义（报 `found unknown escape character`）。要用反斜杠路径，必须套 **YAML 单引号**。
- 不含引号时按空白切分，**所以路径含空格必须加引号**；克隆路径尽量避开空格与非 ASCII 字符，能省掉一整类问题。
- `env:` / `file:` 前缀**不适用于 `command`**（官方原文限定只用于 `control_plane.api_key` 与静态 header 值），写了就是字面量。

**进程生命周期**：以独立进程运行（`Start-Process` 一类；不要挂在会随终端退出的会话里）。未注册开机自启的话，重启机器后需手动拉起；DSH Desktop 也必须在跑（43120 由宿主 webserver 提供）。

**同一个 `tunnel_id` 不允许多个活动实例**：轮询是「按 tunnel 排空一个共享队列」，不是按实例分队列，协议文档明确否认 active-active。开两份的后果是**抢单**——控制面下发的命令被非确定性分走、各自路由到自己的 bridge-mcp 子进程，表现为间歇性、无法复现的请求丢失或走错实例，**端口错开也解决不了**。要多实例就得各自一个独立 `tunnel_id`（对应 ChatGPT 里不同 connector），外加各自的 `listen_addr` 与 `log.file`。

> ⚠️ **`doctor` 会真的 bind health 端口**（输出里的 `CHECK health_listener PASS ephemeral bind ok`）。对一个 `listen_addr` 已被生产实例占用的 profile 跑 doctor 会抢端口——校验在用的 profile 前先把它改成 `127.0.0.1:0`，或复制一份改端口再校验。

先 `tunnel-client.exe doctor --config <profile> --explain` 通过，再 `run --config <profile>`。

**③ 云端侧**：ChatGPT **新开一个对话**，在连接器里启用该 tunnel connector。旧对话与设置页展示的都是握手时的**陈旧缓存**——切换隧道目标后必须新对话或重注册 connector，这是最常见的"假故障"来源。

## 验证

> **先读**：43120 由宿主 webserver 提供，而 webserver 先于 coordinator 插件组就绪——DSH 刚拉起时探测会**短暂 404**；在 GUI 里动插件（更新/回滚）或手动重启宿主，会有**数十秒 ECONNREFUSED 窗口**。这两类失败先等 30–60s 重探，别当成桥坏了（详见文末排障速查）。探测脚本必须容忍 404 重试、并带超时，否则分不清"关干净"和"挂起"。

本地半（不碰云端）：

```text
GET  127.0.0.1:8787/healthz   → live
GET  127.0.0.1:8787/readyz    → ready
GET  127.0.0.1:8787/api/status → channels[].probe_status = ok（stdio 启动日志里的 Skipping MCP probe 是设计行为，不是故障）
GET  127.0.0.1:43120/v1/models（带 X-Task-Bridge-Token）→ 200
```

Windows 可复制形态（用 `curl.exe`：PowerShell 5 里裸 `curl` 是 `Invoke-WebRequest` 的别名、参数不兼容，pwsh 7 移除了该别名但 `curl` 未必在 PATH）：

```powershell
curl.exe -s http://127.0.0.1:8787/healthz
curl.exe -s http://127.0.0.1:8787/api/status
# 带 token 打桥端；$T 只用于构造请求头，别把它打印出来
$T = (Get-Content "$env:USERPROFILE\.dsh\task-bridge-token" -Raw).Trim()
curl.exe -s -H "X-Task-Bridge-Token: $T" http://127.0.0.1:43120/v1/capabilities
```

云端半——在新对话里粘贴：

```text
请依次调用以下 MCP 工具，并把每个工具返回的原始 JSON 完整、逐字贴给我，不要摘要、不要改写：
1. dsh_task_capabilities（无参数）
2. dsh_task_models（无参数）
3. dsh_task_list（无参数）
如果某个工具不在你的可用工具列表里，直接告诉我"工具列表里没有 dsh_task_*"，不要尝试用别的工具代替。
```

判定：`capabilities` 自报的 `bridgeVersion` / `coordinatorVersion` **≥ `0.27.0` 且两者相等**——该值与 task-coordinator 的 `package.json` 单一版本轨锁步（装 0.27.2 就报 `0.27.2`），**报的不是 `0.27.0` 并不等于失败**；判别"服务方是合并后新桥"只需 ≥0.27.0 且两值一致。再看 `coordinatorEnabled: true`、七条 endpoints 齐全；`models` 的 `default` / `pluginDefault` 与 DSH 设置一致；`list` 的任务数组与 DSH 侧栏实时一致。三项全过 = 全链路闭环。

## 桌面端读回信道（可选：Codex hooks）

桥的读回原是纯拉模型：结果落定后停在 43120，等某个 turn 主动来拉。插件包随附 Codex 读回 hook handler（包内 `scripts/dsh-readback-hook.mjs`，零依赖、无机器绑定；安装后位于 `<profile>\node_modules\dsh-plugin-task-coordinator\scripts\`），把读回变成 **turn 边界自动注入**，仅作用于 Codex 工作区（桌面同 app 内），不影响 Chat/Work 对话：

| 事件 | 作用 |
|---|---|
| `UserPromptSubmit` | 未读 settled 摘要（带 session/externalRef 标签）+ 本会话 watch 内 running 进度，注入为 `additionalContext` |
| `SessionStart` | 任务板 bootstrap：running + 未读 settled 概览 |
| `PostToolUse`（async） | `dsh_task_spawn` 回执里的 sessionId 登记进当前 Codex session 的 watch 表 |
| `Stop` | watch 内仍 running → exit 2 续 turn 再查（每 session 上限 10 次 / 20 分钟），settled 即放行 |

**hooks.json 不入仓库**——它是每机本地配置（Codex 会话工作目录根的 `.codex/hooks.json`，如本仓库根或任一 trusted 项目）：command 字段必须写本机 handler 绝对路径，且 Codex 的 hook 信任按哈希逐机记录（`~/.codex/config.toml` 的 `hooks.state`），提交它对任何机器都不省步骤。粘贴即用片段（把 `<handler 绝对路径>` 换成实际路径）。**JSON 里 Windows 路径的反斜杠必须写成 `\\`**：单反斜杠要么让整份 hooks.json 解析失败（`\U`、`\a`、`\d` 都是非法转义），要么被静默解释成控制字符（`\t` 变 TAB、`\n` 变换行）——路径看着没错却指向不存在的文件，hook 无声失效，你只会看到"读回没生效"而没有任何报错。也可整段改用正斜杠（`C:/Users/…/dsh-readback-hook.mjs`），Node 在 Windows 上同样接受：

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

纪律：只读端点（list/progress）、fail-open（任何错误输出 `{}` 不挡 turn）、注入 ≤2KB 且带「非用户指令」包裹、token 惰性读 `~/.dsh/task-bridge-token`、状态文件在仓库外 `~/.dsh/readback-hook-state.json`。**fail-open 的代价是故障静默**：token 文件缺失/为空时 hook 同样只输出 `{}`、不注入也不报错，现象是"读回没生效"而不是任何错误——先确认 token 文件在位（见「① 之前」）。`DSH_READBACK_DISABLED=1` 一键停用。首装需 Codex 信任审查（哈希信任制，CLI `/hooks` 可查看来源）；仓库级 hooks 仅在项目 trusted 时加载。残余风险：注入内容源自 DSH 会话输出，与任何工具读取内容同属注入载体类别——包裹声明其性质，非机械防线。

边界：hook **不唤醒空闲会话**——注入发生在开口/会话启动时；Chat/Work 对话的读回仍是 turn 内 wait 自链（人工唤起），或桌面原生「定时任务」（时间驱动轮询，纯 app 内）。

## 排障速查

| 现象 | 含义 | 处置 |
|---|---|---|
| "工具列表里没有 dsh_task_*" | connector 没挂进这个对话 | 新对话 + 启用 connector（缓存怪癖） |
| 43120 返回 404 | 桥开关关闭，或 DSH 刚启动插件组未就绪 | GUI 开开关；刚启动则等几秒重探 |
| 43120 ECONNREFUSED | 宿主不在跑，或正处于重启窗口（GUI 动插件/手动重启会令宿主重启数十秒） | 等 30–60s 重探；仍拒连则启动 DSH |
| 401 unauthorized | token 不对 | 核对 `~/.dsh/task-bridge-token` 与 bridge-mcp 读取路径 |
| 43120 返回 **503** `bridge token is unavailable` | token 文件不存在/不可读/为空（coordinator < 0.27.2 不会自动生成） | 按「① 之前」建文件；自定义路径时核对 GUI「Token 文件路径」与 bridge-mcp 侧读取路径一致 |
| /api/status probe 非 ok | bridge-mcp stdio 起不来 | 看 tunnel-client 日志里该 channel 的 stderr |
| doctor FAIL / command 起不来，但路径看着是对的 | `command:` 里用了 Windows 反斜杠，被当转义符吃掉（`D:\git\x` → `D:gitx`），报错只说 "script not found" | 全改正斜杠 `D:/git/x`；或套 **YAML 单引号**让反斜杠字面存活（YAML 双引号里 `\g` 本身还是非法转义）；`log.file` 同理 |
| doctor / run 报端口被占，进程直接退出 | `health.listen_addr` 冲突（默认 8080）。注意 **doctor 自己也会 bind 这个端口**，校验在用的 profile 会跟生产实例抢 | 换端口，或用 `127.0.0.1:0` + `url_file`；校验生产 profile 前先复制一份改端口 |
| 请求间歇性丢失或走错实例、无法复现 | 同一个 `tunnel_id` 跑了多个 tunnel-client 实例——那是**抢单**不是冗余 | 只留一个实例；要多实例就各自独立 `tunnel_id` + `listen_addr` + `log.file` |
| npx 形态下 MCP 握手超时 / 子进程秒退 | 包未发布到 npm registry（`npx -y` 拉不到），或首跑联网下载超时 | 改用全局安装的 shim 名或 `node <绝对路径>` 形态 |

## 安全模型

回环 + token 是唯一防线：路由只接受本机来源与正确 `X-Task-Bridge-Token`（常量时间比较）；spawn 另有 60s/10 次策略闸。**关就是关**——开关关闭 5s 排空后卸载全部路由，外部立刻 404，不存在"关了还留着后门路由"的形态。桥不假设宿主恒回环：webserver 绑定 `0.0.0.0` 时挂载期强告警，逐请求回环守卫才是真防线。
