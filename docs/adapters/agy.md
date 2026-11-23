# agy 适配(调研)

状态:调研结论,还没有代码。调研日期 2026-11-23(CYCL-157,属于 epic CYCL-153)。

**agy 是什么**:Google Antigravity 的命令行 agent(Antigravity CLI),命令名就是 `agy`。issue 里只写了 "agy",这一点是按下面的证据认定的,把握很大:

- 本机 `/Users/james/.local/bin/agy`,`agy --version` 为 1.5.12;`agy acp --help` 里数据目录默认值是 `antigravity-cli`,`initialize` 的 `agentInfo.name` 是 `Antigravity ACP Server`。【实测】
- 官方 README 的安装命令、默认安装位置(`~/.local/bin`)与本机一致:<https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/README.md>。【文档】
- 仓库里已有的说法("后续 codex、agy 等并列在此",`docs/architecture.md`;`.agents/notes/2026-11-19-workspace-layout-and-direct-acp-sdk.md`)把它和 Codex 并列为一个 agent harness。

如果 issue 指的不是它,这份文档作废。

**结论一句话**:不自己包 SDK,也不驱动终端界面;用官方的 `agy acp`(ACP **v1** 的 stdio 服务器),前面放一个薄的 `harness/agy`,把 v1 翻成 daemon 说的 ACP v2,并负责环境隔离和 Cycle 的扩展。二进制不随 Cycle 分发,用机器上装的。

## 证据的三种标记

- 【实测】:2026-11-23 在本机用 agy 1.5.12 跑出来的。只跑了只读的命令(`--help`、`changelog`)和一个探针:在临时目录里以 `HOME=<临时目录>`、环境只有 `HOME`、`PATH`、`TMPDIR` 启动 `agy acp --disable-telemetry`,发 `initialize`、`session/new`、`session/list`,然后杀掉。没有登录,没有发过 prompt,没有动真实的 home。
- 【文档】:官方文档或发行说明里写的,带地址。文档页是经抓取工具转述读到的,**逐字引用落地前要对原文**。发行说明是 `agy changelog` 的输出(1.5.3 到 1.5.11)。
- 【推断】:没有来源,是按 ACP v1 的一般行为或上下文猜的。实现前必须先验证,见文末第 1 个子任务。

没有登录过,所以**一个真实的回合都没跑过**。凡是涉及回合里实际消息形状的(权限请求的选项、插入、子 agent、表单、计划模式的批准),都只到【文档】为止。

## 1. 怎么接

| 方式                                                                                                       | 现状                                                                                                                                                                                                                                                                            | 取舍                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`agy acp`(官方 ACP 服务器)**                                                                             | 随 CLI 发布,stdio 上的 JSON-RPC,ACP 协议版本 1;Zed、JetBrains、Android Studio、Xcode 都这样接。【文档】<https://antigravity.google/docs/ide/extensions/acp/> 每个版本的发行说明里都有它的修复(1.5.4、1.5.8、1.5.9、1.5.10),说明在积极维护,也说明还在收敛。                      | 覆盖权限请求、恢复、模式、配置项、图片、插入、表单、用量、命令列表、标题。**选它。**                                                                                            |
| 无界面模式 `agy -p --output-format stream-json`(可加 `--input-format stream-json` 在一个进程里跑多个回合)  | 【文档】<https://antigravity.google/docs/cli/headless>                                                                                                                                                                                                                          | 不能用:输入只收 `text` 块(没有图片);没有审批通道,要不到的批准被"软拒绝"后继续跑;`control_request`/`control_response` 直接报错退出;CLI 自己处理的斜杠命令在流里失败。只适合 CI。 |
| Antigravity SDK(Python 包 `google-antigravity`)                                                            | 【文档】<https://antigravity.google/docs/sdk/overview/> 文档只写了 `GEMINI_API_KEY` 和 Gemini Enterprise(ADC)两种凭证,没说能用 CLI 的账号登录;许可和成熟度没写。                                                                                                                | 不用:要带 Python 运行时;用不上用户的订阅账号;它是"自己造 agent"的库,不是"接 agy"。                                                                                              |
| 第三方桥(`agy-acp`、`antigravity-acp`、`agy-acp-bridge` 等,多数是用 PTY 包住终端界面,或读本地的会话数据库) | 都出现在官方 ACP 之前或并行;论坛上的答复说"直接连官方 ACP 服务器是受支持的路径":<https://discuss.ai.google.dev/t/clarification-request-is-local-ipc-pty-wrapping-of-agy-cli-for-open-standard-editor-bridges-e-g-acp-tos-compliant/175905>(答复者是否 Google 员工,页面上看不出) | 不用。多一层别人的代码,而且条款风险更大(见 §2)。                                                                                                                                |
| 自己驱动终端界面                                                                                           | —                                                                                                                                                                                                                                                                               | 不用。                                                                                                                                                                          |

### 为什么还要一个 `harness/agy`,不能让 daemon 直接连 `agy acp`

