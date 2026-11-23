# 桌面客户端

状态:草稿。验证日期 2026-11-18。

`apps/desktop`(Electron 主进程、预加载脚本、页面入口)和 `packages/ui`(界面、会话模型、渲染进程的 store)。

## 构建和运行

```bash
bun install
bun node_modules/electron/install.js   # 下载 Electron 二进制(bun 不会自动跑它的 postinstall)
bun run build                          # 根目录:先构建 daemon 的可执行文件,再构建桌面端(esm 主进程、cjs 预加载、页面、css)
bun run start                          # 启动桌面端
```

- 本地 host 通过 `cycle proxy` 连接(没有 daemon 在运行就先启动)。用哪个 daemon,取第一个存在的:`CYCLE_DAEMON_BIN`;`apps/daemon/dist` 里构建出的可执行文件;源码(`bun apps/daemon/src/main.ts`,开发时,可用 `CYCLE_BUN`、`CYCLE_DAEMON_MAIN` 覆盖)。数据目录:`CYCLE_HOME` 设了就用它;没设时,安装的应用用 daemon 的默认(`~/.cycle`),从源码运行(`bun run start`)用 `~/.cycle-dev`,所以开发时的 daemon、socket 和会话不会碰到安装版正在跑的那个。开发版因此没有稳定版的凭证配置(`config.json` 在数据目录里):要么在 `~/.cycle-dev` 里另写一份,要么显式设 `CYCLE_HOME` 指向要用的目录。
- 在 xvfb 下用构建出的 daemon 启动过:Electron 起来,`proxy` 起 `serve`,数据目录里有 socket 和 pid。
- 远程 host 用系统的 `ssh`(`BatchMode=yes`,没有密码提示),在远端运行 `cycle proxy`;命令可在"Add environment"里改。
- 设置在 Electron 的 `userData` 里:环境列表在 `settings.json`,外观和语言在 `preferences.json`(`{ "theme": "system" | "light" | "dark", "language": "system" | "en-US" | "zh-CN" }`,见"设置页"),统计的开关和匿名 id 在 `analytics.json`。

## 结构

