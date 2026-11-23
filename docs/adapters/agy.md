# agy 适配(调研与探针实测)

状态:调研与真实账号探针已完成,还没有产品代码。调研日期 2026-11-23(CYCL-157),真实账号探针日期 2026-11-23(CYCL-168),均属于 epic CYCL-153。

**agy 是什么**:Google Antigravity 的命令行 agent(Antigravity CLI),命令名就是 `agy`。确认证据:

- 本机 `/Users/james/.local/bin/agy`,初测时 `agy --version` 为 1.5.12,同日后台自升级至 **1.5.15**;`agy acp --help` 里数据目录默认值是 `antigravity-cli`,`initialize` 的 `agentInfo.name` 是 `Antigravity ACP Server`。【实测】
- 官方 README 的安装命令、默认安装位置(`~/.local/bin`)与本机一致:<https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/README.md>。【文档】
- 仓库里已有的说法("后续 codex、agy 等并列在此",`docs/architecture.md`;`.agents/notes/2026-11-19-workspace-layout-and-direct-acp-sdk.md`)把它和 Codex 并列为一个 agent harness。

**结论一句话**:不自己包 SDK,也不驱动终端界面;用官方的 `agy acp --process-per-session`(ACP **v1** 的 stdio 服务器),前面放一个薄的 `harness/agy`,把 v1 翻成 daemon 说的 ACP v2,并负责环境隔离、版本下限和 Cycle 的扩展。二进制不随 Cycle 分发,用机器上装的。

## 证据的标记

- 【实测】:2026-11-23 在本机(macOS arm64)用 agy 1.5.15 跑出来的(未登录基线部分用 1.5.12 测过并在 1.5.15 上复核)。全部探针均在隔离的临时 `HOME` 和临时工作目录里运行,环境只有 `HOME`、`PATH`、`TMPDIR`,通过 `agy acp --login` 在隔离目录里完成登录,没有动真实的 `~/.gemini`,也没有读取、保存或转发任何凭证。
- 【文档】:官方文档或发行说明里写的,带地址。发行说明来自 `agy changelog`(1.5.3 到 1.5.11)。

## 1. 怎么接

| 方式                                                                                                       | 现状                                                                                                                                                                                                                                                                            | 取舍                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`agy acp`(官方 ACP 服务器)**                                                                             | 随 CLI 发布,stdio 上的 JSON-RPC,ACP 协议版本 1;Zed、JetBrains、Android Studio、Xcode 都这样接。【文档】<https://antigravity.google/docs/ide/extensions/acp/> 每个版本的发行说明里都有它的修复(1.5.4、1.5.8、1.5.9、1.5.10),说明在积极维护,也说明还在收敛。                      | 覆盖权限请求、恢复、模式、配置项、图片、插入、表单、用量、命令列表、标题、HTTP/stdio MCP。**选它。**                                                                            |
| 无界面模式 `agy -p --output-format stream-json`(可加 `--input-format stream-json` 在一个进程里跑多个回合)  | 【文档】<https://antigravity.google/docs/cli/headless>                                                                                                                                                                                                                          | 不能用:输入只收 `text` 块(没有图片);没有审批通道,要不到的批准被"软拒绝"后继续跑;`control_request`/`control_response` 直接报错退出;CLI 自己处理的斜杠命令在流里失败。只适合 CI。 |
| Antigravity SDK(Python 包 `google-antigravity`)                                                            | 【文档】<https://antigravity.google/docs/sdk/overview/> 文档只写了 `GEMINI_API_KEY` 和 Gemini Enterprise(ADC)两种凭证,没说能用 CLI 的账号登录;许可和成熟度未写明。                                                                                                              | 不用:要带 Python 运行时;用不上用户的订阅账号;它是"自己造 agent"的库,不是"接 agy"。                                                                                              |
| 第三方桥(`agy-acp`、`antigravity-acp`、`agy-acp-bridge` 等,多数是用 PTY 包住终端界面,或读本地的会话数据库) | 都出现在官方 ACP 之前或并行;论坛上的答复说"直接连官方 ACP 服务器是受支持的路径":<https://discuss.ai.google.dev/t/clarification-request-is-local-ipc-pty-wrapping-of-agy-cli-for-open-standard-editor-bridges-e-g-acp-tos-compliant/175905>(答复者是否 Google 员工,页面上看不出) | 不用。多一层别人的代码,而且条款风险更大(见 §2)。                                                                                                                                |
| 自己驱动终端界面                                                                                           | —                                                                                                                                                                                                                                                                               | 不用。                                                                                                                                                                          |

### 为什么还要一个 `harness/agy`,不能让 daemon 直接连 `agy acp`

1. **协议版本**。daemon 对 agent 只说 ACP v2(`@agentclientprotocol/sdk/experimental/v2`,AGENTS.md)。`agy acp` 被问到 `protocolVersion: 2` 时回 `protocolVersion: 1`【实测】。两版协议的关键差异已全部实测确认【实测】:
   - v1 的 `session/prompt` 到回合结束才应答(带 `stopReason` 和 `usage`),且不回显 `user_message`;v2 立即返回 `messageId`,回合以带 `stopReason` 的 `state_update: idle` 结束(protocol.md §8)。桥要自己生成 `messageId`、发 `user_message` 和 `running`,在最后一个在途 `session/prompt` 应答到来时发 `idle`。
   - v1 的 `tool_call` 加 `tool_call_update` → v2 的 `tool_call_update`;`current_mode_update` → `config_option_update`;v1 的思考强度配置项 id 是 `thought_level`,要映射成 Cycle 的 `effort`。
   - v1 没有 `state_update`、`subagent_update`、`requires_action`。