1. **协议版本**。daemon 对 agent 只说 ACP v2(`@agentclientprotocol/sdk/experimental/v2`,AGENTS.md)。`agy acp` 被问到 `protocolVersion: 2` 时照样回 `protocolVersion: 1`。【实测】v1 和 v2 的差别正好落在 Cycle 依赖的地方【推断,按两版协议的定义】:
   - v1 的 `session/prompt` 到回合结束才应答(带 `stopReason`);v2 立即返回 `messageId`,回合以带 `stopReason` 的 `state_update: idle` 结束(protocol.md §8)。桥要自己生成 `messageId`、发 `user_message` 和 `running`,在 v1 的应答到来时发 `idle`。
   - v1 的 `tool_call` 加 `tool_call_update` → v2 的 `tool_call_update`;`plan` → `plan_update`;`current_mode_update` → `config_option_update`。
   - v1 没有 `state_update`、`subagent_update`、`requires_action`。
2. **环境**。agent 不继承环境变量(红线)。`processAgent` 给适配进程的环境是白名单,适配进程再给 agy 一份完整的、显式的环境(和 Claude 的 `CYCLE_ADAPTER_CONFIG.env` 同一个做法)。
3. **Cycle 的扩展**:`_meta["cycle/sessionId"]`(agy 用不了,见 §3)、`cycle/steer`、`cycle/hadTurn`、`cycle/trusted`、`cycle/efforts`,以及工具结果的 `cycle/toolResult`。
4. **版本漂移**。agy 自己在后台升级(§2),桥是唯一能挡住它的地方:读 `agentInfo.version`,低于下限就报不可用;不认识的更新种类丢掉并记日志,不让 daemon 看到 v1 的东西。

桥要自包含、传输可替换(AGENTS.md):它只认 stdin/stdout 和一份 JSON 配置,agy 的路径和环境都由外面给。

### 进程模型

一个适配进程起**一个** `agy acp` 子进程,承载这个 daemon 的所有 agy session。带 `--process-per-session`:每个 session 一个隔离的 worker 进程,并且只有带了它,`initialize` 才声明 `mcpCapabilities.http: true`【实测】(文档:"required for HTTP MCP servers the editor configures"),connector 网关要靠它(§4)。空闲释放、内存占用、首个回合耗时:没测。

打算带的参数:`acp --process-per-session --log-file <dataDir>/logs/agy-acp.log`,按配置加 `--sandbox`、`--agent <名字>`。`--disable-telemetry` 带不带是产品决定(§6 待定)。`--dangerously-skip-permissions` 不带。

## 2. 安装和登录

### 二进制:用机器上的,不随 Cycle 分发

- **大小**:macOS arm64 的 `agy` 是单个 Mach-O,216 MB【实测】;Linux x64 的发布包(tar.gz)101 MB【实测,HEAD 请求】。daemon 的可执行文件现在约 480 MB,每个平台再加 100–216 MB。
- **许可**:专有软件。条款 <https://antigravity.google/terms> 里没有再分发的授权(整篇没有 redistribute、license 这些词)【文档】。没有授权就不能打进我们的安装包。
- **它自己升级**:安装脚本写着"automatically self-updates in the background during regular runs"【实测,读的是 <https://antigravity.google/cli/install.sh>】。发布清单在 `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<平台>.json`,2026-11-23 的最新版是 1.5.15,本机是 1.5.12。随包带一份会和它的自升级打架。
- 平台:macOS、Linux(amd64、arm64,含 musl)、Windows,64 位【实测,安装脚本】。

所以:

- 查找顺序:`config.json` 的 `agy.executable` → `~/.local/bin/agy`(真实用户的 home,官方安装位置)→ daemon 的 `PATH`。这是 CYCL-155 的"按 agent 查找可执行文件",agy 的 `Harness.binary` 不设(打包清单里没有它)。
- 找不到,或版本低于下限时,`available` 为 `false`,客户端显示怎么装(官方的一行安装命令),Cycle 不替用户装。
- 版本下限建议 **1.5.10**:它修了"回合结束后 agent 被后台任务叫醒,消息要到下一个 prompt 才送达"和"取消后子 agent、后台任务还在跑"【文档,发行说明】;1.5.9、1.5.4 修了登录回退、第二次审批挂住、恢复后模式丢失。
- 代价:Claude 是"装了 Cycle 就能用",agy 是"先装 agy"。远程环境同样(见下)。

### 条款风险(要负责人确认,不是工程问题)

条款第 6 条【文档,转述,需对原文】:"This includes, but is not limited to, using the Service in connection with products not provided by us." "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement." "Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."

另一面:官方文档专门有一页教"其他编辑器"以子进程启动 `agy acp`,并说登录和设置沿用 CLI 的【文档】<https://antigravity.google/docs/cli/acp/>;论坛答复说未修改的二进制、单用户、不提取或转发 token 是合规的,针对的是拿 OAuth 凭证去调非官方接口和多租户代理。

我们的做法落在后一种:启动未修改的官方二进制、说它公开的协议、不碰它的 token。但条款字面很宽,被封的是用户的 Google 账号。**在对外发布 agy 支持之前,负责人应当读一遍原文并决定**;Cycle 永远不读、不存、不转发 agy 的凭证,这一条写成适配的红线。