| 部分                                   | 作用                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/manager.ts`     | `ConnectionManager`:每个 host 一个 `CycleClient`,以及每个被观看 session 的会话。不依赖 Electron,用真 daemon 测试 |
| `apps/desktop/src/main/app.ts`         | 窗口、安全设置、IPC;只有它知道怎么连各种 host                                                                    |
| `apps/desktop/src/main/preferences.ts` | 外观和语言:读写 `preferences.json`,启动时和改动时应用主题。不依赖 Electron                                       |
| `apps/desktop/src/main/analytics.ts`   | 埋点的接线:匿名 id、开关、key 从哪来。事件字典和规则见 [analytics.md](analytics.md)                              |
| `apps/desktop/src/preload/preload.ts`  | 给页面一个对象 `window.cycle`(`AppApi` 的方法加 `onEvent`),没有别的                                              |
| `packages/ui/src/api.ts`               | main 与页面之间的契约(只有类型和方法名)                                                                          |
| `packages/ui/src/model/`               | 会话模型:把 ACP v2 的 `session/update` 累加成对话。纯 TS,没有 React,main 也用它                                  |
| `packages/ui/src/store/`               | 页面的状态和动作。没有 React,用假桥接测试                                                                        |
| `packages/ui/src/react/`               | 组件(ui-sdk,Streamdown)                                                                                          |

## 为什么 main 持有会话状态

页面重载后只会收到之后的更新;`CycleClient` 也按 `seq` 去重。所以 **main 为每个被观看的 session 保存会话和未回答的权限请求**,页面(重新)打开时一次拿到整个状态和一个 `version`;之后每个事件带 `version`,页面只接受 `version + 1`,更小的忽略,出现空洞就重新向 main 要。冒烟测试里重载页面后会话完整回来。

## 环境、workspace 与侧栏

状态:daemon 一侧(协议 0.2:`updatedAt`、`cycle/unread`、`cycle/background`、`mark_read`)已实现;客户端一侧(environment、一次一个 workspace 的侧栏、switcher、标记)已实现,哪些还没做见下面"现状"。代码里的名字是 environment(`EnvironmentConfig`、`environmentId`)。设计依据见决定笔记 [2026-11-18-sidebar-workspace-environment](../.agents/notes/2026-11-18-sidebar-workspace-environment.md)。

### 环境(environment)

环境是**客户端**的概念:daemon 不知道自己被当作本地还是远程(协议只看到一个连接)。

```ts
type Environment = {
  id: string; // 客户端分配,稳定;会话在列表里的身份是 (environmentId, sessionId)
  name: string;
  kind: "local" | "remote"; // 以后可能有 "cloud"
  transport: // 只有 remote 有
  { type: "ssh"; host: string; command?: string[] }; // 以后可以加 websocket 等,不改别的字段
};
```

- `remote` 不等于 SSH:SSH 只是现在唯一的 `transport`。
- 可以**同时连着多个** daemon,侧栏的会话是它们的**汇总**。每个环境有自己的连接状态。
- 环境的能力(能做什么)来自 daemon 的 `initialize`(§3 `_meta["cycle/capabilities"]`),界面按能力开关功能,不写 `if (remote)`。
- 一个 session 在创建时绑定到它的环境,不能换:远程的 cwd 在本机不存在。
- **断线**:一个环境断线(含重连中)时,它的会话保留最后一次的列表,灰显,不能新建 session、不能发 prompt;连上后用新列表替换。灰显的行 hover 的 tooltip 说明是哪个环境、为什么(断开、重连中)。**只在应用的一次运行内**:最后一次的列表由主进程保存在内存里,页面重载后仍在,但重启应用后没有;启动时就连不上的环境没有"最后一次"。
- **版本落后的远程 daemon** 要能用:列表里没有的字段按缺失处理(protocol.md §3、§6),界面不报错。

### 现状(哪些已经做了)

代码里的名字是 environment(`EnvironmentConfig`、`environmentId`、桥上的 `environments()` 等);界面文案里写 "environment"(Add environment 等),不写 "host"(决定:保留"环境"这个词,去掉 host)。词本身可以出现;只有一个环境时,不出现按环境分组、环境标题这类让人去选的东西。

- 主进程在启动时连接所有 host,各自独立,连不上的不拖累别的;原因记在它的状态里,侧栏的 host 状态行里显示。
- 会话是所有环境的一个汇总,身份是 `(environmentId, sessionId)`,按 `updatedAt` 排序;旧 daemon 的会话(没有 `updatedAt`)排在有的之后,彼此按 `lastSeq`,不同 daemon 的不混排。
- 侧栏一次只显示一个 workspace(`sessions.ts` 的 `workspacesOf`、`currentWorkspace`)。显示哪个:switcher 里选的(只对选它时打开的那个 session 有效,打开了别的就放弃),然后是打开的 session 所在的,最后是最近有活动的。
- Switcher 按 host 分组(本机在前,多于一个 host 时才有分组标题,标题带连接状态),组内最近有活动的在前;远程 workspace 带 server 图标,图标的可访问名和 tooltip 是"On <environment> · <state>";同名目录跨 host 时名字后带 host 名。Switcher 上的方块数字是**其他** workspace 里最紧急的一类,完整的计数在 aria-label。
- 当前 workspace 里的会话:Needs you、Running(包括有后台子 agent 的)、Today、Yesterday、Earlier(本地日界线)。older 的每个 workspace 先显示 20 条,有标记的和打开的永远显示。一行只有一个标记:needs-you > running > background > unread;断线 host 和已归档的会话没有标记。
- 打开的会话有 `cycle/unread` 时,窗口在前台,就告诉 daemon 已读(`markRead`;main 用它自己最近读到的那一行的 `lastSeq`,不会超出日志;不支持的 daemon 不会被问,失败也不弹错误条)。
- 断线的 host:会话灰显、tooltip 说明原因,不算在标记里,侧栏里有它的状态、原因和"Retry"。
- 新建 session 打开一个**空白对话**(`blank.tsx`,store 的 `blank`),不是弹窗,也不请求 daemon:输入框上面一行是"在哪里跑"(CYCL-55):环境(只列已连接的,多于一个才有)、文件夹和 agent(多于一个才有)。文件夹是一个按钮，只显示文件夹名，提示里是完整路径;点开(或 ⌘O)是一个菜单：这个环境上有过 session 的文件夹(新的在前)、"Browse…"(本机用系统的选择器，远程用 daemon 列文件夹;都不能时没有)和 "Enter a path…"(一个输入框的表单,Enter 确定)。daemon 能说信任时，选好的文件夹还没有决定就在旁边标 "Not trusted yet",发出第一条消息时照旧会问。设置(权限、模型、effort)只在输入框下面的芯片里改，从 agent defaults 读来;空白对话不再有标题栏的 "…" 菜单和设置弹窗，没有选项的设置等 session 建好后再改。打开时焦点在输入框;没有文件夹时在文件夹按钮上。有东西挡着第一条消息时，上面只说一件事、给一个出口：环境没连上(原因原话,"Connect again";草稿和附件都留着，输入框上方说一句)、正在连接、没有可用 agent(输入框不能用,"Check again")、agent 的设置读不出来("Read settings again")。**首条消息发出时**才依次 `session/new` 和 `session/prompt`(决定笔记 `2026-11-19-session-starts-at-first-message`):这期间消息先显示在空白对话里、上面的选择锁住;建不成,消息回到输入框并显示原因;建成了而消息发不出去,打开那个 session,消息在它的输入框里。daemon 的列表只列有过用户消息的 session,所以没发过消息的不会出现在侧栏。空白对话里 @ 搜它选的文件夹(daemon 要有 `filesInFolder`);斜杠命令要等 agent 启动后才有。Agent defaults 按 host 分别设置。
- 新建 session:默认在当前 workspace 的 host 和目录;可以选 host(只列已连接的);"Browse…"只对本机有。Agent defaults 按 host 分别设置(设置页的 Session defaults)。
- **文件夹信任**(protocol.md §8 "信任文件夹"):空白对话发出第一条消息时、新建 session 之前,目录还没有决定(它和它的上级都没有),先弹出 "Trust this folder?":说明信任之后项目自己的设置能在这个环境里运行命令(hooks、`.mcp.json` 里的服务器和 helper),下面是目录的真实路径;按钮是 Back(回到空白对话,消息还在输入框里)、Start without trusting、Trust and start。两个 Start 都先记下决定,再新建、发出消息;记不下就说明原因,什么都不建。已经有决定的目录不问。daemon 不支持(没有 `trust` 能力)时不问。侧栏 switcher 旁的 "…" 菜单第一项是当前 workspace 的 "Trust this folder"(先确认,说明同上)或 "Stop trusting this folder"(直接生效);环境未连接或 daemon 不支持时没有这一项。

设置文件 `settings.json` 是 `{ "environments": [{ id, name, kind: "local" | "remote", transport?: { type: "ssh", host, command? } }] }`。旧格式 `{ "hosts": [{ id, name, kind: "ssh", host, command? }] }` 读作 remote 加 ssh transport,id 不变(会话和草稿都按 id 认);只有保存时才写新格式;这个版本读不懂的条目(更新的版本写的)不显示,但保存时原样写回。

### workspace

- **workspace = 环境里的一个 cwd**,即 `(environmentId, cwd)`。同一个路径在两个环境里是两个 workspace。
- 不把 git 仓库的子目录或 worktree 合并成一个项目(old-cycle 是按 git 主 checkout 合并的;咱们 v1 没有 worktree,以后要合并时再决定)。
- 远程环境的 workspace 在侧栏里带一个**图标**,hover 的 tooltip 写它属于哪个环境(名字,以及连接状态);本地的没有图标。环境名不能只靠 tooltip:图标有可访问名,里面包含环境名。不同环境里同名的目录,标题再带上环境名区分。
- 在一个 workspace 里新建 session,就在它的环境里新建。要在别的环境里工作,就是选另一个 workspace,或者"New workspace…"时先选环境、再在那个环境的文件系统里选文件夹。

### 侧栏

一次只显示一个 workspace(沿用 old-cycle 2026-11-08 的决定):

- 显示哪个:你在 switcher 里选的,直到打开了别的东西;然后是当前打开的 session 或草稿所在的 workspace;最后是最近有活动的(`updatedAt` 最大的)。从列表里打开任何一行,都会放弃 switcher 的选择。
- **Switcher** 是一个菜单,列出所有 workspace,按环境分组(本地在前;多于一个环境时才显示分组标题,标题带连接状态),组内按 `updatedAt` 倒序。只有一个环境时,没有按环境分组的标题(没有可选的东西)。
- Switcher 上有一个方块数字徽章,数**其他 workspace**(所有环境)里最紧急的那一类;完整的计数写进 aria-label。
- 搜索跨所有 workspace 和环境,结果按 workspace 分组。
- 版式(DESIGN.md §4.1):顶部是 New session、Search,其下是 switcher(它是下面会话列表的标题);只有中间的会话列表滚动;底部一行是版本、更新状态和进入设置页的按钮(见下面"设置页")。

当前 workspace 里的会话分组:**Needs you**(`requires_action`)、**Running**(`running`,以及有后台子 agent 的)、然后 Today / Yesterday / Earlier,按本地日界线分,用 `updatedAt`。每个 workspace 默认显示 20 条,"Show N more";有状态的和当前打开的永远显示。

一行只带一个状态标记,优先级:`requires_action` > `running` > background(`cycle/background` > 0)> unread(`cycle/unread`)。来源都是 daemon 的列表字段。

排序用 `updatedAt`,不用 `cycle/lastSeq`(后者按记录条数,不是时间)。旧 daemon 的 session 没有 `updatedAt` 时排在有的之后,彼此按 `lastSeq`。

### 待定

- Switcher 分组:同一个 workspace 里有 session 在别的环境的情况不会出现(workspace 属于一个环境),所以不需要处理。如果以后同一个仓库要在本地和远程之间对应起来,那是另一个决定。

## 页面的安全设置

agent 的输出是不可信的:里面可以有原始 HTML、链接、图片。

- **窗口**:`contextIsolation`、`sandbox`、`nodeIntegration: false`。页面里没有 `require`、`process`、`ipcRenderer`,桥上只有约定的方法(`API_METHODS` 加 `onEvent`,冒烟测试逐项断言)。
- **IPC**:main 只接受来自应用自己页面(`senderFrame.url` 等于 index.html)的调用。
- **导航**:不能跳转,不能开新窗口;http/https 链接交给用户的浏览器。无权限(`setPermissionRequestHandler` 一律拒绝)。
- **CSP**:`default-src 'none'`,`connect-src 'none'`,没有 frame、没有内联脚本,`img-src` 只有自己和 data:。
- **Markdown**(`packages/ui/src/react/markdown.tsx`):丢弃原始 HTML;只有 http、https、mailto 是链接,其余是文字(相对路径不加 "[blocked]");点链接先确认，确认框显示完整地址，确认后才由 main 交给系统浏览器(`AgentLink`,网页搜索结果的链接相同);图片从不加载,显示成文字。Streamdown 自己的默认是允许所有图片和链接前缀,所以这几条不交给它(DOM 测试逐项断言)。
- **Mermaid 图**(`packages/ui/src/diagram.ts`,理由见决定笔记 [`2026-11-22-mermaid-diagrams-as-images`](../.agents/notes/2026-11-22-mermaid-diagrams-as-images.md)):` ```mermaid ` 围栏闭合后由 mermaid.js 画，`securityLevel: "strict"`、不用 HTML 标签，图自己的 `%%{init}%%` 改不了这些和主题。画出的 SVG 不进页面 DOM:序列化成 `data:` URL,用 `<img>` 显示，作为图片它不执行脚本、不加载任何东西、链接不可点;排版时 mermaid 临时插进页面的节点仍受上面的 CSP 约束。不用 Streamdown 的 mermaid 插件(它把 SVG 直接插进页面)。mermaid 在第一张图时才加载。
- **`--no-sandbox`** 只在冒烟测试里用(测试机上没有 setuid 的 chrome-sandbox),窗口本身仍然是 `sandbox: true`。应用不带这个参数。