2. **环境**。agent 不继承环境变量(红线)。`processAgent` 给适配进程的环境是白名单,适配进程再给 agy 一份完整的、显式的环境(和 Claude 的 `CYCLE_ADAPTER_CONFIG.env` 同一个做法)。
3. **Cycle 的扩展**:`_meta["cycle/sessionId"]`(agy 忽略,见 §3)、`cycle/steer`、`cycle/hadTurn`、`cycle/trusted`、`cycle/efforts`,以及工具结果的 `cycle/toolResult`。
4. **版本漂移**。agy 自己在后台升级(§2),桥是唯一能挡住它的地方:读 `agentInfo.version`,低于下限就报不可用;不认识的更新种类丢掉并记日志,不让 daemon 看到 v1 的东西;过滤 agy 重复发出的相同 `available_commands_update`。

桥要自包含、传输可替换(AGENTS.md):它只认 stdin/stdout 和一份 JSON 配置,agy 的路径和环境都由外面给。

### 进程模型与内存实测

- `agy acp` 必须带 `--process-per-session`:每个 session 一个隔离的 worker 进程,并且只有带了它,`initialize` 才声明 `mcpCapabilities.http: true`【实测】(文档:"required for HTTP MCP servers the editor configures"),connector 网关要靠它(§4)。
- **内存与耗时实测**(2026-11-23,macOS arm64,agy 1.5.15,Gemini 4 Hydrogen,1 个短回合)【实测】:

| 状态                                  | agy 进程数 | 总 RSS | 构成与耗时                                                    |
| ------------------------------------- | ---------: | -----: | ------------------------------------------------------------- |
| 0 个 session(front 进程空闲)          |          1 | 126 MB | `initialize` 约 63 ms                                         |
| 1 个 session                          |          2 | 329 MB | front 126 MB + worker 203 MB;`session/new` 1.9 s,首回合 4.2 s |
| 3 个并发 session(共享 1 个 front)     |          4 | 725 MB | front 126 MB + 3 个 worker(各 196–203 MB)                     |
| 关掉其中 2 个(`session/close`)后 1.5s |          2 | 322 MB | `session/close` 立即退出对应 worker,释放约 200 MB/个          |

- **和 daemon 现有 `processAgent` 的对应**:daemon 当前不跨 session 复用 agent 进程(`docs/daemon.md`),即一个活跃 agy session = 1 个适配进程(约 45 MB) + 1 个 `agy acp` front(126 MB) + 1 个 worker(200 MB) ≈ **370 MB**,和 Claude 单 session(约 350 MB,见 `docs/daemon.md`)相当;空闲超过 `idle.agentMinutes`(默认 10 分钟)由 daemon 整体杀掉回收。若后续多 session 并发对 4 GB 目标机压力大,再考虑改为单 daemon 复用一个 `agy acp` front(每多一个 session 只增 200 MB)。
- 打算带的参数:`acp --process-per-session --log-file <dataDir>/logs/agy-acp.log`,按配置加 `--sandbox`、`--agent <名字>`。`--disable-telemetry` 带不带是产品决定(§6 待定)。`--dangerously-skip-permissions` 不带。

## 2. 安装和登录

### 二进制:用机器上的,不随 Cycle 分发

- **大小**:macOS arm64 的 `agy` 是单个 Mach-O,216 MB【实测】;Linux x64 的发布包(tar.gz)101 MB【实测,HEAD 请求】。daemon 的可执行文件现在约 480 MB,每个平台再加 100–216 MB。
- **许可**:专有软件。条款 <https://antigravity.google/terms> 里没有再分发的授权(整篇没有 redistribute、license 这些词)【文档】。没有授权就不能打进我们的安装包。
- **它自己升级**:安装脚本写着"automatically self-updates in the background during regular runs"【实测,读的是 <https://antigravity.google/cli/install.sh>】。2026-11-23 当天本机就从 1.5.12 在正常使用后自动后台升级到了 1.5.15【实测】。随包带一份会和它的自升级打架。
- 平台:macOS、Linux(amd64、arm64,含 musl)、Windows,64 位【实测,安装脚本】。

所以:

- 查找顺序:`config.json` 的 `agy.executable` → `~/.local/bin/agy`(真实用户的 home,官方安装位置)→ daemon 的 `PATH`。agy 的 `Harness.binary` 不设(打包清单里没有它)。
- 找不到,或版本低于下限时,`available` 为 `false`,客户端显示怎么装(官方的一行安装命令),Cycle 不替用户装。
- 版本下限建议 **1.5.10**:它修了"回合结束后 agent 被后台任务叫醒,消息要到下一个 prompt 才送达"和"取消后子 agent、后台任务还在跑"【文档,发行说明】;1.5.9、1.5.4 修了登录回退、第二次审批挂住、恢复后模式丢失。
- 代价:Claude 是"装了 Cycle 就能用",agy 是"先装 agy"。远程环境同样(见下)。

### 条款风险(已拍板)

决定见 [2026-11-23-agy-terms-distribution-and-telemetry.md](../../.agents/notes/2026-11-23-agy-terms-distribution-and-telemetry.md)(CYCL-169)。

