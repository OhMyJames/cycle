# daemon

状态:草稿。验证日期 2026-11-18。

`apps/daemon`:L1 协议的实现(见 [protocol.md](protocol.md))、服务端传输与 CLI 入口。daemon 对客户端说 ACP v2,对 agent 也说 ACP v2。

## 结构

| 文件                             | 作用                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `src/log/`                       | 事件日志:接口、JSONL 实现、补发(`attach`)                                        |
| `src/index-file.ts`              | session 索引,整体原子写入                                                        |
| `src/agents.ts`、`agent-link.ts` | agent 的定义,以及到 agent 的 ACP 连接(daemon 是 client)                          |
| `src/process-agent.ts`           | 把一个子进程作为 agent 启动,显式环境,不继承                                      |
| `src/session.ts`                 | 一个已加载的 session 的状态                                                      |
| `src/daemon.ts`                  | 面向客户端的 ACP 应用:session 的创建、列表、附着、prompt、取消、权限、归档、删除 |
| `src/logger.ts`                  | daemon 自己的运行日志:按事件记、过滤凭证、0600、按大小轮转(见"日志")             |

客户端看到的一切都经过 session 的日志:补发和实时是同一条路径。

## 已做并测过

- `session/new`:daemon 分配 UUID,作为建议传给 agent;agent 回的 id 和它对应关系记在索引里。
- `session/list`:只列 Cycle 自己的 session,带状态、agent、归档、标题和最新序号。客户端可按创建时间分页，并按目录、agent 和创建时间范围筛选。兼容规则见 [protocol.md §6](protocol.md#列表)。
- `session/resume`:附着;不带 `replayFrom` 只附着,`start` 或 `_cycle.seq` 补发,然后 `replay_complete` 和状态快照。
- `session/prompt`:agent 没在运行时先启动并恢复它;session 忙时入队(见下面"排队"),队列满了才拒绝(`session_busy`)。
- 权限请求:写日志,发给所有附着的客户端,先到先得,其余客户端收到 `_cycle/request_resolved`;没人附着时挂起,有人附着再发;取消或 agent 退出时回答为已取消。
- `session/cancel`、`session/set_config_option`(记入索引,agent 重启时重新应用)、`session/close`、`session/delete`。
- `_cycle/agents/list`、`_cycle/session/archive`、`unarchive`、`set_title`,以及 `_cycle/session_list_changed` 通知。
- agent 进程退出:挂起的请求中止,进行中的 turn 以错误结束,下一次 prompt 重新启动并恢复。
- daemon 重启:索引和日志在磁盘上,历史可读,不启动 agent。
- 协议主版本不一致时以 ACP 的 `-32022` 拒绝。
- **附件**(决策 0010):`session/prompt` 在启动 agent 之前按 agent 的 `promptCapabilities` 和上限(`PROMPT_LIMITS`)检查每一块,不合格整个拒绝(`-32602`,`data` 里有 `reason` 和 `index`);`_cycle/agents/list` 给出每个 agent 的 `promptCapabilities`;图片等进入日志的 `user_message`,补发时和文字一起到。
- **创建时的配置**：先按 agent 声明的字段和封闭选项校验显式覆盖，自定义模型名可用。agent 拒绝配置时，客户端收到带字段名的 `invalid_config`，列表和磁盘上都不保留这次会话。
- **session 的启动参数**:`additionalDirectories`、`mcpServers`、`systemPrompt` 在 `session/new` 里校验(目录必须在 daemon 的机器上存在),存进索引,每次启动或恢复 agent 时重新发送。索引文件权限 0600,MCP 的 `env`/`headers` 只在这里,不进日志,也不在 `session/list` 里。
- **agent 自己的变化回写**:`config_option_update` 写进索引的 `config`(agent 重启后按它恢复,不会改回去);`session_info_update.title` 写进标题,但用户起的名字不被覆盖(索引里标了 `titleFromAgent` 的才是 agent 起的;没有标记的一律当作用户的,包括这个功能之前写下的);第一条 prompt 到达、还没有标题时，先用消息开头作临时标题，同样标为 agent 的(`src/first-title.ts`,协议 §10"临时标题")。
- **elicitation**(决策 0011):`elicitation/create` 和权限请求同一套机制(写日志、先到先得、`_cycle/request_resolved`、取消和 agent 退出时以 `cancel` 结束),但只发给在 `initialize` 里声明了 `elicitation.form` 的客户端;没有这样的客户端附着时立刻回 `{action:"cancel", _meta:{"cycle/noClient":true}}`,不挂起。
- **附件字节落盘**(决策 0013):`BlobLogStore` 包住日志存储,`append` 把大的 base64 写到 `<数据目录>/blobs/<sessionId>/` 并在日志里留引用,`read`、`subscribe` 还原;删除 session 时整个目录一起删。daemon 其余部分和客户端不知道有这回事。
- **用量**:`usage_update` 写进索引的 `usage`,`session/list` 的 `_meta["cycle/usage"]` 给出。
- **排队**(协议 §8,笔记 `2026-11-18-prompt-queue-in-the-daemon`):忙时发来的 prompt 在 daemon 里排队,每条有 daemon 自己的 `queueId`,队列以 `_cycle/queue_update` 快照写进日志(图片字节照样走 blob),索引的 `queued` 标志让重启后知道要回读。turn 以 `end_turn` 结束才发下一条;其他结束方式、`session/cancel`、`session/close` 把剩下的整体退回(`returned`),不自动发。没有客户端附着,或 daemon 重启过,队列留着,下一次附着时在补发和状态快照之后退回;daemon 自己关闭不算退回的理由。`_cycle/prompt/dequeue` 取回一条。测试:`test/queue.test.ts`。
- **`_cycle/files/search`**(协议 §8,`src/files.ts`):只返回路径,只在 session 的 `cwd` 里;符号链接不跟随也不列出,不进 `.git` 和 `node_modules`,点开头的名字只给带点的查询,条目数和时间有上限(超了带 `truncated`)。测试:`test/files.test.ts`(含指向外面的链接)。
- **`_cycle/fs/list`、`_cycle/fs/read`**(协议 §8"浏览和预览文件",`src/fs.ts`):Files 标签用，只读，路径相对 session 的 `cwd`;每次请求重新取真实路径，指向外面的链接只列不开。一次一层；文本每块 1 MiB(在字符边界切),图片有上限，二进制只给大小。被 git 忽略的条目只在仓库根目录被信任时标(`src/git.ts`:加固参数、白名单环境、`GIT_CEILING_DIRECTORIES`、5 秒超时)。测试:`test/fs.test.ts`、`test/fs-method.test.ts`。
- **`_cycle/diff/status`、`_cycle/diff/file`**(协议 §8"工作区的改动",`src/diff.ts`):Diff 标签的工作区视图。session 的 `cwd` 之内，工作区对比 `HEAD`(没有提交时对比空树),路径相对 `cwd`,不做改名识别；只在仓库根目录被信任时运行 git(同 `src/git.ts` 的加固，加 `--no-ext-diff --no-textconv`、`GIT_LITERAL_PATHSPECS`、10 秒超时)。最多 1,000 个文件；一个补丁最多 1 MiB,超过就停下 git 并在行尾截断。未跟踪的文件经 `src/fs.ts` 同样的路径检查才读。测试:`test/diff.test.ts`、`test/diff-method.test.ts`;测试里的 git 用 `gitIn`(不读本机的配置、hooks 和身份)。
- **`_cycle/terminal/*`**(协议 §8"终端",`src/terminals.ts`,决定笔记 `2026-11-22-terminals-in-the-daemon-over-l1`):用户在 session 旁边开的 shell。PTY 是 Bun 自带的(`Bun.spawn({ terminal })`),shell 以登录 shell 在 session 的 `cwd` 里启动，环境只取 `terminal.allowEnv`;每个终端一个 `@xterm/headless` 记屏幕，附着和追赶时给序列化的快照。输出约 16 ms 或 64 KiB 合一段；一个连接没写出的输出超过 1 MiB 就停发，全部写完后补一次 `reset`(`reset` 本身不计入这 1 MiB,屏幕再大也不会因它再落后);屏幕没解析完的超过 8 MiB,换一个空屏幕接着记(日志 `terminal_screen_restarted`),而不是跳过一段输出，那样会留下 shell 从没有过的状态。关闭时 PTY 先不关：在它打开期间这个 tty 设备不会给别的终端，所以 `ps -t` 找到的都是这个终端的进程(shell 和各个作业，作业各在自己的进程组里),逐个发 `SIGHUP`;2 秒后 shell 还在就 `SIGKILL` 它的进程组，最后关 PTY。shell 退出后 PTY 也不关，直到终端被关闭，最后的输出不会丢。session 归档、删除时它的终端立刻离开列表，进程在后台结束;daemon 停止时和 session 的收尾并行;终端不计入 `activity()`。实测(2026-11-22,macOS arm64,10 个终端各输出 3000 行):daemon 每个终端约 7 MB,shell 每个 2–3 MB。测试:`test/terminals.test.ts`(环境、流量控制、快照)、`test/terminal-method.test.ts`(真实 `/bin/sh`:环境、尺寸、附着、退出码和最后的输出、关闭结束前台和后台作业、上限、归档删除和停止)。
- **`_cycle/agent_defaults/*`**:读写都有实现,存在 `<数据目录>/agent-defaults.json`,新 session 按它开始,session 自己的配置覆盖它(此前这份文档误写成占位)。
- **`_cycle/connectors/*`**(protocol.md §14):清单在 `<数据目录>/connectors/catalog.json`,密钥和 token 在同目录的 `credentials.json`(目录 0700,文件 0600),两个文件各在一个接口后面(`ConnectorCatalog`、`CredentialVault`),以后可以换成 cloud。任一文件读不了,daemon 拒绝启动,不覆盖它。OAuth 全在 daemon 里做(`connectors/oauth.ts`)。第一个用到 connector 的 agent 启动时,daemon 在 `127.0.0.1` 的随机端口上开 MCP 网关(`connectors/gateway.ts`),agent 只拿到网关地址和本 session 的 key;stdio 的 connector 由 daemon 启动(`connectors/stdio-bridge.ts`),环境变量只有固定白名单和它自己的值。
- **`_cycle/plugins/*`**(protocol.md §15,`src/plugins.ts`):plugin 归各 agent。agent 的定义可以带一个 `PluginProvider`;Claude 的是 `@cycle/harness-claude` 的 `ClaudePlugins`,它运行 Claude 自己的命令行(`claude plugin … --json`),环境是 `claudeEnv` 的白名单加 `PATH`(和启动 Claude 进程时相同,不继承 daemon 的环境),配置目录是 Cycle 托管的那个,工作目录是空目录 `<数据目录>/plugins/claude`。daemon 不保存 plugin 的清单:向 agent 问一次,记 60 秒,每次改动后立即重问;同一个 agent 的改动一次只做一个。已装 plugin 声明的 http 服务器由 `ConnectorService.syncPlugins` 建成带 `origin` 的 connector(清单里多存 agent 给它起的名字和 plugin 写的请求头),启动那个 agent 时用那个名字交出网关地址,顶替 plugin 自己的。测试:`test/plugins.test.ts`(内存里的 provider)、`harness/claude/test/plugins.test.ts`(回放命令行的输出)、`harness/claude/test/integration/adapter.integration.ts` 的最后一条(真实的 Claude,隔离的配置目录)。

## 停止和升级

agent 是 daemon 的子进程,daemon 停止时进行中的 turn 不会继续。所以停之前先看,停了以后历史要说清楚(协议见 [protocol.md](protocol.md) §8"daemon 停止时进行中的 turn")。

**`cycle stop`** 先用 `session/list` 问 daemon 有哪些会话在工作:turn 在跑、在等权限或表单的回答、或还有后台任务(`cycle/background` 大于 0)。没有就直接停。有就逐个列出,然后:

- 在终端里:问"等待 / 强停 / 取消"。
- `--wait`:每 2 秒看一次,都结束了再停;Ctrl-C 离开,daemon 照常运行。
- `--force`:先说会丢什么(turn 被打断、等待中的请求取消、后台任务停掉不重建,排队的消息保留),再停。
- 不在终端、也没给选项:不停,列出在工作的会话,退出码 4。
- 问不到 daemon(超时、不是 Cycle 的 socket):只有 `--force` 才停。

问用的是已有的 `session/list`,协议版本不同时按 daemon 说的版本再问一次,所以新的 `cycle` 可以这样停一个旧 daemon,升级时正是这样(`src/stop.ts`)。

**daemon 停止时**(收到 `SIGTERM`/`SIGINT`):对每个有进行中 turn 的 session,先把等待中的权限请求和表单写成 `aborted`(按取消回给 agent),再写一条 turn 的终态:`state_update` 为 `idle`、`stopReason: "error"`、`error.code` 为 `-32018`(`daemon_stopped`),然后结束 agent。此后 agent 发来的更新不再记录。终态算"值得看",所以会话显示未读;客户端重连补发时看到它。

**没来得及写的**(崩溃、`kill -9`、比这条规则早的 daemon):索引里的 `turnOpen` 记着日志里有没有没结束的 turn。下一次加载这个 session 时(第一次 `session/list` 或附着),`turnOpen` 不是 `false` 就读一次日志核对,确有没结束的 turn 就补写同样的终态。旧索引里没有 `turnOpen` 的,各读一次日志。

**队列**:终态不退回队列。排队的 prompt 按"排队"的重启规则留着,下一次有客户端附着时以 `reason: "interrupted"` 退回输入框。

**`Daemon.activity()`**:daemon 里同一个"有没有在工作"的判断(turn、待回答的请求、后台任务、排队数)。`cycle stop` 和下面的空闲退出都用它:只在它为空时停。

## 空闲回收和空闲退出

CYCL-104。目标机器是 2 核 4 GB,长期挂着的 daemon 不能让进程越攒越多。

**实测**(`bun apps/daemon/scripts/measure-memory.ts`,真实 Claude、haiku,每个 session 一个短回合,2026-11-22,macOS arm64):

| 状态                       | daemon 下的进程 | daemon | daemon + agent |
| -------------------------- | --------------- | ------ | -------------- |
| 0 个 session               | 0               | 88 MB  | 88 MB          |
| 1 个 session,有客户端附着  | 2               | 93 MB  | 439 MB         |
| 5 个                       | 10              | 83 MB  | 1613 MB        |
| 10 个                      | 20              | 76 MB  | 2959 MB        |
| 10 个,客户端离开、回收之后 | 0               | 75 MB  | 75 MB          |
| 10 个,重开其中 1 个        | 2               | 76 MB  | 425 MB         |

一个 session 是两个进程：适配器(`cycle adapter claude`,约 40–50 MB)和它下面的 Claude(约 300 MB)。适配器在 Claude 空闲 5 分钟后自己结束 Claude(决策 0007),但适配器进程本身一直留着：一台用了几个小时的机器上能看到一串只剩适配器的进程。daemon 里的 session 本身很小(日志不在内存里，只记条数和时间),不回收。

**空闲回收**(`Daemon.reclaimIdleAgents()`,`serve` 每 30 秒调一次):一个 session 的 agent 进程在下面这些都成立、并持续 `idle.agentMinutes`(默认 10 分钟)后被结束：

- 没有客户端附着(附着就是在看它;客户端离开时开始计时，而不是从最后一条记录算起);
- 没有进行中的 turn、没有待回答的请求;队列为空，或者是已经扣着等客户端取回的队列(见"排队",它不需要 agent,原因不变);
- 没有在跑的后台子 agent(`cycle/background` 为 0)。只剩"结束原因未知"的记录不算(protocol.md §8)。

计时从最后一件事算起：写进日志的记录(daemon 自己的 `meta` 不算)、附着或离开、有请求要用 agent(prompt、改设置)、agent 启动完成。结束的方式和预热上限、信任变化时一样(`link.kill()`),并且当场按 agent 已退出处理，不等连接关闭的通知，这样紧接着来的 prompt 会起一个新的，不会交给正在退出的那个。session 留在内存和列表里，状态是 `stopped`,下一个 prompt 按已有路径启动并 `session/resume` 它。日志记 `agent_reclaimed`(session id 和空闲秒数)。和预热上限(每个 agent 自己的，Claude 的是 `claude.maxWarm`,CYCL-24;只数这个 agent 的 session)是两回事：上限管"同时有几个",回收管"空闲多久";预热起来、没人发 prompt 的进程，没人附着时同样按时间回收。

**空闲退出**(`serve` 里同一个定时器):`Daemon.idleSince()` 在下面都成立时给出从何时起空闲：没有任何客户端连着、没有 session 在加载或启动 agent、`activity()` 为空。持续 `idle.exitMinutes`(默认 30 分钟)后，daemon 按收到 `SIGTERM` 的同一条路径停下(日志 `idle_exit`,然后 `daemon_stopping`),退出码 0。

停下的顺序(两种停法一样):先不再接新连接(这之后连上来的立刻被断开，客户端重连);再关掉所有终端(协议 §8"终端":终端不拖住空闲退出，里面的进程随 daemon 结束)、结束 agent、写完索引和缓存;最后才删 pid 文件、关 socket。socket 一直占着，新的 daemon 在旧的写完之前起不来，两个进程不会同时写一个数据目录。

- 不丢状态:`activity()` 为空就没有被打断的东西;索引、日志、排队的 prompt 都在磁盘上(排队的照"排队"的规则，等下一次有客户端附着)。
- 自动拉起：桌面端本地和 ssh 都通过 `cycle proxy` 连接，连接断了就重连;`proxy` 发现没有 daemon 在听就先启动一个。所以有客户端连着时 daemon 不会退出，没有客户端时退出了，下一次连接把它拉起来。
- 回收 agent 是 daemon 自己的事，不重新开始空闲计时。
- 两个都可以关:`0` 就是关。

**限制**:桌面端打开过的 session 在这次连接里一直附着(`CycleClient.unwatch` 只在客户端本地生效，不告诉 daemon),所以桌面端连着时，这些 session 的 agent 不被回收，只靠适配器 5 分钟释放 Claude。桌面端关掉或断开(远端机器上合上笔记本)之后才全部回收。

**从桌面端升级远端 daemon**:确认框先看那个环境的会话列表。没有在工作的会话,命令末尾是 `cycle stop`(若这期间有会话开始工作,它不在终端里,会拒绝并报错,不会中断它们)。有就列出会话名,让人选:

- "Update when they finish":安装新版本,然后在远端后台跑 `nohup cycle stop --wait`,ssh 结束后它继续等;横幅改成"已安装,会话结束后重启为新版本",按钮变成"Update now"。连接断开、重连到新 daemon 后横幅消失。
- "Update now and interrupt":安装后 `cycle stop --force`。

埋点 `daemon_upgraded` 带 `when`(`idle`/`now`/`later`),见 [analytics.md](analytics.md)。

## 没做

- **合成 `user_message`**:协议 §8 写的"agent 不发时 daemon 合成"没有实现。Claude 自己会发,所以现在不需要;接入不发的 agent 时再做。
- **日志里的敏感字段过滤**。
- **一个 session 一个 agent 进程**:没有复用。
- **daemon 的打包和安装**:现在是 `bun apps/daemon/src/main.ts`;没有 `cycle` 可执行文件,也没有远端机器上的安装步骤。ssh 通道里的命令得由调用方写全。
- **daemon 退出时对客户端的通知**:客户端仍靠连接断开发现,然后重连;重连后按 `cycle/seq` 补发,看到被打断的 turn 的终态(`daemon_stopped`),由此知道发生了什么(见下面"停止和升级")。没有另发一条"要停了"的通知。
- **重启后续接 agent**:进行中的 turn 被打断,不续接(agent 是 daemon 的子进程,状态在进程里);后台子 agent 也不重建。
- **附着着的 session 的回收**:桌面端不对看过的 session 取消附着，所以它连着时这些 session 的适配器进程不回收(见"空闲回收和空闲退出")。
- **客户端先于 `initialize` 发请求的处理**:交给 SDK(返回 `-32600`)。

## 运行

```bash
bun apps/daemon/src/main.ts serve  [--data-dir <dir>] [--socket <path>]   # 前台运行
bun apps/daemon/src/main.ts proxy  [--data-dir <dir>] [--socket <path>]   # stdin/stdout 接到 socket;daemon 没在运行就先启动它
```

- 数据目录默认 `$CYCLE_HOME` 或 `~/.cycle`(桌面应用从源码运行时给它的是 `~/.cycle-dev`,见 [desktop.md](desktop.md));socket 默认 `<数据目录>/daemon.sock`。
- `proxy` 启动的 daemon 是脱离的(`detached`),不随 ssh 连接结束,所以连接断了 session 照常运行。
- 同一个 socket 上只能有一个 daemon(`serve` 发现已有进程在监听就以退出码 3 退出);进程异常退出留下的 socket 文件会被清掉。
- daemon 在数据目录里写 `daemon.pid`:绑定 socket 的那一刻写,只由绑定成功的那个写;两个同时启动时,没抢到 socket 的那个以退出码 3 退出,不碰 pid 文件。`cycle stop` 先看 socket 再读 pid,读不到时等它一会儿(1 秒)。
- "在运行"指 socket 上有进程在接连接。正在停止的 daemon 仍占着 socket,对新连接直接挂断(Bun 有时报为 `ECONNRESET`),这仍算在运行;只有没有 socket 文件或没人接(`ECONNREFUSED`)才算停了。`cycle stop` 以结束等待的那一次查看为准，不再另看一次。
- socket 权限 0600,所在目录 0700。这就是 v1 的全部访问控制(决策 0004)。

## 构建成一个可以拷走的目录

```bash
bun run --cwd apps/daemon build
```

产出 `apps/daemon/dist/cycle-<os>-<arch>/`(和同名 `.tar.gz`):

- `cycle`:daemon 本身,一个可执行文件(`bun build --compile`,约 110 MB,里面带着 Bun 和 Claude 适配)。
- `claude`:Claude Code 的二进制(约 370 MB,取自 SDK 的平台包),放在它旁边,适配通过 `shippedExecutable("claude")` 找到它。每个带二进制的 agent 都这样放一个，清单见下面"加一个 agent"。

- `codex`：内部 `cycle adapter codex` 驱动的固定版 Codex CLI。Linux 包含配套的 `codex-resources/bwrap`，安装和复制时保留整个目录。

2026-11-23，加入 Codex 0.171.0 后的本地发行包实测（十进制 MB）：

| 平台            | cycle | claude | codex | 完整压缩包 |
| --------------- | ----: | -----: | ----: | ---------: |
| macOS ARM64     |    92 |    355 |   298 |        316 |
| Debian 12 ARM64 |   112 |    372 |   309 |        347 |

2026-11-20，GitHub 原生 Ubuntu 24.04 runner 构建同一提交并用已安装的单文件 daemon 跑通后端集成测试。耗时包含压缩，大小按十进制 MB 计算。[两种架构的构建日志](https://github.com/OhMyJames/Cycle-V1/actions/runs/44699952120)

| 架构  | 构建耗时 | 峰值 RSS | 解包目录 |   压缩包 |
| ----- | -------: | -------: | -------: | -------: |
| x64   | 23.79 秒 |  253 MiB | 484.2 MB | 222.6 MB |
| ARM64 | 16.96 秒 |  247 MiB | 483.2 MB | 221.9 MB |

机器上不需要 Bun、Node,也不需要装 `claude`。适配器作为同一个可执行文件的子命令(`cycle adapter <agent id>`,Claude 的是 `cycle adapter claude`)运行,所以只有这一个文件加各 agent 自己的二进制。

```bash
cycle status   # 在运行返回 0,不在运行返回 1;并给出日志的位置
cycle logs     # 日志的最后 100 行(--lines <n> 改行数)
cycle stop     # 停掉;有会话在工作时先列出来,问等待还是强停(见下面"停止和升级")
cycle login [agent]   # 为这个 daemon 登录一个 agent,在 daemon 所在的机器上执行;不写 agent 时是 Claude(跑 claude auth login)
cycle claude auth status   # cycle <agent id> <参数>:用同样的环境跑那个 agent 自己的命令行
```

**登录**:命令按 agent 走(`cycle login <agent id>`、`cycle <agent id> <参数>`),每个 agent 的登录各自隔离在数据目录里。现在只有 Claude:`login` 和 `claude` 用的环境和目录,正是 daemon 给它启动的 Claude 的那份(`config.json` 里的 `configDir`,默认 `<数据目录>/claude`;`HOME` 回落到它),所以登录落在 Claude 以后会去找的地方,不会碰 `~/.claude`。全新的数据目录里 `claude auth status` 报 `loggedIn: false`(已验证)。**登录流程本身没有验证过**:它要在浏览器里完成 OAuth,我没法替你做。验证过的做法是把 OAuth token 或 API key 写进 `config.json` 的 `claude.env`。构建目录里缺 `claude` 时,`agents/list` 里 Claude 是 `available: false`,不是等到第一个 prompt 才失败。

**Codex 的登录**:`cycle login codex`(跑 `codex login`,可加 `--device-auth` 或 `--with-api-key`)和 `cycle codex <参数>`(如 `cycle codex login status`)用的是 daemon 给 Codex 的同一份环境:`CODEX_HOME` 是 `config.json` 里 `codex.configDir`,默认 `<数据目录>/codex`,`HOME` 回落到它,所以不读也不写 `~/.codex`。每条 Codex 命令和 app-server 都带 `-c cli_auth_credentials_store="file"`,登录只落在 `$CODEX_HOME/auth.json`,不进系统钥匙串。本机就在本机跑;远端在那台机器上跑(`ssh <host> cycle login codex --device-auth`,设备码登录要先在 ChatGPT 的安全设置里打开)。数据目录里还没有 `codex` 目录时先建好它(Codex 不肯在不存在的 `CODEX_HOME` 上登录)。回合因没登录失败时,错误里写明要跑 `cycle login codex`。也可以把一份已有的 `auth.json` 放进 `<数据目录>/codex/`(远端没有浏览器时常用),但同一份 ChatGPT 登录不要同时给两个 Codex 用:刷新 token 时会把另一份挤掉。2026-11-23 用真实 ChatGPT 账号验证:全新数据目录报未登录(本机 `~/.codex` 有登录也一样),放进登录后报已登录,经 daemon 新建会话完成回合(`apps/daemon` 的 `test:real:codex`)。浏览器里的 `codex login` 流程本身没有走,那是 Codex 自己的。

**装到远端机器**:解开 tarball,把目录放到 `$PATH` 上(或在桌面端 "Add environment" 里把命令写成绝对路径,如 `/opt/cycle/cycle proxy`)。`<os>-<arch>` 要和那台机器一致:在哪个平台构建就产出哪个平台的;跨平台要在对应平台构建。凭证写进那台机器上的 `<数据目录>/config.json`(见下)。

## 加一个 agent

agent 的 id 同时是它的适配器子命令、`config.json` 里的段名和命令名。daemon 的核心(会话、插件、默认设置)只认 `AgentDefinition`,不认具体的 agent;核心之外要按名字认 agent 的地方都从一张清单读(`src/harnesses.ts` 的 `HARNESSES`,每项是 `src/harness.ts` 的 `Harness`)。加一个 agent 要做的：

1. 在 `harness/<id>` 写适配器，导出在 stdin/stdout 上运行它的函数。
2. 在 `apps/daemon/src` 写它的 `Harness`(`runAdapter`、`definition`,有自己命令行的加 `cli`,自带二进制的加 `binary`),加进 `HARNESSES`。清单的顺序是客户端看到的顺序，第一个是没有指名时用的。
3. 在 `src/config.ts` 的 `ConfigSchema` 加一段，键是它的 id。agent 看到的环境只能来自这一段(`allowEnv` 点名的和 `env` 写明的),登录目录默认放在 `<数据目录>/<id>`。
4. 自带二进制的：在 `scripts/binaries.ts` 写构建时从哪里取，在 `apps/desktop/src/main/layout.ts` 的 `AGENT_BINS` 加上 `bin/<名字>`,在 `scripts/install.sh` 的文件清单里加上它(根目录的 `scripts/agent-binaries.test.ts` 检查这三处一致)。发版流程里对二进制的运行检查(`.github/workflows/release.yml`、`daemon-linux.yml`)和 `apps/desktop/test/integration/packaged.integration.ts` 是按名字写的，没有测试看着，要手动加。
5. 埋点：在 `packages/analytics/src/events.ts` 的 `KNOWN_AGENTS` 里加它的 id(`codex`、`agy`、`pi` 已经在里面),否则它算作 `other`。

`test/harnesses.test.ts` 用一个测试用的 harness(`test/fixtures/echo-harness.ts`,适配器是替身 agent)走完这条路：出现在 `_cycle/agents/list`、新建、prompt 由它自己的适配器进程回答、换一个 daemon 后恢复。理由见决定笔记 [2026-11-23-each-agent-is-a-top-level-config-section](../.agents/notes/2026-11-23-each-agent-is-a-top-level-config-section.md)。

## 配置:`<数据目录>/config.json`

每个 agent 有自己的顶层一段，键是 agent 的 id（`claude`、`codex`、`agy`）。

```json
{
  "claude": {
    "configDir": "/path/to/claude-config",
    "allowEnv": ["PATH", "LANG", "LC_ALL", "TERM"],
    "env": { "ANTHROPIC_API_KEY": "..." }
  },
  "agy": {
    "executable": "/path/to/agy",
    "home": "/path/to/agy-home",
    "allowEnv": ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR"],
    "env": {},
    "sandbox": false,
    "telemetry": false
  }
}
```

- **Claude 进程看到的环境只有三样**:`allowEnv` 里点名的、daemon 自己环境中存在的变量;`CLAUDE_CONFIG_DIR`;`env` 里写明的值。daemon 自己的环境变量不会传下去。端到端测试里给 daemon 设了 `ANTHROPIC_API_KEY`,检查 Claude 一侧的请求里没有它。
- `configDir` 默认是 `<数据目录>/claude`,一个独立目录,里面没有登录。要用已有登录,把它**有意地**指向那个目录(比如 `~/.claude`);要新登录,用 `CLAUDE_CONFIG_DIR=<目录> claude auth login`。
- `HOME` 默认不传(回落到 `configDir`),免得 Claude 找到没人打算共享的登录或设置。
- `progressSummaries`(默认 `true`):让 Claude 给每个在跑的子 agent 生成一行进度摘要(`subagent_update` 的 `summary`)。子 agent 的对话有变化时约每 30 秒一次，每次是一次沿用子 agent 模型和 prompt cache 的模型调用，计入账号用量。设成 `false` 就不生成，工具行上仍有工具数、用量和最后一个工具。理由见决定笔记 [2026-11-23-subagent-progress-summaries-on-by-default](../.agents/notes/2026-11-23-subagent-progress-summaries-on-by-default.md)。
- `terminal`(可省):`{ "allowEnv": ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_*", "TMPDIR"], "maxPerSession": 8, "max": 32, "scrollback": 5000 }`。终端的 shell 看到的环境只有 `allowEnv` 点名的(以 `*` 结尾的按前缀),加上 `TERM=xterm-256color`、`COLORTERM=truecolor`;没有 `HOME` 时用当前用户的家目录。和 Claude 的 `allowEnv` 分开：给终端加变量不会让 agent 看到它。
- `log`(可省):`{ "level": "info", "maxBytes": 1000000, "files": 3 }`,见下面"日志"。
- `idle`(可省):`{ "agentMinutes": 10, "exitMinutes": 30 }`,空闲多久结束一个 session 的 agent、空闲多久 daemon 自己退出;`0` 关掉。见上面"空闲回收和空闲退出"。

## 日志

daemon 在后台运行,没人看它的输出,所以它把自己做了什么、哪里出了错写进 `<数据目录>/daemon.log`。`cycle status` 给出位置,`cycle logs` 打印最后几行。前台在终端里跑 `cycle serve` 时同样的内容也打到 stderr。

- **一行一个事件**:时间、级别、事件名,然后 `key=value`。例如 `2026-11-20T08:00:00.000Z WARN  turn_ended session=… stopReason=error code=-32012`。
- **记什么**:启动(版本、pid、级别)、开始监听、客户端连上和离开、收到的信号、停止(当时有几个会话在工作)、agent 进程的启动和退出码、agent 的 stderr、每个 turn 怎么结束(`stopReason`,失败时带错误码)、prompt 发不出去、历史写不进去、daemon 停止时被打断的 turn,以及没被捕获的异常和 promise(带调用栈,然后退出码 1)。`debug` 级再加上 session 的加载。启动失败(比如 `config.json` 读不了)也写进去,用默认设置。
- **不记什么**:prompt、agent 的回答和工具调用的内容、凭证。这些只在 session 自己的历史里(§12 的过滤同样适用)。日志里出现的字符串只有事件名、id、退出码和错误信息;每个值都过一遍历史用的同一个凭证过滤(`redactText`,CYCL-7),并截到 500 字符。agent 的 stderr 是它的诊断输出,不是对话,也照此过滤和截断,每个 agent 进程最多记 200 行。
- **权限和大小**:文件 0600,所在目录 0700;已有的文件权限更宽时会收窄。超过 `maxBytes`(默认 1 MB)就轮转:`daemon.log` → `daemon.log.1` → … 保留 `files` 个(默认 3),最旧的删掉,所以总共不超过 `maxBytes × (files + 1)`(默认 4 MB)。
- **级别**:`error`、`warn`、`info`(默认)、`debug`,在 `config.json` 的 `log.level` 设。
- **写不了日志**(磁盘满、目录被占)不影响 daemon 运行,只是不再记。
- **`daemon.out`**:`cycle proxy` 在后台启动 daemon 时,把它的 stdout 和 stderr 接到这里,留给运行时自己在 daemon 代码之外崩掉时说的话。每次启动时超过 1 MB 就清空。daemon 起不来时,`proxy` 的报错会带上 `daemon.log` 和 `daemon.out` 的末尾。

## 客户端侧

- `packages/client`:`CycleClient` 与客户端侧传输(unix socket 连接、命令通道、ssh 通道——用系统的 `ssh`,`BatchMode=yes`,所以 `~/.ssh/config`、密钥和 known_hosts 都照常生效),给 Electron 的主进程用。记住每个被观看的 session 看到的最大 `cycle/seq`;连接断了就按退避重连,重连后对每个 session 用 `_cycle.seq` 要回错过的部分,每条记录只交给调用方一次,按序,没有重复。重连期间发的请求立刻失败,不排队。
- 服务端侧传输(unix socket 监听与 stdio 桥接)在 `apps/daemon/src/transport/`。

## 验证

- `bun test`(门禁里):对一个进程内的假 ACP agent,覆盖上面"已做"的每一项。
- `CYCLE_DAEMON_BIN=<构建出的 cycle> bun run test:integration`(在 `apps/daemon` 下)把同一个端到端测试换成跑构建出的可执行文件,通过。
- `CYCLE_REAL_MODEL_TOKEN=… bun run test:real`(在 `apps/daemon` 下,先 `build`):只用构建出的可执行文件、**空的环境**(PATH 只有 `/usr/bin:/bin`,没有 bun、node、token,token 只写在 `config.json` 里),经 `proxy` 起 daemon,真实模型一轮带权限审批,再 `status`、`stop`。通过,约 7 秒。
- `bun run test:integration`(在 `apps/daemon` 下):**整个后端**。客户端用 `CycleClient` 经过 ssh(用一个在本机执行命令的替身)连上;没有 daemon 在运行,`proxy` 把它启动起来;daemon 启动 Claude 适配进程,跑真实 SDK,对本地模拟 API。一个 turn 之后客户端断开,daemon 仍在运行且 pid 不变;新客户端再连上,拿到历史,继续对话,模型的请求里有前一个 turn 的上下文。
- 传输与 `packages/client` 的测试在门禁里:8MB 的消息、500 条消息保序、socket 权限、单实例、残留 socket、桥接、ssh 参数;客户端断线重连不丢不重、断线时错过的内容回来后补上、断线时挂起的权限请求在重连后重新问、`start` 失败、`close` 后不再重试。
- 一个由测试发现的问题:agent 恢复时发的状态快照曾被当作历史记进日志,客户端会把它当成 turn 结束。现在丢弃,并有测试(把修复去掉,测试会失败)。