## 样式:Streamdown 带来了 Tailwind

Streamdown 的标记用 Tailwind 的工具类,而且用的是 shadcn 的颜色名(`text-muted-foreground`、`bg-sidebar`……),Tailwind 只在这些名字有定义时才生成对应的类。所以:

- `packages/ui/src/styles/app.css` 引入 Tailwind、ui-sdk 的 `web.css`(在 `components` 层)、Streamdown 的样式,`@source` 指向 Streamdown 的代码,并用 `@theme inline` 把那些颜色名映射到 ui-sdk 的 `--ui-*` 变量。换 ui-sdk 的主题,Markdown 也跟着换。
- 一个 DOM 测试检查 Streamdown 渲染出的每个工具类都在构建出的 css 里。它抓到过缺口(上面的颜色名没定义,Markdown 会"光着身子")。
- 生成的 `built.css` 不进 git;`bun run check` 的第一步会生成它。

## 测试

- 门禁里(`bun run check`):会话模型、store(假桥接)、`ConnectionManager`(真 daemon)。
- 界面(`bun run test:browser`,CI 的 `browser` 作业):页面组件和 Markdown 安全,在无界面的 Chromium 里,用真实的布局和输入事件(`packages/ui/test/browser/*.browser.tsx`,见 [testing.md](testing.md))。
- `packages/client`:`bun run test:integration` 把客户端打成包,用 Electron 自带的 Node 跑,证明它在 Node 下能用(Bun 通过自己的测试说明不了这一点)。
- `apps/desktop`:`bun run test:integration web`(会先 `build`)。构建出的页面在无界面的 Chromium 里,用浏览器自己的鼠标和键盘事件操作,后面是真的 `ConnectionManager`(和主进程里的同一个)、真 daemon、Claude 适配、真 SDK 和模拟 API:连上环境、点击和打字创建 session、打字和粘贴 Markdown、发消息、看到流式回答、出现权限卡片并点击 Allow(工具真的运行了)、重载页面后会话回来。页面的桥接由测试按 preload 的样子造出来(`test/web/web-app.ts`);preload 本身和页面的锁定由 `bun run test:integration package` 在打包后的应用里检查。

## 真实模型下的窗口

`CYCLE_REAL_MODEL_TOKEN=… bun run test:real`(在 `apps/desktop` 下,先在根目录 `bun run build`):构建出的页面在无界面的 Chromium 里(2026-11-21 前是 Electron 窗口;下面的记录是那时的),浏览器自己的鼠标键盘,daemon 是构建出的可执行文件,token 只写在它的 `config.json` 里,模型 haiku。约 16 秒。依次:连接、新建 session、问一个词、让它用 Bash `touch` 一个文件、点 Allow、让它写一段带标题、列表、表格和代码块的 markdown,让它用任务工具建两个任务,最后重载页面看历史是否回来。通过(头部显示用量,对话里有计划)。截图(`SHOT_TO=路径`)里:标题、列表、表格、带语言标签和行号的代码块都正确渲染;工具卡显示命令和"completed"。

这次发现并改掉的是**测试自己的问题**:先是等待条件会被用户输入的 prompt 本身满足(prompt 里就含"pong"和"finished"),现在只看 agent 消息;再是重载发生在回合收尾之前,界面显示"working",现在等回合结束。

## 踩过的坑(都在测试里有对应)

- Electron 的主文件是 ES module 时,**不能在顶层 await `app.whenReady()`**:ready 要等主文件执行完才发出,等于自己等自己。冒烟测试因此挂过。
- Bun 在 Electron 的主进程里不存在:客户端用 `node:net` 和 `node:child_process`,门禁拒绝在这些目录里用 Bun 的 API。
- 点击输入框时如果对话框还在关闭动画里,点击会落在别处。冒烟脚本点到输入框真的拿到焦点为止。

## 自动更新

只在安装好的 macOS 应用里启用;`bun run start` 的开发运行里显示"Updates are for the installed app",不检查。实现在 `src/main/updater.ts`,所有外部依赖(网络、解压、进程、定时器)都注入,门禁里用假的 GitHub 测试;`test/integration/update.integration.ts` 在 macOS 上用真实的包走完整个流程(release 工作流里跑)。

