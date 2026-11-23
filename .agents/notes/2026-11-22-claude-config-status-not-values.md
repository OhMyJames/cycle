# Agent Note: Claude 的 config.json 在界面里只显示状态,修改留在 daemon 所在的机器上

Status: superseded
Date: 2026-11-22
Basis: CYCL-80(研究项:"不上线路的前提下,怎么在界面里配置 Claude 的 config.json";"评估:只在 daemon 本机设置、只显示状态不显示值、或经本地文件的引导";"产物为决定,不排远程编辑实现")。依据的是 2026-11-22 读到的代码:`apps/daemon/src/config.ts`(格式和读取)、`apps/daemon/src/claude-agent.ts` 的 `claudeEnv`、`apps/daemon/src/main.ts` 的 `login` 和 `claude` 子命令,以及 `docs/daemon.md`"配置"。负责人 2026-11-22 在对话里看过结论后答复"接受"。没有做任何实现或实测。
Superseded by: [Settings 中以 Harness 分组承载多 agent 订阅账号登录、用量与热生效运行时配置](2026-11-23-harness-settings-account-login-and-runtime-config.md)

## Problem

Claude 用哪份登录、哪个密钥,写在 daemon 机器上的 `<数据目录>/config.json` 的 `claude` 段里:`configDir`(登录所在的目录)、`allowEnv`(可以从 daemon 环境里放行的变量名)、`env`(写明的值,API key 或 OAuth token 就在这里)。现在它没有界面,只能在那台机器上手改(`docs/desktop.md`"还没做")。用户遇到的实际问题是:

- "No agent is available" 或 turn 以认证错误失败时,界面说不出是哪一种:没登录、密钥没配、文件写坏了,还是 Claude 没装。
- 新装一台远端环境后,不知道下一步该在那台机器上做什么。

约束:

- 红线(AGENTS.md):`ANTHROPIC_API_KEY` 之类会覆盖账号登录并计费,环境变量只走显式白名单;账号的 token 不得经过不该经过的地方。`docs/desktop.md` 的立场是凭证不上 L1 线路,connector 是唯一有意的例外,且只有"页面到 daemon"一个方向。
- `config.json` 只在 daemon 启动时读一次(`serve.ts`、`main.ts` 的 `loadConfig`)。改了它要重启 daemon 才生效,而重启会打断那台机器上正在工作的会话。
- 这个文件是人手改的,daemon 不是它唯一的写入者。

## Decision

按"状态上线路,值不上线路,修改在那台机器上做"来做,即任务里第二和第三个方案的组合:

1. **状态(只读,经 L1)**:daemon 提供一个只读的查询(暂名 `_cycle/agents/setup`,按 agent 给出),返回的只有布尔值、固定的词和**变量的名字**,从不返回值:
   - Claude 的可执行文件在不在;
   - 登录状态:已登录(账号登录)、用了 `env` 里的密钥、两者都没有、查不出来;
   - `env` 里设了哪些名字(如 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`),`allowEnv` 放行了哪些名字;
   - `configDir` 是默认的独立目录,还是有意指到了别处;
   - `config.json` 能不能读(不能读时给出 zod 或 JSON 的报错原话,它不含值);
   - 文件比 daemon 启动时新(改了但还没生效)。
     设置页的 Environments 里每个环境下显示这几行,出问题的那行用 `StateBlock` 写明是哪一种。
2. **修改(不经 L1)**:界面不提供任何输入密钥或 token 的字段。每种状态给出在那台机器上做的下一步:
   - 本机环境:一个按钮在系统的文件管理器里显示 `config.json`(主进程本来就知道数据目录,不经 daemon),以及可复制的 `cycle login` 命令;
   - 远程环境:可复制的命令(`cycle login`,或文件的路径),在那台机器的终端里运行。界面不替用户经 ssh 写文件。
   - 改完后 "Check again" 重新查询状态;文件比 daemon 新时,提示要重启那台机器上的 Cycle 才生效,并沿用升级 daemon 时"等会话结束再停 / 立即停"的同一个确认(`cycle stop --wait` / `--force`)。
3. **不做**:在界面里填写或替换 `claude.env` 的值、编辑 `allowEnv`、改 `configDir`,无论本机还是远程。

实现不在这一轮(任务明确不排实现)。要做时另开任务,先改 `docs/protocol.md`。

## Alternatives considered

- **只在 daemon 本机设置(桌面端直接读写本机的 `config.json`,远程的不管)**:本机不经 L1,确实不上线路。没选它作为方案的全部:最需要帮助的是远程环境(手改最麻烦的那台),它帮不上;而且界面一旦能写这个文件,就要处理与手改的并发、格式校验和"写了但没生效"的重启问题。其中"在文件管理器里显示它"这一小步保留在了决定里。
- **像 connector 那样"只写不读"地把密钥送给 daemon**:先例存在(`2026-11-19-connectors-behind-a-daemon-gateway`),技术上可行。没选,理由有三条。connector 的密钥进的是 agent 读不到的凭证库,而 `claude.env` 的值就是交给 agent 进程的环境,且会覆盖账号登录并改变计费对象,填错一次的后果是整台环境的会话换了付费方;写入之后必须重启 daemon 才生效,界面要么替用户打断会话、要么留下"已保存但没生效"的状态;它把"凭证上线路"的例外从一个扩大到两个。等有 cloud 身份和鉴权(decision 0004 预留的扩展位)时再评估。
- **经 ssh 由桌面端替用户改远端文件**:不经 L1,但密钥仍然从这台机器的界面出发、落到另一台机器,只是换了一条线路;还绕过了 daemon 对这个文件的全部校验。没选。
- **在界面里跑 `claude auth login` 的浏览器授权**:远端 daemon 时回调落在远端的 localhost,和 connector 当初遇到的是同一个问题;登录流程本身在这个项目里还没有验证过(`docs/daemon.md`"登录流程本身没有验证过",`docs/adapters/claude.md`"隔离登录验证")。不在这一项里决定。
- **什么都不做,只在文档里写**:现状。没选:界面连"是哪一种没配好"都说不出,用户只能去读日志。

## Consequences

- 界面第一次能回答"为什么这个环境不能用",并给出能照着做的下一步;凭证仍然不出现在 L1、页面和埋点里。
- 变量的**名字**会出现在 L1 和界面上。名字不是密钥,但属于用户的配置:不得进埋点(埋点只报状态属于哪一类)。
- 用户仍要到那台机器上动手,远程环境尤其如此。这是有意保留的不便。
- 需要一个新的 L1 查询和 daemon 里判断登录状态的办法。**未验证**:`claude auth status --json` 的输出是否稳定到可以依赖(`docs/adapters/claude.md` 记录过它返回 `loggedIn` 和 `authMethod`),在 daemon 里按需运行它的耗时,以及旧 daemon 没有这个查询时界面怎么退化(应按能力位隐藏这一块)。
- "文件比 daemon 新"的判断依赖文件的修改时间,在时钟不准或文件被原样重写时会误报,只能作提示。

## Related

- [Connector 是 Cycle 的公共能力](2026-11-19-connectors-behind-a-daemon-gateway.md):凭证上线路的唯一例外,以及为什么这里不照搬它。
- [远端 daemon 的最低版本与升级按钮](2026-11-19-daemon-minimum-version-and-upgrade-button.md):重启远端 daemon 时"等会话结束 / 立即中断"的确认,这里沿用。