条款第 6 条【文档,转述】禁止第三方软件通过提取/转发 OAuth 凭证或非官方方式访问服务;另一面,官方文档专门有一页教"其他编辑器"以子进程启动 `agy acp`,并说登录和设置沿用 CLI 的【文档】<https://antigravity.google/docs/cli/acp/>。

Cycle 作为本地应用启动未修改的官方二进制、说公开的 `agy acp` 协议、且**永远不读、不存、不转发 agy 的凭证**(适配红线),确认可以接入并随 Cycle 发布;同时确认**不随包分发二进制**(用机器上已安装的 `agy`)、默认不传 `--disable-telemetry`(仅当 `config.json` 中显式配置 `agy.telemetry: false` 时传,测试和探针仍显式关闭)。

### 登录状态能不能隔离在 Cycle 的数据目录里

**实测结论(macOS)**:**可以完全隔离在 `$HOME`(`<dataDir>/agy`)里,不与宿主串号,且重启后持久化有效**【实测】:

- **状态目录隔离**:agy 的全部文件落在 `$HOME/.gemini/` 下:`antigravity-cli/`(`settings.json`、`conversations/`、`conversation_summaries.db`、`brain/`、日志、内置 skill)和 `config/`(`mcp_config.json`、`plugins/`、`agents/`)。把 `HOME` 指到 `<dataDir>/agy`,真实的 `~/.gemini` 不会被碰【实测】。(注意:`--gemini-dir` 只有 `acp` 子命令有,`agy plugin`、`agy models` 没有,所以统一用 `HOME=<dataDir>/agy`。)
- **宿主已登录时,干净的隔离目录仍未登录**:宿主已完成 `agy` 登录(`~/.gemini/antigravity-cli` 已存在)后,用全新隔离 `HOME` 启动 `agy acp`,`session/list`、`session/new` 仍返回 `-32000 Authentication required`(日志:`Auth mode is unspecified` → `Silent sign-in failed`)【实测】。
- **凭证落盘位置与持久化**:在隔离 `HOME` 下跑 `agy acp --login`,由于隔离 `HOME` 下没有 `Library/Keychains`,系统钥匙串写入 5 秒超时后自动回退到文件存储(`composite_token_storage`),把凭证写入 `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`,并在 `cache/acp-auth-state.json` 写入 `{"methodId":"oauth-personal"}`【实测】。
  - 重启 `agy acp` 进程后,silent sign-in 在约 11 ms 内读取该 token 并认证成功,登录持久有效【实测】。
  - 再新建第二个干净隔离 `HOME`,即便把 `cache/acp-auth-state.json` 拷进去(不带 `antigravity-oauth-token`),仍返回 `-32000 Authentication required`,证明凭证未漏进系统公共钥匙串、未与宿主或其他目录共享【实测】。
- **无界面 Linux(ssh 上的 daemon)**:本次探针环境为 macOS,未在无界面 Linux 机器上实测;但 agy 内部是同一套 `composite_token_storage`(Secret Service 不可用时回退写入 `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`),且默认白名单不传 `DBUS_SESSION_BUS_ADDRESS` 时天然与宿主 Secret Service 隔离。首次在 Linux 远程环境集成测试时再复核一次即可。
- **不走账号的两条路**(都只能经显式白名单进入 agy 的环境,不从 daemon 继承):
  - `GEMINI_API_KEY`,加 `settings.json` 的 `"modelProvider": "gemini"`【文档】。按量计费,没有账号额度。
  - ADC:`AGY_ADC_AUTH=true`,可选 `GOOGLE_CLOUD_QUOTA_PROJECT`、`GOOGLE_CLOUD_LOCATION`【文档】。它读 gcloud 的凭证文件,位置跟 `HOME` 走,隔离后要另外处理。
- `initialize` 报的登录方式:`oauth-personal`、`oauth-business`、`gemini-api-key`、`agent-platform`;能力里有 `auth.logout`【实测】。

### `cycle login agy`

`agy acp --login`【实测】:在终端打印 Google OAuth 链接并提示 `Then paste the authorization code, or the full URL of the page you land on, and press Enter:`,不需要本机浏览器回调,本地和 ssh 远程体验完全一致。粘贴授权码后约 5 秒(等待钥匙串超时并回退文件存储)完成退出。

这正好对应 `Harness.cli.login: ["acp", "--login"]`。未登录时,桥把 `-32000` 原样作为"需要登录"报上去(protocol.md §11),客户端提示 `cycle login agy`。

### 远程环境(daemon 在 ssh 那一头)

- agy 要装在远程机器上;官方安装脚本支持 Linux amd64、arm64,README 说它适合 ssh【文档】。Cycle 的远程引导不带它,`available: false` 加安装提示。
- 登录:上面的粘贴授权码流程,不需要转发端口。
- 凭证:走隔离 `HOME` 下的文件后备(`$HOME/.gemini/antigravity-cli/antigravity-oauth-token`),不需要给白名单放行 `DBUS_SESSION_BUS_ADDRESS`。
- `auto` 模式要终端沙箱;容器或禁了非特权用户命名空间的 Linux 上没有沙箱,`auto` 不提供,退回 `default`【文档】<https://antigravity.google/docs/cli/modes/>。
- 云端 sandbox:桥是自包含的,但 agy 的二进制和登录都要在 sandbox 里另外解决,不在这次范围。