### 登录状态能不能隔离在 Cycle 的数据目录里

- **状态目录可以**。agy 的全部文件在 `$HOME/.gemini/` 下:`antigravity-cli/`(`settings.json`、`conversations/`、`conversation_summaries.db`、日志、内置 skill)和 `config/`(`mcp_config.json`、`plugins/`、`agents/`)。把 `HOME` 指到别处,它就在那里新建这一套,真实的 `~/.gemini` 没被碰。【实测】`agy acp --gemini-dir <绝对路径>` 也能挪,和 `HOME` 无关【实测】,但只有 `acp` 子命令有这个参数,`agy plugin`、`agy models` 没有。所以统一用 `HOME=<dataDir>/agy`(和 Claude 的 `HOME ??= CLAUDE_CONFIG_DIR` 同一个思路),不依赖 `--gemini-dir`。
- **全新的隔离目录是未登录的**:`session/new`、`session/list` 回 `-32000 Authentication required`,日志里是 "Silent sign-in failed"。【实测】注意这**不能**证明宿主的登录漏不进来:这台机器上没有 `~/.gemini/antigravity-cli`,agy CLI 多半没在真实 home 里登录过。
- **凭证本身在系统钥匙串里,不在目录里**:Apple Keychain、Linux Secret Service(dbus)、Windows Credential Manager。【文档】<https://antigravity.google/docs/install/> 这是**最大的未知**:
  - macOS 的钥匙串按用户算,不按目录算。Cycle 里的登录和用户自己终端里的 `agy` 登录可能是同一条钥匙串记录:要么互相可见(没隔离),要么互相覆盖。也可能因为 `HOME` 变了而找不到钥匙串。发行说明 1.5.9:钥匙串写入失败后,"saves your sign-in token to its file-based storage for the rest of the session"——有文件存储作后备,但"这次会话内"之后还在不在、文件在哪,没写。
  - 无界面的 Linux(ssh 上的 daemon)通常没有 Secret Service。走不走文件后备、文件是否落在 `$HOME/.gemini` 里,没写。
  - 必须在真实账号上做一次实验才能回答(子任务 1)。在那之前,"agy 的登录隔离在 Cycle 数据目录里"**不能当作成立**。
- 如果实验结果是"钥匙串和宿主共用":这违背 AGENTS.md 的意图(登录要是用户在 Cycle 里有意做的),要回到负责人那里定:接受并明说,还是只支持文件存储能落在目录里的平台。
- 不走账号的两条路(都只能经显式白名单进入 agy 的环境,不从 daemon 继承):
  - `GEMINI_API_KEY`,加 `settings.json` 的 `"modelProvider": "gemini"`【文档】。按量计费,没有账号额度。
  - ADC:`AGY_ADC_AUTH=true`,可选 `GOOGLE_CLOUD_QUOTA_PROJECT`、`GOOGLE_CLOUD_LOCATION`【文档】。它读 gcloud 的凭证文件,位置跟 `HOME` 走,隔离后要另外处理。
- `initialize` 报的登录方式:`oauth-personal`、`oauth-business`、`gemini-api-key`、`agent-platform`;能力里有 `auth.logout`。【实测】文档还列了 `terminal-login`,只给声明了终端登录能力的客户端。

### `cycle login agy`

`agy acp --login`:"Log in with Google interactively, then exit",靠粘贴授权码完成【实测 `--help`;文档】。它不需要本机浏览器回调,所以本地和 ssh 上是同一条命令:在 daemon 那台机器的终端里,用给 agy 的那份环境(`HOME=<dataDir>/agy`)运行它,打印地址,用户在自己的浏览器里登录,把码贴回来。这正好是 CYCL-155 的 `Harness.cli.login`:`["acp", "--login"]`。没有走完过(需要真实账号)。

没有登录时,桥把 `-32000` 原样作为"需要登录"报上去(ACP 已占用这个码,protocol.md §11),客户端提示 `cycle login agy`。

### 远程环境(daemon 在 ssh 那一头)

- agy 要装在远程机器上;官方安装脚本支持 Linux amd64、arm64,README 说它适合 ssh【文档】。Cycle 的远程引导不带它,`available: false` 加安装提示。
- 登录:上面的粘贴授权码流程,不需要转发端口。
- 凭证落在哪:见上面的未知(无界面 Linux 没有 Secret Service)。
- `auto` 模式要终端沙箱;容器或禁了非特权用户命名空间的 Linux 上没有沙箱,`auto` 不提供,退回 `default`【文档】<https://antigravity.google/docs/cli/modes/>。
- 云端 sandbox:桥是自包含的,但 agy 的二进制和登录都要在 sandbox 里另外解决,不在这次范围。

## 3. 会话