- **检查**:启动时一次,之后每 60 秒一次;设置页 General 里的 "Check for updates" 立即检查,有新版本时同一行也有 "Update and restart"(与顶部横幅同一个确认框)。后台检查失败(断网、被限流)不提示,用户自己点的检查会显示原因。
- **发现**:读 GitHub 的发布列表(带 `If-None-Match`:内容没变时 GitHub 回 304,据 GitHub 文档不计入未登录的每小时 60 次限额),取比当前版本新、不是草稿、带本平台清单文件(`latest-darwin-arm64.json`)的最高版本。不能用 `/releases/latest`,因为它跳过 pre-release,而没签名的发布都是 pre-release。
- **安装**要用户确认:顶部横幅 "Update and restart" → 确认框(会说明本机上正在工作的会话会被中断)。然后在应用旁边的隐藏目录(同一个卷,最后的替换是 rename)里得到新包:**按差分**(见下)或整包下载,校验大小和 SHA-256,`ditto` 解压;检查得到的包的版本、平台和清单一致;当前应用有 Developer ID 签名时,还要新包签名有效且是同一个团队。
- **差分**(`src/main/delta.ts`,决定笔记 `2026-11-18-update-by-the-difference`):清单除了整包的 `file`/`sha256`/`size`,还有 `tree`,即包内每个文件(路径、模式、大小、SHA-256)、链接和目录的表,发布时由 `release-assets` 对最终签名的 `.app` 扫出。客户端拿它和已安装的包比较:没变的文件从已安装的包复制(APFS 上是克隆,不占空间),缺的或变了的,用 HTTP Range 从同一个 zip 里取(先读末尾的中央目录,相邻的小文件合并成一次请求,大文件单独流式解压),不另发补丁。信任的是文件表(来自清单,与整包的 SHA-256 同一条信任链;差分时**不**再检查整包的 SHA-256 和大小,因为整包没有下载):拼出的包里每个文件都要等于它的 SHA-256,包的形状(文件、链接、目录、模式)要与它完全一致,然后照常过版本、平台和签名检查。文件表的路径必须在包内(相对、无 `..`、不重复、父目录先列、链接不出包、模式只有 rwx),不合格的表整张不用。服务器不支持 Range(必须是 206 且 `content-range` 与请求一致)、哈希不符、检查不过、或要取的超过整包的 80%,都**回退整包下载**一次(请求被限流或磁盘写满除外:整包会遇到同样的事,直接报错;并行取文件时一个失败,其余请求立刻中止),原因写进日志(`[update] …`),进度条的总量随之换成整包。没有文件表的发布(0.2.1 及以前)和没有这段代码的客户端都是整包。顶部横幅在差分时写 "Downloading the changes for 0.2.2"。
- **替换**:先停掉旧应用带起来的本地 daemon(它跑在旧包里,不停的话替换后会留下一个找不到 `claude` 的旧 daemon),再由一个脱离的小 shell 脚本等旧进程退出后 `mv` 换包并 `open -n` 打开新的;替换失败会放回旧包并照样打开。不在运行中的进程自己换自己,是因为替换正在运行的 Electron 的包可能让它崩溃。下次启动清理遗留的临时目录。
- **下载只来自**仓库自己的 release 地址(`https://github.com/OhMyJames/cycle/releases/download/`)。从 0.3.16 起,发布(打 tag 时仓库变量 `RELEASE_SIGN=true`)用 Developer ID 签名并公证,已签名的应用只接受同一团队签名的更新,来源由签名证明。0.3.15 及以前的 ad hoc 包发布在旧仓库 `OhMyJames/Cycle-V1`,只看那里的更新,要手动重装一次新版本。打开签名后,之后的每次发版都必须签名(签名用的证书和 API key 在仓库的 Actions secrets 里),否则已签名的应用会拒绝更新。
- **装不上时**会提前说明:应用所在的目录不可写,或应用是从下载位置直接打开的(App Translocation,只读)。
- 测试用的 `CYCLE_UPDATE_URL` 只接受 `127.0.0.1` 或 `localhost`,不能把应用指到别处。
- 测试用的 `CYCLE_TEST_HIDDEN_WINDOW=1` 让应用不显示窗口、不发系统通知;macOS 上应用也不进 Dock、不能到前台。窗口里的页面照常运行,测试经 DevTools 读它。

## 窗口的大小和位置

应用再打开时,窗口回到上次的大小、位置,以及是否最大化、是否全屏(`apps/desktop/src/main/window-frame.ts`)。主进程把它写在应用数据目录的 `window-frame.json` 里:移动、改大小停下约半秒后写一次,关窗时再写一次;存的是正常状态下的框,所以从最大化或全屏退出时回到原来的大小。启动时只在当前接着的屏幕上恢复:窗口横竖都至少有 100px 落在某块屏幕的可用区域内才用它,并挪进、缩进那块屏幕(不小于最小尺寸 720×480),标题栏总能拿到;那块屏幕拔掉了、文件读不懂,就用默认的 1200×800,在主屏幕居中。Mac 上的 `hiddenInset` 标题栏不变。测试的隐藏窗口(`CYCLE_TEST_HIDDEN_WINDOW=1`)不读也不写这个文件。没有用户动作,不埋点。

## 代码配色、图片、搜索