## 3. 会话

- **id 只能关联,不能复用**。agy 的 `session/new` 自行生成 UUID 作为 `sessionId`,与磁盘上的会话文件 `$HOME/.gemini/antigravity-cli/conversations/<sessionId>.db`(SQLite)一致【实测】。桥忽略 `_meta["cycle/sessionId"]`,返回 agy 的 id;daemon 看到它和提议的不同,记成 `agentSessionId`(protocol.md §6 第 3、4 条,`daemon.ts` 已支持)。客户端仍只见 Cycle 的 `sessionId`。
- **能恢复且不重放**。`initialize` 声明 `sessionCapabilities: {resume, close, load, list, additionalDirectories}`【实测】。实测 `session/resume` 不重放历史(仅发 `available_commands_update` 和 `session_info_update`),后续 prompt 能记住前文【实测】。`load` 会重放,不用。
- **0 回合空会话的恢复**:新建后未发过 prompt 的会话不会出现在 `session/list` 里,但磁盘已建 `.db`,重启 `agy acp` 后对其调 `session/resume` **直接成功**【实测】。
- **不存在的会话与 `cycle/hadTurn`**:对不存在的 UUID 调用 `session/resume`,agy 返回 JSON-RPC 错误 **`-32603`**(`"Failed to read session <id>; retry, or load it with session/load"`)【实测】。
  - 有过回合(`cycle/hadTurn: true`)且恢复失败时:桥报错误,daemon 转成 `-32013`。
  - 没发过回合(`cycle/hadTurn` 未设)且恢复失败时(例如 `.db` 被手工清掉):若桥回退调用 `session/new`,会产生新的 `agentSessionId`。**已查 `apps/daemon/src/daemon.ts` 第 762–812 行**:当前 daemon 在 `session/resume` 时**不读取**返回的 `sessionId`,仍沿用索引里旧的 `agentSessionId`。在 CYCL-173 中需给 daemon 补上"恢复结果带新 `sessionId` 且不同时更新索引里的 `agentSessionId`",否则回退新建后跑过回合、再次重启会找不到会话。
- **`session/list` 返回形状**:只列有过回合的会话,每项 `{ sessionId, cwd, title, updatedAt }`【实测】,按 `cwd` 过滤。
- **恢复后的配置**:【实测】重启 `agy acp` 后调用 `session/resume`,**`mode`、`model`、`thought_level` 全部重置回默认**(`default`、`gemini-4-neon`、`high`)——连 `mode` 也没有保留。因此必须依靠 daemon 在恢复时按索引重发 `session/set_config_option`(daemon 已有此逻辑)。
- **agent 侧的清理**:`session/delete` 是 daemon 的事;agy 那边的 `.db` 文件留着(Claude 也是)。能力里没有 delete。

## 4. 能力差异

"映射"指能落到 Cycle 现有协议上,不用改 L1。以下除特别注明外均为 agy 1.5.15 【实测】结论。