- **id 只能关联,不能复用**。agy 自己给会话分配 id(无界面模式里叫 `conversation_id`【文档】;探针目录里出现的会话文件名是 UUID【实测】,但 ACP 的 `sessionId` 是不是同一个值没验证)。ACP v1 的 `session/new` 没有让客户端提议 id 的字段【推断】。所以桥忽略 `_meta["cycle/sessionId"]`,返回 agy 的 id;daemon 看到它和提议的不同,记成 `agentSessionId`(protocol.md §6 第 3、4 条,`daemon.ts` 里已有)。客户端仍只见 Cycle 的 `sessionId`。
- **能恢复**。`initialize` 声明 `sessionCapabilities: {resume, close, load, list, additionalDirectories}`【实测】;文档:"Resuming reopens the conversation without replaying history"。这正是 daemon 要的(`session/resume` 不带 `replayFrom`,历史由 daemon 管)。`load` 会重放,不用。
- **会话记录在哪**:`$HOME/.gemini/antigravity-cli/conversations/` 和 `conversation_summaries.db`【实测,目录存在】,`HOME` 隔离后就在 Cycle 的数据目录里。
- **按工作目录归属**:"scopes conversation histories directly to your current working directory"【文档】<https://antigravity.google/docs/cli/conversations/>。恢复时用创建时的 `cwd`(daemon 本来就这样做)。
- **`cycle/hadTurn`**:桥在恢复失败时区分两种情况。agy 回"没有这个会话"而 daemon 没说有过回合:用 `session/new` 重新开始(这时 id 会变,daemon 要更新 `agentSessionId`——**现在的 daemon 支不支持恢复时换 id 要看一下**);说有过:以错误回应,daemon 报 `-32013`。可以用 `session/list` 先查。【推断:agy 对不存在的会话回什么没测】
- **恢复后的配置**:1.5.4 修了"恢复后模式掉回默认"【文档】。模型和思考强度恢复后是否保留没写,桥按 daemon 重发的配置再设一遍。
- **agent 侧的清理**:`session/delete` 是 daemon 的事;agy 那边的会话文件留着(Claude 也是)。能力里没有 delete。

## 4. 能力差异

"映射"指能落到 Cycle 现有协议上,不用改 L1。