- **代码配色**:Streamdown 2.x 自己不带语法高亮,它是单独的插件 `@streamdown/code`(Shiki,JavaScript 正则引擎,不需要 WebAssembly,CSP 不变)。设置页的 Appearance 里可以在五套配色里选(见 DESIGN.md 附录 B,含各套的对比度),下面有一段示例代码,按对话里代码块的样子画,选了立即看到。打包开了分包:语言和主题按需加载,启动约 0.9 MB,全部约 12 MB。
- **图片**:agent 和用户消息里的图片(png、jpeg、gif、webp;svg 不是)用 data URL 画,不请求网络;超过大小上限的显示成一行字。Markdown 里的远程图片仍然不加载。用户消息里附加的文件(ACP `resource`)只显示带文件名的小片，内容从不渲染。
- **图表**:agent 回复里的 ` ```mermaid ` 画成图(安全设置见上)。围栏还没写完、正在画、画不出来时都显示原来的代码块，节点不换，不闪;画不出来时下面写一行 "This diagram could not be drawn, so its source is shown."。图下的 "Show source" 切到源码(带 Copy),"Show diagram" 切回;按下图片放大(和图片同一种对话框,Esc 关闭)。颜色取自 `--cycle-*` 令牌，深浅色各画一次，跟随系统切换;图里用系统字体(图片里用不了页面的字体)。埋点:`diagram_opened`、`diagram_source_shown`,都不带内容。没做：缩放和平移，图里文字不能选中。
- **搜索**:⌘K(Windows、Linux 是 Ctrl+K)。

## 输入框(composer)

- **Markdown 输入**(决策笔记 `2026-11-18-composer-text-is-markdown`):输入框是 Lexical 编辑器,文本即 Markdown,边写边渲染;发出去的是敲下的字(`composer-markdown.ts` 把 Lexical 会改写的字符换成私用区的占位再换回来,测试覆盖固定样例和随机文本)。Enter 发送,Shift+Enter 在任何时候都是换行(Alt+Enter 同),输入法组合中的 Enter 不发送。agent 运行中:Enter 在 agent 和 daemon 都支持插入时把消息插入当前 turn("Send now",见 protocol.md §8 和决策笔记 `2026-11-19-steer-into-the-running-turn`),不支持时排队;⌘Enter(非 Mac 为 Ctrl+Enter)排队("Queue",按钮的提示里写着),空闲时 ⌘Enter 就是发送;有权限请求等着回答时 ⌘Enter 仍归权限卡的 "Allow once",输入框不拿它排队(决策笔记 `2026-11-20-composer-keys-shift-enter-newline-cmd-enter-queue`,CYCL-75)。`prompt_sent` 带 `via`(`enter`/`shortcut`/`button`),只报按了什么。粘贴图片变成附件,粘贴文字按文字放入。
- **草稿**:每个 session 一份,文字存在渲染进程的 localStorage(键含主机和 session),图片和附加的文件只在内存里;发送、删除 session 时清掉。发送失败,内容放回输入框。
- **排队**:agent 工作时同一个框继续写,Queue、Send now、Stop 和输入在同一行,框不因按钮多而变高(CYCL-75);排队的消息列在输入框上方,可以 Edit 取回;停止或出错后 daemon 退回的消息自动放回输入框(不当作错误)。
- **会话设置**：输入框工具条显示权限模式、模型和可用的 effort。模型和 effort 是相邻的两个芯片，各开一个菜单（芯片只有文字，不带向下箭头：工具条上一眼看得出能点）（CYCL-73 之后拆开：同一弹层里的滑杆在设置生效前显示了还没生效的档位，再选回原档位时不会发出，看起来像跳回去）。effort 菜单只列该模型支持的档位（来自模型选项的 `cycle/efforts`，protocol.md §10）；模型不支持时没有 effort 芯片，`default` 不单独成行：它是 Claude Code 在不指定时用的档位，按实测写作 `medium`，菜单里显示为 “Medium (default)”，芯片同样，选它就是发 `default` 清掉覆盖；会话明确设成 medium 时另列一行 medium，才看得见、清得掉；模型不列 `medium` 时才保留一行 “Model default”（芯片 “Default effort”）。模型菜单同理：`default` 不是单独的 “Default”，而是它实际指向的型号，如 “Opus 5.5 (default)”（agent 用 `resolvedModel` 与同型号的别名行合并；会话明确固定在那个别名上时，别名行仍单独列出；说不出是哪个型号时才保留 “Default model”），各行写版本号。新会话页换到不支持当前档位的模型时，effort 一并改回 default；已有会话由 agent 改回并回报。列表短，不带过滤；打开时焦点在列表上，↑/↓、Home/End、Enter 选择，Tab 离开并关闭，Escape 关闭并把焦点还给芯片（CYCL-73）。芯片和菜单只显示会话已有的值：选择后由 daemon 的会话列表带回新值才变。还在路上的选择是下一次选择的参照：再选它不重发，选回会话现有的值会发出，所以最后一次选择就是最终生效的；请求结束而值没变（被拒绝）时，同一个选择可以再发。会话标题菜单里的 Session settings 显示全部设置。当前值来自 daemon 会话列表的 `cycle/config`。agent 自己切换模式时，daemon 更新索引并通知客户端刷新列表，已打开的控件随之更新。重连或重新打开历史会话也从列表读取当前值，回放的 `config_option_update` 提供会话的选项。旧会话没有记录的值显示 “Not set”。
- **上下文用量（CYCL-74）**：输入框工具条右端是用量环，显示 agent 报的已用占窗口的比例（不到 1% 写 “<1%”）。它是按钮，点开是和模型、权限同一种弹层，按 Claude Code 的 `/context` 的样子直接列数字，不写说明：第一行是 “Context window” 和 “已用 / 窗口（百分比）”；下面一条按部分分段的条；再下面每个部分一行（色块、名字、token、占窗口的比例），用到的按大小排，然后是给压缩留的、剩下的，没加载进窗口的工具定义（`deferred`）不列；最后是自动压缩点、本会话费用、完成的压缩次数。各部分来自 `usage_update` 的 `_meta["cycle/context"]`（protocol.md §8），按 `id` 用 Cycle 自己的文字，不认得的用 agent 给的名字；agent 没给就只有总数和条。只列 agent 报过的。只有三种没有数字的状态写一行字：还没有用量（环是空的）、正在压缩、压缩完成后还没有新的用量（环的底圈改成虚线、弧线变淡，条变淡，不列各部分，因为它们是压缩前的）。下面是订阅账号的 “Plan usage”：每个限额一行（5-hour limit、Weekly limit，以及按模型的周限额），写用掉的比例和多久后重置（一小时内写分钟，一天内写小时分钟，再远写星期和时间），下面一条细条；快到时（70% 或 agent 说 warning）用注意色，到了（90% 或 rejected）用危险色。数据来自 daemon 记住的该 agent 账号的最新一份（protocol.md §8 “套餐用量”），所以同一环境的会话看到的是同一份；过了重置时间的那一行不再显示；API key 登录没有这一段。点开发 `context_details_opened`，只带是哪种状态、有没有列出各部分、有没有显示套餐用量。
- **回看**:空输入框里按 ↑ 取回上一条发过的消息(从对话里读),↓ 回来;只有光标在首块、末块时才生效。
- **命令**:消息最开头的 `/` 列出 agent 的命令(`available_commands_update`),空格之前有效;**提及**:`@` 之后列出 session 目录里的文件和文件夹(`_cycle/files/search`),文字里写 `@路径`,发送时另附 `resource_link` 块(决策笔记 `2026-11-18-mentions-are-resource-links`)。daemon 声明 `sessionMentions` 时,菜单在文件和文件夹之后另有 **Sessions** 一组:同一 environment 里标题含所输入文字的其他 session(不含当前这个和已归档的),最近的在前,最多 6 个;两组都有时各带小标题,只有文件时和以前一样不分组。文件结果到了才一起显示,行不会在指针下移动。选中的 session 在文字里写 `@标题`(去掉 Markdown 会读成格式的符号),附一个 `cycle://session/<id>` 的 `resource_link`;daemon 发给 agent 时把它换成那个 session 的简短记录(docs/protocol.md §8,决策笔记 `2026-11-22-session-mentions-expand-in-the-daemon`)。发出的消息里 `@标题` 画成带对话图标的标签(chip),悬停显示完整标题,不显示 agent 收到的记录;输入框里仍是 `@标题` 文字。旧 daemon 没有这一组。两种菜单都以整个输入框为宽,单行时输入格很窄也不受影响(窄窗口下实测 320px 宽的主区);长文件名末尾省略,目录提示最多占一行的 40%;`@` 之后文件夹里什么都没有时写 "This folder has no files or folders."(CYCL-75)。
- **测试**:界面测试在真实浏览器里对输入框真的敲字和按键(`test/browser/box.ts`);粘贴在 `web` 套件里走(`web.integration.ts` 敲 `**bold**` 并检查渲染,再粘贴一段带星号的文字,检查它按原样放入)。
- **系统输入法验证（CYCL-110，2026-11-20）**：macOS 26.5.2、Electron 45.3.4，使用独立应用数据目录、真实 composer、系统输入源和原生键盘事件。简体拼音在 `@` 后输入 `nihao`，↓ 选择候选，第一次 Enter 确认“你好”并保留草稿，第二次 Enter 选中 `你好.md`。日文罗马字输入也观察到 Enter 结束组合并保留草稿。两种输入法的候选窗均出现在输入行下方。在组合中触发 Electron 的粘贴命令，中文确认后留下 `@你好PASTE_MARK`，日文确认后也保留了组合文字和剪贴板标记。
- **组合期间的 ⌘V（CYCL-116）**：macOS 在 Electron 的 `before-input-event` 之前便把按键交给了输入法。桌面主进程通过 AppKit 在本应用内处理按键：当前编辑器有组合文字且按下 ⌘V 时，先让应用菜单执行快捷键。用上述系统简体拼音复测，普通和组合中的 ⌘V 均只触发一次 paste。在 `@nihao` 的候选未确认时粘贴 `PASTE_MARK`，再用 ↓ 和 Enter 确认，草稿为 `@你好PASTE_MARK`。单独验证提及时，第一次 Enter 确认“你好”，第二次选择 `你好.md`，均保留在草稿中。
- **没做**:@ 提及没有 chip 节点(是普通文字加一个记在草稿里的链接),所以从存储恢复的草稿里文字还在、结构化的链接没有;提及里没有别的 session;输入历史只读当前对话里的消息;Lexical 对撤销/重做、拖选等的行为没有逐项验证。

## 设置页(CYCL-56)

应用级的设置在一个**整窗页面**里,不再分散在菜单和对话框中。侧栏底部的按钮或 `⌘,`(非 Mac 为 `Ctrl+,`)打开;页面打开时,侧栏的位置换成"Back to sessions"和分区导航,右边是选中的分区。`Esc`、Back 或再按一次 `⌘,` 回到会话;`⌘N`、`⌘K` 在页面上仍然可用,新建或选中会话就离开页面,系统通知点开的会话也一样。会话那一侧在页面下面保持挂载、只是不显示(`hidden` 加 `inert`),所以回来时对话的位置、展开的工具、没写完的消息都在。