| 能力                      | agy 实测行为                                                                                                                                                                                                                                                                                                                                                                                                | 映射                                                                                                                                                    | 实现注意点 / 不做的部分                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限请求                  | `session/request_permission` 给两个选项:`{ optionId: "allow", name: "Allow", kind: "allow_once" }` 和 `{ optionId: "deny", name: "Deny", kind: "reject_once" }`。没有 `allow_always`。编辑工具的 `toolCall.content` 带变更片段 `diff` 和 `locations`                                                                                                                                                        | 能,直接转(protocol.md §9)                                                                                                                               | 只转 agy 给的选项,不自己编造 `allow_always`                                                                                                                                                   |
| 计划模式                  | `mode` 选项里确有 `plan`。进入后 agent 只读探查,通过 `write_file` 往 `$HOME/.gemini/antigravity-cli/brain/<sessionId>/implementation_plan.md` 写计划(触发普通 `session/request_permission` 带 `diff`),随后用普通文字请用户批准并结束回合(`stopReason: "end_turn"`),不发专门的批准请求,也不自动切模式                                                                                                        | `mode` 配置项的一个值                                                                                                                                   | 不需要特殊协议。若未来版本批准后 agy 自己切模式,桥仍把 `current_mode_update` 转成 `config_option_update`                                                                                      |
| 任务列表(`plan_update`)   | ACP 会话中未向模型暴露 `update_steps` / `TodoWrite` 工具,实测不发 `plan` 更新                                                                                                                                                                                                                                                                                                                               | 若收到 v1 的 `plan` 更新则转成 `plan_update`                                                                                                            | 防御性映射即可,当前版本实际不会触发                                                                                                                                                           |
| 插入(steer)               | 回合中发第二个 `session/prompt`:第一个 `session/prompt` 在约 6 ms 内立即以 `stopReason: "end_turn"` 应答(工具仍在后台继续执行),后续全部更新归并到同一回合,最终由第二个 `session/prompt` 以 `stopReason: "end_turn"` 应答。插入后立即发 `session/cancel`:运行中工具报 `status: "failed"`,第二个 `session/prompt` 在 6 ms 内以 `stopReason: "cancelled"` 应答,无泄露输出                                      | 能:`steer: true`;daemon 平时排队,带 `cycle/steer` 时在回合中转给桥                                                                                      | 桥维护 `inFlightPrompts` 计数:收到插入立即发该条的 `user_message` 并计数 +1,每个 `session/prompt` 应答到来时计数 -1,**仅当归零时发一条带 `stopReason` 的 `idle`**。取消竞态干净,无需杀 worker |
| agent 自己开始的回合      | 对子 agent(`invoke_subagent`)、一次性定时器(`schedule`)、后台化命令(`run_command` 短超时),agy 1.5.15 都会**保持原 `session/prompt` 挂起**,直到后台任务结束、agent 醒来并回复完,才统一返回 `stopReason: "end_turn"`                                                                                                                                                                                          | 协议已有(§8"turn 不一定由 prompt 开始")                                                                                                                 | 常规后台任务天然有 `session/prompt` 边界,风险远低于调研预期。对极少数“无在途 `session/prompt` 时到达的更新”(如常驻 cron),桥合成 `running`,并在无活跃工具/待决请求后经静默防抖发 `idle`        |
| 取消                      | `session/cancel`:立即中止未完成的工具(`status: "failed"`)、取消待决请求,以 `stopReason: "cancelled"` 应答                                                                                                                                                                                                                                                                                                   | 能                                                                                                                                                      | —                                                                                                                                                                                             |
| 子 agent                  | `invoke_subagent` 仅作为普通 `tool_call`(`name: "invoke_subagent"`, `kind: "other"`, `in_progress` → `completed`)发出,**不带** `rawOutput`、`content`、`_meta`、子对话 id 或任何子进度事件                                                                                                                                                                                                                  | 只显示为普通工具调用                                                                                                                                    | **不做** `subagent_update`、`_cycle/child_update`、`cycle/background`(ACP v1 未暴露任何子 agent 内部状态)。CYCL-178 按此收敛                                                                  |
| 后台任务、定时、goal      | CLI 有 `/tasks`、`/schedule`、`/goal`,ACP 上无对应结构化事件(`schedule` 也是普通 `tool_call`)                                                                                                                                                                                                                                                                                                               | 不映射,按普通工具调用/未知显示                                                                                                                          | ACP 上没有对应的结构化事件                                                                                                                                                                    |
| MCP(session 给的)         | **Streamable HTTP**(带 `--process-per-session`):`Authorization` 头在 `server/discover`、`initialize`、`tools/list`、`tools/call` 全程原样送达本地网关,无 Google token 泄露;网关回 `401`(无 `WWW-Authenticate`)时重试后放弃,不挂起、不触发 OAuth。**stdio**:`{ name, command, args, env: [{ name, value }] }` 正常工作,`env` 传给子进程,工具调用走权限审批                                                   | 能:桥在 v2 `initialize` 声明 `capabilities.session.mcp.http`,转交 stdio 和 http 条目;拒绝 SSE                                                           | 注意 agy 初始化 MCP 时会先发 `server/discover`,合规服务器对未知方法回 `-32601` 即可(connector 网关需确认不会挂住 `server/discover`)                                                           |
| MCP(agy 自己配置的)       | 用户级 `$HOME/.gemini/config/mcp_config.json`(隔离后为空);项目级 `<cwd>/.agents/mcp_config.json` 在未信任目录中**不会被预加载**                                                                                                                                                                                                                                                                             | 和 Claude 一样:宿主 `~/.gemini` 的用户级配置不可见                                                                                                      | 见下方“文件夹信任”一行                                                                                                                                                                        |
| 图片、文件                | `promptCapabilities: {image: true, embeddedContext: true, audio: false}`。实测 PNG `image` 与文本 `resource` 正常到达模型;**二进制 `resource`(`blob`,如 PDF)会被 agy 静默丢弃**,不报错但模型完全看不到                                                                                                                                                                                                      | 能:`AGY_PROMPT_CAPABILITIES = {image, embeddedContext}`,文本 `resource` 与 `image` 原样转                                                               | **桥必须在转发前以 `-32602` 拒绝带 `blob` 的二进制 `resource`(如 PDF)**,不可放行让 agy 静默吞掉                                                                                               |
| `resource_link`(@ 提及)   | 实测 agy 收到 `file://` 的 `resource_link` 后会主动调用 `read_file` 读取该文件内容                                                                                                                                                                                                                                                                                                                          | 原样转                                                                                                                                                  | 确认可用                                                                                                                                                                                      |
| 思考强度                  | ACP 的 `configOptions` 中 id 和 category 均为 `thought_level`(不是 `effort`),取值 `low`、`medium`、`high`、`xhigh`(显示名 `Extra`),**没有 `max`**。`gemini-4-neon`、`gemini-4-hydrogen` 有 `xhigh`;`gemini-4-carbon` 等只有 `low`/`medium`/`high`;Orchestrator 系列无 `thought_level` 项。给不支持的档位回 `-32602`。切换模型时响应和 `config_option_update` 同步更新可选档位                               | 映射为 Cycle 的 `effort` 配置项;同时从 `session/new` 返回的 `models.availableModels` 与 `configOptions` 算出所有模型的 `cycle/efforts`,不需逐个切换探测 | 桥在 v1 `thought_level` ↔ v2 `effort` 间做键名转换;模型无 `thought_level` 时 `effort` 仅剩 `default`(protocol.md §10)                                                                         |
| 斜杠命令                  | `session/new` 和 `session/resume` 后立刻发出 `available_commands_update`(13 个内置命令/技能,不含 CLI 专属的 `/model`、`/usage`、`/resume`)。发 `/compact` 实际执行压缩;发 `/model` 当普通文本交给模型                                                                                                                                                                                                       | 能:`available_commands_update`                                                                                                                          | agy 建会话和改配置时会连续重复发 3–4 次完全相同的 `available_commands_update`,桥应当去重后再转给 daemon                                                                                       |
| 提问(表单)                | `initialize` 声明 `clientCapabilities: { elicitation: { form: {} } }` 时,`ask_question` 发出标准 `elicitation/create`(`sessionId`、`toolCallId`、`mode: "form"`、`message`、`requestedSchema`,每题含 `qN` 的 `oneOf` 和可选 `qN_other`)。答 `accept` 正常完成;答 `cancel` 时工具收到 `User Skipped` 退回对话。未声明 `elicitation` 时直接把编号选项打在正文里并结束回合(此时 `ask_question` 停在 `pending`) | 能:直接对接 §9 的 `elicitation/create`;daemon 回 `{ action: "cancel", _meta: { "cycle/noClient": true } }` 时桥只把 `{ action: "cancel" }` 交给 agy     | 桥在 v1 `initialize` 中声明 `elicitation: { form: {} }`;回合结束时如有滞留 `pending` 的工具调用须收尾                                                                                         |
| 上下文用量                | `usage_update`(`used`、`size`,如 `1048576`)在建会话后及每次模型调用后发送;`session/prompt` 应答还带 `usage`(`inputTokens`、`outputTokens`、`cachedReadTokens`、`thoughtTokens`、`totalTokens`),无费用                                                                                                                                                                                                       | 能:`usage_update` 的 `used`、`size`,不带 `cost`,无 `cycle/context`                                                                                      | 桥可保留每次变化(或按回合节流,CYCL-177 定)                                                                                                                                                    |
| 套餐用量                  | `session/new` 返回 `_meta.antigravity.tier` 仅是订阅档位(`Google AI Ultra` 等),ACP 上**不提供**五小时/每周额度                                                                                                                                                                                                                                                                                              | 不做 `_cycle/plan_usage`                                                                                                                                | ACP 未暴露该数据,不去解析 CLI 文本输出                                                                                                                                                        |
| 标题                      | `session_info_update` 自动生成标题(如 `"Edit And Run Hello.txt"`)                                                                                                                                                                                                                                                                                                                                           | 能:`session_info_update`                                                                                                                                | —                                                                                                                                                                                             |
| 追加系统提示              | `session/new` 请求带 `_meta: { antigravity: { systemPrompt: { append: "..." } } }` 实测生效                                                                                                                                                                                                                                                                                                                 | 能:把 v2 `systemPrompt` (`append` 模式) 写入 `_meta.antigravity.systemPrompt.append`;拒绝 `override`                                                    | `session/resume` 时同样带上(或核实是否需要)                                                                                                                                                   |
| 附加目录                  | `session/new` 支持 `additionalDirectories`                                                                                                                                                                                                                                                                                                                                                                  | 能                                                                                                                                                      | —                                                                                                                                                                                             |
| 文件夹信任                | 未信任目录中 `session/new` 不报错、`AGENTS.md` 照常加载,但项目级 `.agents/mcp_config.json` **不会被加载**                                                                                                                                                                                                                                                                                                   | `_meta["cycle/trusted"]`:默认不改写 `settings.json`;若后续需要加载受信任项目的 `.agents/mcp_config.json`,再参考 Claude 写 `trustedWorkspaces`           | 第一版不强行写 `settings.json`,避免和 agy 并发写配置冲突                                                                                                                                      |
| 工具结果                  | `edit_file` / `write_file` 完成时 `content` 给整文件 `oldText`/`newText` 的 `diff`,带 `locations`;`run_command` 给 `rawOutput: { output, exit_code }`,stdout 与 stderr 合并(带 `\r\n`),不分离;`read_file` 只给 `locations`(无行范围、无 `content`/`rawOutput`)                                                                                                                                              | ACP 的 `diff`、`locations` 原样转;`run_command` 可从 `rawOutput.exit_code` 填 `cycle/toolResult` 的退出码                                               | stdout/stderr 不拆;`read_file` 不带行范围                                                                                                                                                     |
| 客户端的 `fs`、`terminal` | 不声明 `fs`、`terminal` 时,agy 全部使用自带工具(`read_file`、`edit_file`、`run_command`),无降级                                                                                                                                                                                                                                                                                                             | 桥不声明这两个能力                                                                                                                                      | 已验证无降级                                                                                                                                                                                  |
| 沙箱                      | `--sandbox` 或 `enableTerminalSandbox`;`auto` 模式依赖它【文档】                                                                                                                                                                                                                                                                                                                                            | `config.json` 的 `agy.sandbox`                                                                                                                          | —                                                                                                                                                                                             |
| plugin                    | 实测 `agy plugin list --json` 可用(空时输出 `[]`);`agy plugin --help` 仅含 `list / import / install / uninstall / enable / disable / validate / link`,**没有**可装目录的机器可读列表,也**没有** marketplace 源增删命令                                                                                                                                                                                      | `PluginProvider`(§15)做已装清单、安装、启停、卸载;可装列表与源管理标为不支持                                                                            | plugin 带的 http MCP 服务器能否被 `mcpServers` 同名顶替留到 CYCL-179 实测,在此之前一律 `by: "agent"`                                                                                          |