| 能力                      | agy 那边                                                                                                                                                                                                                                                                                                           | 映射                                                                                                                                                                                 | 还缺什么                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限请求                  | ACP 的 `session/request_permission`,客户端看到 Allow 和 Deny;已有的权限规则照常生效,规则放行或拒绝的不问【文档,ACP 页】。1.5.4 修了同一个调用要第二次批准时挂住                                                                                                                                                    | 能,直接转(protocol.md §9)                                                                                                                                                            | 选项的实际 `kind`(有没有"总是允许")没看到;桥只转它给的,不自己加                                                                                                                                                                                         |
| 计划模式                  | 模式之一 `plan`:只读地调查,给出计划"for your approval before writing code"【文档,modes 页】                                                                                                                                                                                                                        | `mode` 配置项的一个值                                                                                                                                                                | **批准这一步在 ACP 上是什么**(权限请求?表单?普通文字?)没写;ACP 会话里有没有 `plan` 也没验证(发行说明只明说了 `accept-edits` 和 `auto`)。批准后 agy 自己切模式的话,桥把 `current_mode_update` 转成 `config_option_update`                                |
| 任务列表(`plan_update`)   | 未知                                                                                                                                                                                                                                                                                                               | v1 的 `plan` 更新 → `plan_update`                                                                                                                                                    | 要看它发不发                                                                                                                                                                                                                                            |
| 插入(steer)               | "Sending a prompt during a turn steers that turn rather than starting a new one"【文档,ACP 页】                                                                                                                                                                                                                    | 能:agent 定义 `steer: true`;daemon 平时排队,只有带 `cycle/steer` 才在回合中转给桥                                                                                                    | v1 里第二个 `session/prompt` 的应答什么时候回来、带什么 `stopReason` 没测;桥要保证只发一条 `idle`,并立即发这条的 `user_message`。取消时还没处理的插入不能事后悄悄运行(protocol.md §8)——agy 怎么处理没写,保守做法是取消后关掉这个 session 的 worker      |
| agent 自己开始的回合      | 后台任务或子 agent 结束后叫醒 agent,回复、工具调用、权限请求"right away"到达(1.5.10)【文档】                                                                                                                                                                                                                       | 协议已有(§8"turn 不一定由 prompt 开始")                                                                                                                                              | v1 没有回合边界的消息:这一轮**怎么知道结束了**没写。桥要合成 `running`…`idle`,这是最容易出错的一处                                                                                                                                                      |
| 取消                      | `session/cancel`:结束未完成的工具调用、放弃待决的权限请求【文档】;1.5.10 起同时停掉子 agent 和后台任务                                                                                                                                                                                                             | 能                                                                                                                                                                                   | —                                                                                                                                                                                                                                                       |
| 子 agent                  | 有:`invoke_subagent`,后台异步,最多嵌套 10 层,权限请求会冒到上层【文档】<https://antigravity.google/docs/subagents/>                                                                                                                                                                                                | 第一步:只当作一次工具调用显示                                                                                                                                                        | ACP v1 没有 `subagent_update`;agy 在 ACP 上给不给子 agent 的进度、对话、id 没写(无界面模式的 `subagent_info` 有 `conversation_id`、`role`,ACP 上未知)。给了才做 `subagent_update` 和 `_cycle/child_update`;`cycle/background` 计数同理。单独停一个:没有 |
| 后台任务、定时、goal      | CLI 有 `/tasks`、`/schedule`、`/goal`                                                                                                                                                                                                                                                                              | 不映射,按"不知道"显示(协议允许)                                                                                                                                                      | ACP 上没有对应的东西                                                                                                                                                                                                                                    |
| MCP(session 给的)         | stdio 是 ACP 基线;带 `--process-per-session` 时声明 `mcpCapabilities.http: true`【实测】;只支持 Streamable HTTP,不支持 SSE【文档】<https://antigravity.google/docs/mcp?tab=cli>                                                                                                                                    | 能:桥在 v2 的 `initialize` 里声明 `capabilities.session.mcp.http`,daemon 就会把 connector 网关的条目(`http://127.0.0.1:<端口>/mcp/<id>` 加 `Authorization` 头)放进 `mcpServers`(§14) | **头有没有原样带上**要实测(agy 自己的配置格式里 http 服务器有 `headers`,所以大概可以);名字里有特殊字符的问题 1.5.9 修过。网关回 401 时 agy 会不会自己去做 OAuth(它支持 MCP 的 OAuth)要看:网关不回 `WWW-Authenticate`,应该不会                           |
| MCP(agy 自己配置的)       | 用户级 `~/.gemini/config/mcp_config.json`,项目级 `<workspace>/.agents/mcp_config.json`,plugin 里的【文档】                                                                                                                                                                                                         | 和 Claude 一样:隔离后用户级的是 Cycle 托管的那份(空的),宿主 `~/.gemini` 里配的看不到;项目级的照常从 `cwd` 加载                                                                       | 文档里写明                                                                                                                                                                                                                                              |
| 图片、文件                | `promptCapabilities: {image: true, embeddedContext: true, audio: false}`【实测】                                                                                                                                                                                                                                   | 能:`AGY_PROMPT_CAPABILITIES = {image, embeddedContext}`,块原样转给 agy                                                                                                               | 图片格式的范围、PDF 的二进制 `resource` 收不收没测;不收的在桥里拒绝,不悄悄丢                                                                                                                                                                            |
| `resource_link`(@ 提及)   | ACP 基线                                                                                                                                                                                                                                                                                                           | 原样转                                                                                                                                                                               | agy 拿到链接会不会去读文件没测                                                                                                                                                                                                                          |
| 思考强度                  | 会话选项 "Thinking level":Low、Medium、High、Extra、Max【文档,ACP 页】;CLI 是 `--effort low\|medium\|high\|xhigh\|max`【实测】。按模型不同:Extra 只有 Gemini 4 Neon、Hydrogen 有,Orchestrator 不能设【文档】<https://antigravity.google/docs/models/>                                                              | 能:`effort` 配置项;每个模型可选的档位放 `cycle/efforts`                                                                                                                              | ACP 上这个选项的 id 和取值没看到;换模型后它会不会重发选项(桥据此算 `cycle/efforts`)没测。有些模型 id 里自带档位(`gemini-4-neon-xhigh`),和 `effort` 怎么相互作用没写                                                                                     |
| 斜杠命令                  | "Slash commands appear in the client's command menu"【文档】                                                                                                                                                                                                                                                       | 能:`available_commands_update`                                                                                                                                                       | CLI 自己处理的那些(`/model`、`/usage`、`/resume`…)在 ACP 里有没有、发了会怎样没测;什么时候发(`session/new` 后还是第一个 prompt 后)没测                                                                                                                  |
| 提问(表单)                | "Agent questions appear as native elicitation forms in clients that support them; otherwise they appear in chat"【文档】                                                                                                                                                                                           | 能:§9 的 elicitation;没有能回答的客户端时 daemon 回 `cycle/noClient`,agy 退回在对话里问                                                                                              | ACP v1 里它用哪个方法名、表单的 schema 长什么样没看到;桥在 v1 的 `initialize` 里要声明对应的客户端能力才会收到                                                                                                                                          |
| 上下文用量                | 1.5.8 起发上下文窗口用量:会话开始或重载时、每次模型调用后、换模型或档位后【文档】                                                                                                                                                                                                                                  | 能:`usage_update` 的 `used`、`size`                                                                                                                                                  | 比 Claude 发得勤(每次模型调用),daemon 都写日志,要不要在桥里合并成每回合一条待定。没有费用(订阅账号),`cost` 不带。各部分占用(`cycle/context`)没有                                                                                                        |
| 套餐用量                  | 账号有每周和五小时的限额,CLI 有 `/usage`【文档】                                                                                                                                                                                                                                                                   | `_cycle/plan_usage` 的形状合适                                                                                                                                                       | ACP 上有没有这个数没写(`initialize` 的 `_meta.antigravity.tier: true` 可能相关,含义未知)。没有就不做,不去解析别的输出                                                                                                                                   |
| 标题                      | "Conversation titles update automatically"【文档】                                                                                                                                                                                                                                                                 | 能:`session_info_update`                                                                                                                                                             | —                                                                                                                                                                                                                                                       |
| 追加系统提示              | `initialize` 的 `_meta.antigravity.systemPrompt.append: true`【实测】                                                                                                                                                                                                                                              | 可能能:protocol.md 只支持 `append`                                                                                                                                                   | 请求里怎么带(哪个 `_meta` 键)没有文档。查不到就在 `session/new` 带 `systemPrompt` 时以 `-32602` 拒绝,不悄悄忽略                                                                                                                                         |
| 附加目录                  | `sessionCapabilities.additionalDirectories`【实测】                                                                                                                                                                                                                                                                | 能                                                                                                                                                                                   | —                                                                                                                                                                                                                                                       |
| 文件夹信任                | `settings.json` 的 `trustedWorkspaces`,由 CLI 管【文档】<https://antigravity.google/docs/cli/reference>                                                                                                                                                                                                            | `_meta["cycle/trusted"]`                                                                                                                                                             | ACP 会话在没信任过的文件夹里会怎样(拒绝?不加载项目配置?)没写。像 Claude 那样由桥去写它的设置文件是最后的办法,先看行为                                                                                                                                   |
| 工具结果                  | 编辑以 diff 给出(1.5.9 修过 diff 里多余的换行)【文档】                                                                                                                                                                                                                                                             | ACP 的 `diff`、`locations` 原样转;`cycle/toolResult` 只在能从它给的东西里算出数字时带                                                                                                | 命令输出分不分 stdout、stderr,读文件带不带行范围:没测,没有就不带                                                                                                                                                                                        |
| 客户端的 `fs`、`terminal` | —                                                                                                                                                                                                                                                                                                                  | 桥不声明这两个能力,agy 用自己的工具读写和跑命令【推断】                                                                                                                              | 确认不声明时它不降级                                                                                                                                                                                                                                    |
| 沙箱                      | `--sandbox` 或 `enableTerminalSandbox`;`auto` 模式依赖它【文档】                                                                                                                                                                                                                                                   | `config.json` 的 `agy.sandbox`                                                                                                                                                       | —                                                                                                                                                                                                                                                       |
| plugin                    | `agy plugin list --json`(`name`、`enabled`、`version`、`source`、`path`、各类组件名)、`install`、`uninstall`、`enable`、`disable`、`import [gemini\|claude]`;官方来源 `antigravity-plugins-official`,安装要先登录;装在 `~/.gemini/config/plugins/<名字>/`【文档】<https://antigravity.google/docs/plugins?tab=cli> | `PluginProvider`(§15)的已装清单、安装、启停、卸载能做                                                                                                                                | "可以装的"清单有没有机器可读的输出没看到(`plugin list` 只列已装的);来源的增删没看到命令行。plugin 带的 http MCP 服务器能不能被 `mcpServers` 里的同名条目顶替(Claude 靠这个把它换成网关)未知,在弄清之前一律 `by: "agent"`。排在最后做                    |