- **框架**(`page-layout.tsx`):`PageLayout`(返回、分区导航、分区内容)、`PageGroup`、`PageRows`、`PageRow`。分区导航是 SDK 的 Tabs 竖排:方向键切换,只挂载当前分区。Connectors 升级为页面(CYCL-57)时复用它。
- **General**:界面语言(见下);版本、更新状态、"Check for updates"(开发运行不能更新时不显示按钮,只说明原因)、有新版本或安装失败时的 "Update and restart";统计开关(Usage statistics)。没有上报目标,或用环境变量 `DO_NOT_TRACK` / `CYCLE_ANALYTICS=off` 关掉时,不显示开关,规则与以前的菜单项相同(docs/analytics.md);首次启动的说明仍在会话页顶部,文字改为指向 Settings。
- **Appearance**:主题(Match system、Light、Dark,见下)、代码配色和示例。
- **Environments**:每个环境一行:状态(点、词)、名字、远程的 ssh 地址,断开时下面是 ssh 的原话和 "Connect again";远程环境行尾的菜单里是 Edit、Remove(先确认)。"Add environment" 在分区右上。增、改仍是原来的表单对话框,开在设置页上面。
- **Session defaults**:原来的 Agent defaults 对话框。连着多于一个环境时先选环境(默认是当前打开的那个),agent 多于一个时再选 agent;读不出来时不显示空表单、不能保存,给 "Read settings again";保存成功后按钮旁写 "Saved",保存失败不写(原因在页面顶部的错误条里)。一个环境都没连上时说明原因,并给去 Environments 的按钮。
- **Keyboard shortcuts**:只读的清单,列出全部快捷键和按键(DESIGN.md §5.4 的那一张),按"应用"和"会话中"分两组。不能改键:改键要处理冲突、输入法和原生菜单,没有排进这一轮。
- **主题和语言(CYCL-79)**,理由见决定笔记 [`2026-11-22-appearance-and-language-preferences`](../.agents/notes/2026-11-22-appearance-and-language-preferences.md):
  - 由**主进程**保存和应用。页面经桥上的 `preferences()` 读、`setPreferences()` 改;主进程先写 `preferences.json`,写成功才生效,写不成就报错、什么都不变。读不懂的值(手改坏的、更新的版本写的)按"跟随系统"处理,文件里不认识的键原样写回。
  - **主题**用 Electron 的 `nativeTheme.themeSource`:窗口里的 `light-dark()` 和 `prefers-color-scheme`、代码配色的深浅、原生的菜单和对话框一起变,样式不用改。启动时在建窗口之前就应用,所以第一帧就是选定的主题。
  - **语言**:English 和简体中文两份目录(`packages/ui/src/messages/`),每种语言用它自己的名字列出。"Match system" 取系统首选语言:简体中文的 locale(`zh`、`zh-CN`、`zh-Hans-*`)用中文,繁体(`zh-TW`、`zh-HK`、`zh-Hant-*`)和其他语言用 English。选了立即整页切换,不用重启;页面在读到偏好之后才画第一屏,所以不会先闪一下英文。`<html lang>` 跟着变。主进程自己说的话里,系统通知跟随所选语言。
  - **不翻译的**(decision 0012):agent 的输出、ssh 和 daemon 的原话、命令、路径、版本号、agent 给的设置名和选项名;另外主进程自己产生的报错(更新失败的原因、"Updates are for the installed app."、本机环境的名字 "This computer")目前仍是英文。
  - 埋点:`theme_changed`、`language_changed`(主进程发,只带选了哪一项)。
  - 中文目录的键和占位符与 en-US 一致由类型和测试保证(`test/languages.test.ts`);译文本身没有经过母语审校之外的检查,真实窗口里各处的中文版式只在画廊里看过设置页和一个对话场景。
- **旧入口**已去掉:侧栏底部的 App settings 菜单、switcher 旁菜单里的 Add environment、Agent defaults、Edit、Remove。会话自己的设置(Session settings)仍在会话标题的菜单里,它属于会话。
- **埋点**:打开页面是 `panel_opened` 的 `settings`(带 `via`),换分区是 `settings_section_shown`;分区里的动作沿用原有事件(`analytics_toggled`、`update_checked`、`environment_saved`、`agent_defaults_saved`、`code_theme_changed` 等)。
- **没验证**:安装版真实窗口里的拖动区域和红绿灯位置(画廊里看过版式,深浅色、1200×800 和 720×480)。

## Connector

侧栏顶部的 **Connectors** 打开一个面板,管理某个环境的 daemon 替所有 agent 保管的 MCP 服务器(protocol.md §14)。只列已连接、并且声明了能力 `connectors` 的环境;一个都没有时就这样说。

- **列表**:每行是名字、去哪里(http 的主机,或 stdio 的命令)、状态(Ready、Needs sign-in、Off,出错时按 `reason` 写成固定的句子)、开关,需要登录的 OAuth 服务器有 Sign in;编辑、退出登录、删除在行尾的菜单里。删除前先确认,因为它的登录和密钥会一起永久删掉。
- **表单**:名字;远程 URL 或本地命令(参数一行一个、可选的工作目录);远程的可以选 OAuth,并可填 client id(给不支持动态注册的服务器)。密钥是 http 的请求头或 stdio 的环境变量,**只写不读**:页面送出值,之后只看到名字和"已设置",能替换或删除,看不到值。
- **凭证上线路的方向**:这是 `config.json` 那条"不让凭证上线路"之外唯一有意的例外,而且只有一个方向。页面把用户填的密钥经主进程送给 daemon;daemon 从不回传。OAuth 的授权码不经过页面:主进程在 `127.0.0.1` 的随机端口开回调,把这个地址交给 `auth/start`,用 `shell.openExternal` 打开 daemon 给的地址(只开 https,或指向本机的 http),拿到回调后把 `code`、`state` 交给 `auth/finish`。PKCE 的 verifier 在 daemon,授权码单独拿到没有用。同一时间只有一个登录在等浏览器,新的会取消旧的;最多等十分钟;回调服务器在每条路径上都会关掉(`connector-auth.ts`,`test/connector-auth.test.ts`)。
- **错误**:daemon 的拒绝(`data.reason`)在主进程变成固定的词(`connectorProblemOf`),页面按词显示整句,并写在出问题的那一行或表单下面。
- **埋点**:`connector_added`(传输、登录方式、密钥个数)、`connector_changed`、`connector_removed`、`connector_authorized`(`ok`/`failed`/`cancelled`)、`connector_signed_out`,打开面板是 `panel_opened` 的 `connectors`。不发名字、URL、命令和密钥(`test/manager-connectors.test.ts`)。
- **没验证**:真实的授权服务器(测试里是假的 daemon 和假的浏览器);真实窗口里的样子和深色模式。

## 终端(CYCL-98)

右侧面板里可以开 session 的终端:shell 跑在 daemon 那边,在 session 的文件夹里,本地和 ssh 一样(protocol.md §8"终端",决定笔记 [2026-11-22-terminals-in-the-daemon-over-l1](../.agents/notes/2026-11-22-terminals-in-the-daemon-over-l1.md))。daemon 没有能力 `terminal` 时,界面上没有终端的入口。

