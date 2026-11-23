# Agent Note: plugin 归各 agent 自己安装和加载,它带的 http MCP 服务器改由 Cycle 的网关提供

Status: accepted
Date: 2026-11-23
Basis: CYCL-57 及子任务 CYCL-81(研究)。负责人 2026-11-23 在对话里同意:connector 与 plugin 保持两个概念、v1 界面只写用户级范围、先实测"由 Claude 自己安装"这条路;并否决了"plugin 自带的 MCP 服务器登录不了就在界面上写明"的提议,要求"能够正常使用 plugins 并且正常安装"。下面的事实是 2026-11-23 在隔离的配置目录里用 SDK 0.3.327 自带的 Claude(2.1.327)实测的,见"实测"一节。

## Problem

Cycle 要能浏览、安装、启停、更新、卸载 plugin。先做 Claude Code 的,以后还有 Codex、agy 的。几个约束互相拉扯:

- plugin 的格式、marketplace、缓存目录、启用开关都是各 agent 自己的,而且在变。L1 不能长成 Claude 的形状。
- plugin 会带可执行的东西:hooks、命令、stdio MCP 服务器。安装是一次"允许运行别人的代码"的决定。
- plugin 常带需要登录的 http MCP 服务器(Linear、Figma 用 OAuth,GitHub 用请求头里的 token)。在 Cycle 里,agent 自己的 OAuth 走不通:适配拒绝 URL 模式的 elicitation,回调落在 daemon 那台机器的 localhost,token 还会存进 agent 读得到的目录([connector 笔记](2026-11-19-connectors-behind-a-daemon-gateway.md))。不解决,这类 plugin 装上了也用不了。
- 红线:环境变量只走白名单,任何账号的 token 不到达 agent,测试不碰真实的 `~/.claude`。

## Decision

1. **plugin 归 agent,安装由 agent 自己的机制做。** daemon 里每个 agent 可以带一个 `PluginProvider`(列出来源、列出可装的、已装的、安装、更新、卸载、启停)。Claude 的实现是运行 Claude 自己的命令行(`claude plugin … --json`),环境和启动 Claude 进程时完全一样(`claudeEnv` 的白名单加 `PATH`),配置目录是 Cycle 托管的 `$CYCLE_HOME/claude`,工作目录是一个空目录。Cycle 不解析 marketplace,不自己拉 git,不写 `installed_plugins.json`。
2. **L1 只有 agent 无关的字段。** `_cycle/plugins/*`(protocol.md §15)里的 plugin 有 `agentId`、对这个 agent 不透明的 `id`、名字、说明、版本、来源、是否已装、是否启用、范围、带了什么(各类的个数)、带的 MCP 服务器。Claude 的 `name@marketplace`、`enabledPlugins`、缓存路径都不出现在 L1 的语义里(`id` 的内容客户端不解析)。"来源"(source)对应 Claude 的 marketplace,别的 agent 可以只有一个内置来源。
3. **plugin 带的 http MCP 服务器是 Cycle 的 connector。** plugin 启用时,daemon 为它声明的每个 http 服务器建一个**属于这个 plugin 的 connector**(§14 的 `origin`),经网关提供,OAuth 和请求头里的密钥都按 connector 已有的办法由 daemon 做和保管。启动这个 agent 时,daemon 用 **agent 给这个服务器起的名字**(Claude 是 `plugin:<plugin>:<server>`)把网关地址放进 `mcpServers`;同名条目会顶替 plugin 自己的那个,原服务器不再被 agent 直接访问,工具名不变,plugin 的 skill 里写的工具名照样对得上。
   - 请求头里的 `${NAME}` 是要用户填的密钥(存进凭证库,转发时代入);不含变量的头原样带上。
   - 服务器要不要登录事先不知道:建的时候探一次,之后网关第一次收到 401 也会把它改成"需要登录"。
   - 属于 plugin 的 connector 不能改名、改地址、单独删除;随 plugin 停用而停用,随卸载而删除(连同凭证)。
4. **stdio、sse,以及地址里带 plugin 自己变量的服务器,留给 agent 自己启动。** 它们在 agent 的进程里、用 agent 的(白名单)环境运行,不需要 Cycle 的登录。L1 上标明是谁在提供(`cycle` 或 `agent`)。
5. **安装必须带确认。** `_cycle/plugins/install` 的参数里要有 `acknowledged: true`,没有就拒绝;客户端在用户确认"它可以在这台机器上运行代码"之后才带上。marketplace 自己声明要运行命令才能取到 plugin 的那一类(CLI 的 `--accept-command`),v1 不装,报固定的原因。
6. **范围**:v1 只写用户级(这台 daemon 上这个 agent 的所有 session)。模型里有 `scope`,项目级留给以后。
7. **生效时间**同 connector:下次启动 agent 时生效,正在运行的不变。

## 实测

2026-11-23,隔离目录(`CLAUDE_CONFIG_DIR` 和 `HOME` 指向临时目录,`env -i`),没有登录:

- SDK 自带的可执行文件有 `plugin` 子命令。`marketplace add|list|remove|update`、`list --json`、`list --available --json`、`install|uninstall|enable|disable|update --json` 都是非交互的,结果是一行 JSON(`outcome`、失败时 `failureCode`,如 `not_found`),退出码 0 或 1。
- 没加任何 marketplace 时,`list --available` 就有一个内置目录 `anthropic-plugin-directory`,3779 个条目,约 2.2 MB;不登录也能取到,取一次约 1 秒(有缓存 `plugins/plugin-directory-cache-v2.json`)。从它安装 `linear` 成功(从 git 取)。
- 落盘:`settings.json` 的 `enabledPlugins`、`extraKnownMarketplaces`;`plugins/installed_plugins.json`、`plugins/known_marketplaces.json`、`plugins/cache/<marketplace>/<plugin>/<version>/`。
- `list --json` 的每一项带 `mcpServers`(plugin 声明的原样,变量未展开)、`enabled`、`scope`、`installPath`、`version`。
- SDK 会话(不传 `settingSources`)自动加载用户级启用的 plugin:命令是 `demo:hello`,MCP 服务器名是 `plugin:demo:remote`。
- **顶替**:在 `mcpServers` 选项里给出同名的 `plugin:demo:remote`(指向另一个地址),会话连的是给出的地址,plugin 声明的地址一次都没被访问;运行中用 `setMcpServers` 给同名条目也一样。不给时,Claude 自己去访问原地址并做 OAuth 发现。
- 真实 plugin 的三种形状:`linear` 是不带头的 http(OAuth);`figma` 是带固定头的 http;`github` 是 `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`。

- **真实登录**(同日,负责人在浏览器里点的授权):真实的 daemon 从内置目录装 `linear`,connector 探测后变成需要登录;daemon 对 `mcp.linear.app` 做发现和动态注册,回调用本机随机端口,换到 token;之后按 `plugin:linear:linear` 交给 agent 的网关地址 `initialize` 返回 200,`tools/list` 返回 78 个工具;交给 agent 的内容里没有 token。

没有验证:Figma 等其他授权服务器;Windows;`--accept-command` 那一类 marketplace;项目级范围;运行中的会话用 `reloadPlugins` 即时生效。

## Alternatives considered

- **Cycle 自己装**(自己拉取、保管 plugin 目录,启动时用 SDK 的 `plugins: [{type: "local"}]` 传入):启停和范围完全由 Cycle 控制,看上去更"agent 无关"。没选:要重写 marketplace 解析、git 拉取、版本和依赖、更新,而且这些格式只有 Claude 自己说了算;内置目录(3779 个)也拿不到。agent 无关应该在 L1 的字段上做到,不是靠重写每个 agent 的安装器。
- **daemon 直接读写 `installed_plugins.json` 和 `settings.json`**:不用起进程。没选:这些是 Claude 的内部格式(已经是 `version: 2`),Claude 进程自己也在写。
- **plugin 的 MCP 服务器留给 Claude 自己登录**(最初的提议:在界面上写明登录不了):负责人否决,需要登录的 plugin 等于不能用。
- **把 URL 模式的 elicitation 转给客户端,让 Claude 自己做 OAuth**:connector 笔记里已经否过,理由不变(回调在远端的 localhost、token 归 agent 保管)。
- **把 plugin 的全部 MCP 服务器(含 stdio)都搬到网关后面**:stdio 的命令里有 `${CLAUDE_PLUGIN_ROOT}` 和 plugin 的 userConfig 代入,还可能依赖 plugin 目录里的文件和 agent 的工作目录;daemon 要重做 Claude 的变量展开。它们不需要登录,留给 agent 没有坏处。
- **装之前先下载、列出它带的可执行内容再确认**:Claude 的命令行没有"只取不装"。v1 的确认说的是来源和"可以运行代码";装完后详情里列出它实际带了什么,可以马上停用或卸载。

## Consequences

- 安装、更新要联网并可能运行 git,都发生在 daemon 的机器上;慢的时候是几秒到几十秒,L1 的请求要等它。
- daemon 依赖 Claude 命令行的 `--json` 输出和 `plugin:<plugin>:<server>` 这个命名。升级 SDK 时要重跑 plugin 的测试;命名变了,顶替就会失效,退回成 Claude 自己去连(能看出来:connector 的工具名变了,或服务器显示要登录)。
- plugin 的 http 服务器的地址由 plugin 决定,更新 plugin 可能换地址;换了地址按 connector 的规则作废旧 token。
- plugin 的 hooks、命令、stdio 服务器在 agent 的进程里以 agent 的权限运行,这是 plugin 本来的含义;Cycle 只保证它们拿不到 daemon 的环境变量和任何 token。
- 内置目录有几千项:L1 上"可装的"要分页和搜索,不能一次全给。
- 埋点只报动作和结果的类别(CYCL-84),plugin 的名字、来源地址不进埋点。

## Related

- [Connector 是 Cycle 的公共能力](2026-11-19-connectors-behind-a-daemon-gateway.md):网关、凭证库、OAuth 的决定,这里沿用并扩展到 plugin 带的服务器。
- [文件夹信任](2026-11-19-folder-trust-is-cycles.md):项目级的配置(以后的项目级 plugin)受它管。