agy 有、Cycle 现在不接的:Remote Control、Remote Agents(`--remote-agent`)、语音、swarm、teamwork、artifact 审阅、`/rewind`、`/fork`。不声明,不悄悄半支持。

## 5. 配置项

### `configSchema`(给客户端画表单,`cycle/config` 的键)

取值用 agy 自己的原值,不改名(和 Claude 的做法一样)。名字和说明在 `harness/agy` 里写一次,ACP 的 `configOptions` 和 daemon 的 `configSchema` 都从它生成。

| 键       | 取值                                                                                                                                                                       | 说明                                                                                                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`   | `default`(先问再做:改文件前看 diff,跑命令前问)、`accept-edits`(工作区内的编辑不问,命令照问)、`auto`(编辑不问,命令在沙箱里跑,出沙箱的由它评估,有风险的才问)、`plan`【文档】 | 默认和推荐:`auto`,和 agy 自己一致(1.5.7 起它在可用的地方默认 `auto`)。`auto` 不是处处都有:要沙箱,且企业账号没有;不可用时 agy 按 `default` 跑。桥看到实际模式不同就发 `config_option_update`,daemon 记下实际的值。ACP 里 `default` 的 id 是什么(设置里是空串)要实测后定                                                                  |
| `model`  | 静态只有 `default`(让 agy 自己选);带 `_meta["cycle/open"]`                                                                                                                 | 可选的模型随账号和套餐变(Gemini 4 Neon/Carbon/Argon/Hydrogen、Gemini 3.8 Flash、Orchestrator,以及一部分客户端才有的 Claude、GPT-OSS)【文档】,不在 Cycle 里写死:取 session 里 agy 报的选项,daemon 的选项缓存叠加到 `model.oneOf` 上(protocol.md §10 已有这个机制)。文档说第三方模型只在几个指名的编辑器里出现,Cycle 多半只看到 Gemini 的 |
| `effort` | `default`(不覆盖)、`low`、`medium`、`high`、`xhigh`、`max`                                                                                                                 | 当前模型不支持时只剩 `default`,规则照 protocol.md §10                                                                                                                                                                                                                                                                                   |

不提供"跳过全部确认":agy 那是进程参数 `--dangerously-skip-permissions`(对应 `toolPermission: always-proceed`),不是会话里能切的模式;要做的话是 `config.json` 里的开关加 `cycle/danger`,先不做。

### `config.json` 的 `agy` 一节(daemon 的配置,不经协议修改)

- `executable`:agy 的路径;不设按 §2 的顺序找。
- `home`:给 agy 的 `HOME`,默认 `<dataDir>/agy`。要用宿主已有的登录和设置,有意地指到真实的 home。
- `allowEnv`、`env`:环境白名单和显式的值(`GEMINI_API_KEY`、`AGY_ADC_AUTH`、代理变量等)。默认只有 `HOME`、`PATH`,以及实验证明必需的(Linux 上 Secret Service 可能要 `DBUS_SESSION_BUS_ADDRESS`、`XDG_RUNTIME_DIR`:放不放进默认白名单,等登录实验的结果)。
- `sandbox`:布尔,对应 `--sandbox`。
- `agent`:对应 `--agent`(agy 的自定义主 agent)。
- `telemetry`:布尔,为 `false` 时带 `--disable-telemetry`。

## 6. 待定和风险

1. **登录隔离**(§2):钥匙串按用户算。结果可能是"隔离不了"。
2. **条款第 6 条**(§2):要负责人看原文后决定,发布前。
3. **没跑过真实回合**:§4 里"还缺什么"一列的每一项。最要紧的三个:agent 自己开始的回合怎么结束、插入时 v1 的应答、计划的批准。
4. **agy 自己升级**:行为会在我们不知情时变。`agy acp` 运行时会不会触发升级、能不能关,没找到说明。对策是版本下限、桥里对未知消息宽容、一个每次都跑的集成测试(对真实的 `agy acp` 做 `initialize`,不需要登录)。
5. **恢复时 agent 侧的 id 变了**(§3):daemon 现在是否允许。
6. **遥测**:默认是否带 `--disable-telemetry`。它是用户和 Google 之间的设置(保存在账号上),Cycle 替用户关还是不管,要定。
7. **`--process-per-session` 的代价**:每个 session 一个 worker,内存没测;不带它就没有 http MCP,connector 用不了。
8. **测试**:没有账号时,集成测试只能到"未登录"为止。单元测试要一个假的 v1 agent(进程内)。真实模型的测试照 `test:real` 的规矩:凭证只给 agy 进程,不进 CI。测试永远不指向真实的 `~/.gemini`(把它加进红线的清单)。

## 7. 建议的实现子任务(epic CYCL-153)

标了"依赖 CYCL-155"的,要等多 agent 的地基:按 agent id 分发的 `adapter` 子命令、`cycle login <agent>`、`config.json` 里以 agent id 为顶层键的一节、按 agent 查找可执行文件和打包清单、埋点认得 agent id(`apps/daemon/src/harness.ts` 的 `Harness`)。

1. **agy:真实账号上的探针**(不依赖 CYCL-155,其余各项的前提)
   - 范围:一次性的脚本,不进产品代码。用隔离的 `HOME` 完成 `agy acp --login`,记录原始的 v1 消息:`session/new` 的应答(id 的格式、模式、配置项的 id 和取值)、一个带工具调用的回合、权限请求的选项、回合中再发一个 prompt、`plan` 模式到批准、一次子 agent、一次提问、后台任务叫醒 agent 的那一轮、`session/resume`(进程重启后)、带 `Authorization` 头的 http MCP 条目、图片和文本附件、不存在的会话的恢复、没信任过的文件夹。另:登录后凭证落在哪(macOS 钥匙串还是文件;无界面 Linux 上);宿主已登录时隔离目录是否仍未登录;重启后登录是否还在。
   - 完成标准:本文件里每个"没测""未知""推断"要么改成实测结论,要么写明做不到及原因;§6 第 1、5、7 条有答案;据此确认或修改下面各项的范围。
2. **agy:条款和分发的决定**(不依赖 CYCL-155)
   - 范围:负责人读 <https://antigravity.google/terms> 原文,决定能不能发布、要不要在界面上向用户说明;确认"不随包分发"。
   - 完成标准:一篇决定笔记(`.agents/notes/`),本文件 §2 引用它。
3. **`harness/agy`:v1 到 v2 的桥(核心回合)**(依赖 CYCL-155)
   - 范围:新包 `@cycle/harness-agy`;启动 `agy acp`(路径和环境只来自配置);`initialize`、`session/new`、`session/prompt`(立即返回 `messageId`,发 `user_message`、`running`、带 `stopReason` 的 `idle`)、流式文字和思考、工具调用、`session/request_permission`、`session/cancel`、`session/close`;agy 退出时结束未完成的回合和请求;版本下限。
   - 完成标准:单元测试用进程内的假 v1 agent 覆盖以上每一项和取消的竞态;`bun run check` 通过;不导入 `experimental/v2` 之外的 ACP 入口的规则怎么容纳 v1 类型,有结论(自己定义最小的 v1 类型,或改门禁并写笔记)。
4. **daemon:agy 的 harness 条目、查找和环境**(依赖 CYCL-155)
   - 范围:`HARNESSES` 里加 agy;`config.json` 的 `agy` 一节(§5);可执行文件查找和 `available`(找不到、版本太低);`HOME` 隔离和环境白名单;`configSchema`、`promptCapabilities`;`docs/daemon.md`、`docs/protocol.md` §10 的 agent 示例。
   - 完成标准:`_cycle/agents/list` 列出 agy,没装时 `available: false`;单元测试检查实际传给 agy 的环境里没有 daemon 的变量、`HOME` 是数据目录下的;集成测试(不需登录):经 daemon 启动真实的 `agy acp`,`session/new` 得到"需要登录"的错误而不是崩溃。
5. **`cycle login agy` 和未登录的提示**(依赖 CYCL-155)
   - 范围:`Harness.cli`(`login: ["acp", "--login"]`);`-32000` 一路报到客户端并提示怎么登录;桌面端在 agent 不可用或未登录时显示安装或登录的办法(含埋点)。
   - 完成标准:隔离目录里跑 `cycle login agy` 出现授权地址(到用户授权前为止可自动验证);未登录时新建 agy 会话,界面给出的是登录提示;事件进了字典。
6. **agy:会话恢复和 id 关联**(依赖 3、4)
   - 范围:`session/resume`(不重放、响应前发状态快照)、`cycle/hadTurn` 的三种情况、恢复时重设配置、`agentSessionId` 与 `sessionId` 不同时 daemon 各处(日志、取消、子请求)都用对的那个。
   - 完成标准:真实模型测试:建会话、一个回合、重启 daemon、再问,模型记得前文;单元测试覆盖记录丢失时报 `-32013`。
7. **agy:配置项(模式、模型、思考强度)**(依赖 3、4)
   - 范围:`mode`、`model`、`effort` 的 `session/set_config_option` 和 `config_option_update`;模型清单进 daemon 的选项缓存;`cycle/efforts`;agy 自己改了模式时回报。
   - 完成标准:单元测试;真实账号上切到 `plan` 再回来、换模型后不支持的档位改回 `default`;`auto` 不可用的环境里记录的是实际的模式。
8. **agy:插入、提问、agent 自己开始的回合**(依赖 3)
   - 范围:`steer: true` 和 `cycle/steer`;表单(elicitation)和 `cycle/noClient` 的回退;后台叫醒的那一轮合成 `running`…`idle`。
   - 完成标准:每个回合只有一条带 `stopReason` 的 `idle`(单元测试含竞态:插入恰在回合结束时、取消时还有未处理的插入);真实账号上各走通一次。
9. **agy:MCP 和 connector 网关**(依赖 3、4)
   - 范围:`--process-per-session`;声明 `capabilities.session.mcp.http`;`mcpServers` 的 stdio 和 http 条目转成 v1 的形状;SSE 拒绝。
   - 完成标准:集成测试:一个本地的假 http MCP 服务器经网关被 agy 调到,服务器收到的请求带网关的 key、不带任何账号 token;stdio 的同理。
10. **agy:附件、命令、用量、标题、工具结果**(依赖 3)
    - 范围:图片和嵌入资源、`resource_link`;`available_commands_update`;`usage_update`;`session_info_update`;diff、`locations` 和能算出的 `cycle/toolResult`。
    - 完成标准:单元测试;真实历史喂给界面的会话模型,`ignored` 为 0(和 Claude 的验证同一个标准)。
11. **agy:子 agent 和后台活动的显示**(依赖 1 的结论;可能缩成"只显示为工具调用")
    - 范围:按探针看到的,映射 `subagent_update`、`_cycle/child_update`、`cycle/background`;给不出的写进"未做"。
    - 完成标准:真实账号上起一个子 agent,界面上看得到它开始和结束;文档写明没做的部分。
12. **agy:plugin**(依赖 CYCL-155、4;最后做)
    - 范围:`PluginProvider`:已装清单、安装、卸载、启停;plugin 的 MCP 服务器先一律 `by: "agent"`;可装清单和来源管理看 agy 有没有机器可读的接口。
    - 完成标准:`cycle/capabilities.plugins` 里有 `agy`;隔离目录里装、停、卸一个本地目录形式的 plugin 的集成测试。
13. **agy:测试套件、文档和埋点收尾**(依赖 CYCL-155 的埋点部分)
    - 范围:`scripts/integration-suites.ts` 加 agy 套件(没装 agy 时跳过并说明);`test:real` 的 agy 版本;红线清单加"测试不指向真实的 `~/.gemini`";`agentOf` 认得 `agy`;把本文件从"调研"改写成和 `claude.md` 一样的"已做、未做、验证结果"。
    - 完成标准:门禁和集成测试通过;`docs/analytics.md` 的字典一致;本文件的状态行改成草稿并带验证日期和版本。

建议的顺序:1、2 先做(2 可以挡住发布,不挡开发);3、4、5 是能跑起来的最小集合;6–10 各自独立;11、12 看 1 的结论;13 收尾。