- **入口**:会话头部的终端按钮。没有终端时开一个;有就显示上次看的那个,没看过就显示最新的;正在看终端时再按就收起面板。面板标签条末尾的 **New terminal** 再开一个。每个终端一个标签,排在 Overview、Files、Diff 之后,标题是 shell 的名字,shell 设了标题就换成它。
- **标签从哪来**:终端是 daemon 的,不存在页面里。标签条显示的就是 daemon 列出的这个 session 的终端(`_cycle/terminal/list` 加 `changed` 通知);`side-panel.ts` 只记住上次显示的是哪一个。所以重开应用、刷新页面后标签还在,从 daemon 的屏幕重画。
- **关闭**:点标签上的叉,或者焦点在标签上时按 Delete 或 Backspace。关闭会结束 shell 和里面跑的东西,不再确认(删除会话才要确认)。关掉正在看的标签时,显示它前面那个。daemon 没收到关闭(连接正好断了)时,说出原因,重新读列表,shell 还在的话标签回来。
- **显示和输入**:页面用 `@xterm/xterm` 画,只有显示着的标签附着(`attach`),切走或收起就 `detach`,不看的终端不占这边的资源。`attach` 的应答和输出走两条路,先后不定:输出先到的先存着,应答到了以后丢掉屏幕里已经有的(`seq` 不大于应答的),落后时 daemon 发 `reset` 也一样(`terminals.ts` 的 `TerminalFeed`)。按键和粘贴原样发出,大段粘贴切成小于 64 KiB 的几段。复制粘贴用的是应用菜单的复制、粘贴,xterm 自己处理,页面不需要剪贴板权限。
- **尺寸**:跟着面板变,停下来 80 ms 后告诉 daemon;附着之后和终端拿到焦点时各告诉一次(多个客户端以最后一个为准)。daemon 给的屏幕(附着的应答、`reset`)是按 daemon 当时的尺寸画的:先按那个尺寸写进去,再缩放回面板的尺寸,行和光标才对得上。
- **状态**:shell 退出后标签变淡,底部一行说退出码,带 **Close terminal**;环境断开时底部一行说断开了,不能输入,连回来后重新附着;连回来发现终端已经没了(daemon 停了,包括空闲退出),标签留着,说它随 daemon 停止而结束,用户关掉标签为止;附着失败时说原因,可以重试。打不开时(数量到上限、会话已归档、文件夹不在了、shell 起不来、daemon 正在停止)主进程把 daemon 的拒绝转成固定的词(`terminalProblemOf`),页面显示对应的整句。
- **颜色**:底色、文字、光标、选区取 Cycle 的令牌,跟着深浅色变;16 个 ANSI 颜色是程序输出的内容,和代码配色一样用 GitHub 的配色(`terminal-theme.ts`)。
- **键盘**:焦点在终端里时,按键先给 shell。macOS 上 ⌘ 组合键 xterm 不处理,应用的快捷键照常;其他平台上 Ctrl 组合键归 shell,面板用按钮开关。
- **埋点**:`terminal_opened`、`terminal_closed`、`terminal_open_failed`,只有入口、状态、个数分档和原因的固定词。不发 shell、目录、输入和输出。
- **测试**:规则在 `packages/ui/test/terminals.test.ts`;界面在 `test/browser/terminal.browser.tsx`(假的 bridge);真 daemon 和真 shell 在 `apps/desktop/test/integration/web.integration.ts` 里:打开、输入、看到输出、刷新后重画、关闭。
- **没验证**:远端(ssh)环境上的终端,和打包后的真实窗口里的复制粘贴。

## 公共组件(CYCL-52)

后面的界面(设置页、右侧面板、空 session 页)都从这些部件搭,不再各写一套。清单来自 CYCL-64 的盘点(2026-11-21),只看首批消费者:输入区(权限、模型、Effort 芯片和 context 详情)、设置(盘点时是 Agent defaults、Session settings 两个对话框和侧栏底部的 App settings 菜单;CYCL-78 起应用级的都在设置页)、右侧面板(还没有,按[右侧面板笔记](../.agents/notes/2026-11-19-right-panel-scope.md)预留)。规格在 DESIGN.md 第 3 层。