agy 有、Cycle 现在不接的:Remote Control、Remote Agents(`--remote-agent`)、语音、swarm、teamwork、artifact 审阅、`/rewind`、`/fork`。不声明,不悄悄半支持。

## 5. 配置项

### `configSchema`(给客户端画表单,`cycle/config` 的键)

取值用 agy 自己的原值,不改名(仅在配置项键名上把 agy 的 `thought_level` 映射为 Cycle 统一的 `effort`,以便沿用 daemon 的 `orderedConfigEntries` 和埋点 `settingOf`)。名字和说明在 `harness/agy` 里写一次,ACP 的 `configOptions` 和 daemon 的 `configSchema` 都从它生成。

| 键       | 取值                                                                                                                | 说明                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`   | `default`(先问再做)、`accept-edits`(工作区编辑不问,命令照问)、`auto`(编辑和安全命令不问,高风险问)、`plan`(只读规划) | ACP 里 4 个值的 id 实测即为 `default`、`accept-edits`、`auto`、`plan`【实测】。默认和推荐:`auto`(注:新 session 若不设,agy 实测默认起在 `default`,由 daemon 按默认设置显式切到 `auto`;无沙箱或企业账号不可用时 agy 回落 `default`,桥转发 `config_option_update`) |
| `model`  | 静态只有 `default`(让 agy 自己选);带 `_meta["cycle/open"]`                                                          | 实测 `configOptions` 给出干净的基础模型 id(无档位后缀),且在 Cycle 的 ACP 客户端里同样包含 `claude-opus-5-5`、`claude-sonnet-5-5`、`gpt-oss-120b-medium` 及全部 Gemini 4 / Orchestrator 模型【实测】。不写死,通过 daemon 选项缓存动态叠加到 `model.oneOf` 上     |
| `effort` | `default`(不覆盖)、`low`、`medium`、`high`、`xhigh`(**不含 `max`**)                                                 | 对应 agy 的 `thought_level`【实测】。由 `models.availableModels` 和 `configOptions` 一次性算出各模型的 `_meta["cycle/efforts"]`;Orchestrator 等不支持思考强度的模型对应 `[]`,`effort` 只剩 `default`(protocol.md §10)                                           |

不提供"跳过全部确认":agy 那是进程参数 `--dangerously-skip-permissions`(对应 `toolPermission: always-proceed`),不是会话里能切的模式;要做的话是 `config.json` 里的开关加 `cycle/danger`,先不做。

### `config.json` 的 `agy` 一节(daemon 的配置,不经协议修改)

- `executable`:agy 的路径;不设按 §2 的顺序找。
- `home`:给 agy 的 `HOME`,默认 `<dataDir>/agy`。要用宿主已有的登录和设置,有意地指到真实的 home。
- `allowEnv`、`env`:环境白名单和显式的值(`GEMINI_API_KEY`、`AGY_ADC_AUTH`、代理变量等)。默认只放行 `PATH`、`LANG`、`LC_ALL`、`TERM`、`TMPDIR`,再由适配显式注入 `HOME`(不放行 `DBUS_SESSION_BUS_ADDRESS`,保持与宿主钥匙串隔离)。
- `sandbox`:布尔,对应 `--sandbox`。
- `agent`:对应 `--agent`(agy 的自定义主 agent)。
- `telemetry`:布尔,为 `false` 时带 `--disable-telemetry`。

## 6. 待定和风险(含探针结论)

1. **登录隔离(§2)——已实测解决(macOS)**:隔离 `HOME` 不会漏进宿主登录,且 `agy acp --login` 自动回退到 `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`,跨重启持久化、不同隔离目录互不可见。无界面 Linux 留待首次远程集成测试复核。
2. **条款第 6 条(§2)——已拍板(CYCL-169)**:见 [2026-11-23-agy-terms-distribution-and-telemetry.md](../../.agents/notes/2026-11-23-agy-terms-distribution-and-telemetry.md),作为本地应用走官方 `agy acp` 协议、不碰凭证允许发布,不随包分发二进制。
3. **真实回合协议细节(§4)——已实测解决**:steer(首请求 6 ms 应答 + 取消干净)、plan 模式(写计划 artifact + 文字确认)、elicitation(标准 `elicitation/create` + `cancel` 回退)、后台任务唤醒(保持原 `session/prompt` 挂起直到唤醒回合完成)、二进制 PDF 被静默丢弃(桥须拒绝)均已明确。
4. **agy 自己升级**:本机实测当天就从 1.5.12 静默升到 1.5.15。对策是版本下限(1.5.10)、桥里对未知消息宽容、每次都跑的未登录 `initialize` 集成测试。
5. **恢复时 agent 侧的 id 变了(§3)——已查明**:`apps/daemon/src/daemon.ts` 目前在 `session/resume` 时不更新 `agentSessionId`。虽然实测 0 回合会话重启后可直接 `session/resume` 成功,但为兜底 `.db` 丢失且 `hadTurn` 为假时回退 `session/new`,应在 **CYCL-173** 中让 daemon 在 `session/resume` 返回不同 `sessionId` 时更新索引里的 `agentSessionId`。
6. **遥测——已拍板(CYCL-169)**:默认不传 `--disable-telemetry`,仅当用户在 `config.json` 显式设 `agy.telemetry: false` 时传(测试仍显式关闭)。
7. **`--process-per-session` 的代价——已实测**:front 约 126 MB,每个活跃 worker 约 200 MB,`session/close` 立即回收 worker;按 daemon 现有“一 session 一进程”模式单 session 约 370 MB(与 Claude 350 MB 持平),空闲 10 分钟由 `reclaimIdleAgents` 回收。
8. **测试**:没有账号时,集成测试到“未登录返回 `-32000`”为止。单元测试用进程内的假 v1 agent。真实模型的测试照 `test:real` 规矩:凭证只给 agy 进程,不进 CI。测试永远不指向真实的 `~/.gemini`(CYCL-180 写入红线清单)。

## 7. 实现子任务与探针后范围修订(epic CYCL-153)

`CYCL-155`(多 agent 打底)和 `CYCL-168`(探针)已完成,以下按探针结论锁定各项范围:

1. **CYCL-168 agy:真实账号上的探针** — **已完成(2026-11-23,agy 1.5.15)**。
2. **CYCL-169 agy:条款和分发的决定** — 不挡开发,挡发布;需负责人拍板条款、不随包分发及遥测默认值,写 `.agents/notes/`。
3. **CYCL-170 `harness/agy`:v1 到 v2 的桥(核心回合)** — 范围不变;确认 v1 不回显 `user_message`、重复发 `available_commands_update` 需去重、不声明 `fs`/`terminal`、只转发 agy 的 `allow`/`deny` 权限选项、支持 `_meta.antigravity.systemPrompt.append`(拒绝 `override`)。
4. **CYCL-171 daemon:agy 的 harness 条目、查找和环境** — 范围不变;确认 `allowEnv` 不需放行钥匙串/dbus 变量,单 session 进程模型内存约 370 MB 可接受。
5. **CYCL-172 `cycle login agy` 和未登录的提示** — 范围不变;已实测 `agy acp --login` 粘贴授权码流程及未登录返回 `-32000`。
6. **CYCL-173 agy:会话恢复和 id 关联** — **范围微调**:实测 0 回合会话可直接 `session/resume`,但重启后 `mode`/`model`/`thought_level` 全部掉回默认(必须依赖 daemon 重设);不存在的会话报 `-32603`;**新增**:在 `daemon.ts` 中支持 `session/resume` 返回新 `sessionId` 时更新索引的 `agentSessionId`(兜底无回合记录丢失回退 `session/new` 的情况)。
7. **CYCL-174 agy:配置项(模式、模型、思考强度)** — **范围明确**:v1 的 `thought_level` 映射为 Cycle 的 `effort`(无 `max`),由 `models.availableModels` + `configOptions` 一次计算全部模型的 `cycle/efforts`;Orchestrator 等模型无 `thought_level` 选项;ACP 会话能看到第三方模型(Claude/GPT-OSS),全部经选项缓存动态透出。
8. **CYCL-175 agy:插入、提问、agent 自己开始的回合** — **复杂度显著降低**:
   - 插入:按 `inFlightPrompts` 计数,仅归零时发 `idle`;取消竞态干净,不必杀 worker。
   - 提问:直接对接标准 `elicitation/create`,声明 `clientCapabilities.elicitation.form`,无客户端时回 `{ action: "cancel" }` 即可自然退回对话;回合结束时清理滞留 `pending` 工具。
   - 后台唤醒:子 agent / 定时器 / 后台命令均保持原 `session/prompt` 挂起直至完成;桥仅对无在途 `session/prompt` 时到达的意外更新做 `running` + 静默防抖 `idle` 兜底。
9. **CYCL-176 agy:MCP 和 connector 网关** — 范围明确:已实测 `--process-per-session` 下 Streamable HTTP 带 `Authorization` 头与 stdio MCP 均正常,401 无 `WWW-Authenticate` 不触发 OAuth;**新增注意点**:确认 connector 网关对 agy 探测的 `server/discover` 方法立即应答(或回 `-32601`),避免 5 秒预加载超时。
10. **CYCL-177 agy:附件、命令、用量、标题、工具结果** — **新增硬要求**:agy 会静默丢弃二进制 `resource`(如 PDF `blob`),桥必须以 `-32602` 拒绝;去重 `available_commands_update`;`run_command` 仅透传退出码不拆 stderr、`read_file` 无行范围;不做 `_cycle/plan_usage`。
11. **CYCL-178 agy:子 agent 和后台活动的显示** — **范围大幅收敛**:实测 ACP v1 仅发普通 `tool_call`(`invoke_subagent`),无任何子进度、子对话或后台计数;仅按普通工具调用展示,在文档中写明 `subagent_update`/`_cycle/child_update`/`cycle/background` 暂不支持。
12. **CYCL-179 agy:plugin** — 范围明确:基于 `agy plugin list --json` 与 `install/uninstall/enable/disable`,可装清单和源管理不支持;安装本地目录 plugin 时补充验证 plugin 内置 HTTP MCP 能否被 `mcpServers` 同名顶替。
13. **CYCL-180 agy:测试套件、文档和埋点收尾** — 范围不变。

建议顺序:接下来先并行或依次推进 **CYCL-169**(负责人拍板条款/分发/遥测)与最小可运行闭环 **CYCL-170 → CYCL-171 → CYCL-172**;随后推进 **CYCL-173–177**;**CYCL-178** 已收敛为轻量收尾;最后 **CYCL-179**、**CYCL-180**。