| 部件                  | 盘点时的样子                                                                                                                                                                                                                                                              | 缺口                                                                      | 处理                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 菜单 `Menu`           | SDK Menu 用在 7 处;输入区的三个芯片另有一套手写的 `role="menu"` 弹层,外观、键盘、对勾位置都和 SDK 的不同                                                                                                                                                                  | 两套菜单                                                                  | CYCL-65:芯片改用 SDK Menu 的单选组,全应用一种行(对勾在行尾)                                                                                                                                                                                |
| 弹出层 `Popover`      | `anchored-popover.tsx` 手写定位、点外关闭、Esc、焦点归还                                                                                                                                                                                                                  | 重复 SDK 已有的                                                           | CYCL-65:context 详情改用 SDK Popover,删掉手写的                                                                                                                                                                                            |
| 提示 `Tip`            | SDK Tooltip 一处没用;35 个原生 `title`,其中 10 个在只有图标的按钮上                                                                                                                                                                                                       | 原生提示慢、不跟随键盘焦点,名字写两遍                                     | CYCL-65:`tip.tsx`,只有图标的按钮由它命名;截断文字的全称仍用 `title`                                                                                                                                                                        |
| 候选列表 `PickerMenu` | `/` 命令和 `@` 文件的候选,`role="listbox"` 加 `aria-activedescendant`,焦点留在输入框                                                                                                                                                                                      | 无:这是 combobox 的做法,SDK 的 Menu 不适用                                | 保留                                                                                                                                                                                                                                       |
| 分栏与分隔条          | 侧栏用 SDK Resizable(键盘、上下限、折叠、记住宽度)                                                                                                                                                                                                                        | 还没有第二个面板;"双击复位"与 SDK 的"双击折叠"冲突;窄窗时覆盖还是挤压未定 | CYCL-66:`split-layout.tsx`,三栏同组,让位顺序按[右侧面板布局笔记](../.agents/notes/2026-11-21-right-panel-layout.md);双击沿用 SDK 的折叠                                                                                                    |
| 标签页                | 没有                                                                                                                                                                                                                                                                      | 右侧面板和设置页导航要用                                                  | CYCL-66:`panel-tabs.tsx`,SDK Tabs 套 Cycle 样式;CYCL-90 接进 App(`side-panel.tsx`):按会话记住开关和标签(`side-panel.ts`,最近 200 个会话,删会话或环境时一并删),会话头部的按钮和 `⌘\` 开关,埋点 `side_panel_toggled`、`side_panel_tab_shown` |
| 空、加载、出错、断线  | 没有公共组件:整页状态手搭 4 份(图标、标题、原话、按钮各有各的有无),文件夹和 Connectors 各有一套"加载/出错/空";"未连接 + Retry"在侧栏和主区各写一次;`hint` 一个 slot 承担空、加载、出错、状态、说明五种意思,出错时有的红有的灰;只有一处把原话等宽显示;加载只有文字没有转圈 | 一个状态块:图标 + 标题 + 说明 + 等宽原话 + 动作                           | CYCL-67:`state-block.tsx`,主区、新建会话页、会话、文件夹、Connectors、Agent defaults 已改用                                                                                                                                                |
| 设置表单              | 两个对话框共用 `ConfigForm`;Agent defaults 读取时什么都不显示,不是 `<form>`,文案写死                                                                                                                                                                                      | 加载态、回车提交                                                          | 加载态随 CYCL-67,文案随 CYCL-68,整页随 CYCL-78                                                                                                                                                                                             |
| 文案                  | i18n 棘轮的基线写着 53,实际 37(其中 7 个是误报);扫描器看不到单独成行的 JSX 文字、三元表达式里的文字和 store 里的报错                                                                                                                                                      | 约 40 处没进目录                                                          | CYCL-68:已迁完,只剩一条开发者才看得到的报错;扫描器能看到单独成行的文字和 `...Label`、`description` 属性,`--list` 列出全部                                                                                                                  |
| 横幅 `Banner`         | 6 处重复同一结构,没有组件                                                                                                                                                                                                                                                 | 同上的状态块可以覆盖                                                      | 以后,不在这一轮                                                                                                                                                                                                                            |

SDK 的几个坑(beta.6,写在这里免得再踩):

- Menu 和 Popover 的内容默认用 `aria-labelledby` 指向触发器,传进去的 `aria-label` 盖不过它:要按标题命名,给标题一个 id,在内容上传 `aria-labelledby`。
- 两个菜单先后打开时,`finalFocus="trigger"` 可能把焦点还给前一个菜单的触发器;要还给自己的触发器,传一个返回它的函数(`setting-chips.tsx`)。
- 鼠标打开的菜单,焦点在菜单本身、没有高亮项,第一下方向键落在首项;键盘打开的直接落在首项。程序化 `focus()` 改不了它的高亮,所以选择器不再"打开就停在当前值"上,当前值用对勾标出。

## 还没做

- **远端 daemon 的升级**:应用只更新自己和自带的本地 daemon;远端的 daemon 由用户决定何时升。应用带一个 `MIN_DAEMON_VERSION`(`src/shared/release.ts`),**远端 daemon 低于它**才在标题栏下面出现一行提示和一个"Update to x.y.z"按钮;高于或等于它就不提示,即使比应用旧(多数版本只改界面,不动 daemon)。`dev`(从源码运行)和读不出版本的不提示,本地的也不提示。
  - **什么时候抬高它**:应用开始依赖旧 daemon 没有的东西(字段、方法、行为),而且不能像 `capabilities` 开关那样"没有就关掉那个功能"。发版时问一句:这次有没有这种改动。可以关掉的功能用 capabilities,不动它。门禁测试保证它是合法版本号且不晚于应用自己的版本。
  - **按钮做什么**:确认后,应用用该环境同一个 ssh 主机(`BatchMode`,不交互)在远端运行 `daemonUpgradeCommand`(下载本版本的 tarball、校验、`install.sh`、`cycle stop`),`cycle stop` 让连接断开,重连时接上新的 daemon,已打开的会话原样保留。确认框里,如果该机器上有会话在工作,会列出它们,让人选"等它们结束再更新"(远端后台 `cycle stop --wait`)或"立即更新并中断"(`cycle stop --force`);没有在工作的就是普通的 `cycle stop`,它不会中断确认之后才开始工作的会话。见 [daemon.md](daemon.md)"停止和升级"。
  - **失败时**:那一行变成错误并附上同一条命令,让用户在那台机器上手动运行(远端连不上 GitHub、没有 `curl`/`sha256sum`、ssh 需要交互,都会走到这里)。第一版不做"应用下载再传过去"。
  - 按远端架构选用 Linux x64 或 ARM64 包。理由见 `.agents/notes/2026-11-19-daemon-minimum-version-and-upgrade-button.md`。
  - **协议不兼容(与上面的最低版本不同)**:最低版本说的是"能不能用",而协议主版本不同时 daemon 在握手就以 `-32022` 拒绝,连接根本建立不起来(docs/protocol.md §3)。客户端把它保留成带 `supported`(daemon 说它支持的)和 `requested`(应用要的)的结构化错误,初次连接和重连都一样;重连时仍按退避继续试,换上兼容的 daemon 后自己连上。环境的状态里带 `incompatible`:`with` 说哪一边要改(daemon 的主版本低于应用的是 `daemon`,高于的是 `app`,比不出来是 `unknown`)。界面在那个环境下显示一行原因:`daemon` 时给出远端 Linux 上更新 daemon 的命令(本地 daemon 不给,它随应用更新);`app` 时只说要更新应用,**不**提示降级 daemon。普通的 ssh 或网络故障不带 `incompatible`,仍是连接错误和重连。连接成功后这行消失。目前两边的主版本都是 `0`,这条路径要等协议升主版本才会走到。
- **会话内容的全文搜索**:⌘K 搜的是标题、文件夹、agent 和主机(跨已连接的主机)。对话内容的全文要在历史所在的 daemon 里做。
- **图片和文件的发送只对声明了能力的 agent 开放**:附加的控件(按钮、粘贴、拖放)只在 `_cycle/agents/list` 里这个 agent 的 `promptCapabilities.image` 或 `embeddedContext` 存在时出现;只有 `image` 时只收图片(按钮叫 "Attach image"),有 `embeddedContext` 时还收文本文件和 PDF(按钮叫 "Attach files",选择框不限类型),其余文件就地拒绝并说原因(决策笔记 [`2026-11-22-attach-any-file`](../.agents/notes/2026-11-22-attach-any-file.md))。带附件支持的 daemon(decision 0010)上的 Claude 声明了;更早的 daemon 不报告,界面上就没有附加入口,不会发出 daemon 不认的内容。主进程这一段有测试(`apps/desktop/test/manager.test.ts`):能力被报告,图片块原样送达 agent,没有声明的 agent 拒绝图片。
- **Claude 的 `config.json`**(`configDir`、密钥):没有 UI,因为它会把凭证放上线路。要在 daemon 所在机器上手改。CYCL-80 研究的结论是界面只显示状态(从不显示值)、修改仍在那台机器上做,见决定笔记 [`2026-11-22-claude-config-status-not-values`](../.agents/notes/2026-11-22-claude-config-status-not-values.md);还没有实现。
- 多窗口、可访问性审查(ui-sdk 的组件有基础的键盘和 ARIA,我们自己的部分没单独审)。
- 真实账号的浏览器 OAuth 授权暂缓（CYCL-110）。独立目录和凭证边界的验证见 [Claude 适配](adapters/claude.md#隔离登录验证)。

## 通知

一个你没在看的会话需要你(等你回答、做完了、agent 没了)时,主进程用系统通知告诉你;设计和限制见 DESIGN.md 附录 D。主进程在每次重读会话列表时和上一次比较(`ConnectionManager` 的 `attention` 选项),窗口在前面时不显示;点通知回到那个会话(`focus-session` 事件)。macOS 上通知需要应用已签名并经用户允许,这一点没有在 Mac 上验证。

断线期间一个正在看的会话被别的客户端删除时,重连后主进程发 `session-gone` 事件:界面丢掉这个会话的视图(包括它的权限卡片)、草稿和"当前打开"的选择。重连后某个会话的历史读不出来(`-32015`)时不发 `session-gone`(会话还在,视图和草稿保留):这个会话不再被观察,待答复的权限卡片按取消处理,其他会话照常恢复,主机回到 connected;它在列表里带 `historyFailed` 标记,重新打开会看到原因,也可以从列表删除。
