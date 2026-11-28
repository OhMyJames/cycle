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
- 远程 host 用系统的 `ssh`(`BatchMode=yes`,没有密码提示),在远端运行 `cycle proxy`;命令可在"Add location"里改。
- 设置在 Electron 的 `userData` 里:工作位置列表在 `settings.json`,外观、语言和下一轮输入建议的开关在 `preferences.json`(`{ "theme": "system" | "light" | "dark", "language": "system" | "en-US" | "zh-CN", "promptSuggestions": boolean }`,见"设置页"),统计的开关和匿名 id 在 `analytics.json`。

## 结构

| 部分                                   | 作用                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/manager.ts`     | `ConnectionManager`:页面在主进程之外能调的方法(`ManagerApi`)的门面,把下面四部分接在一起。不依赖 Electron,用真 daemon 测试 |
| `apps/desktop/src/main/runtime.ts`     | 工作位置列表,每个工作位置一个 `CycleClient`:连接、状态、重连、远端 daemon 的升级                                          |
| `apps/desktop/src/main/watcher.ts`     | 会话列表(以及其中值得通知的变化)和每个被观看 session 的会话                                                               |
| `apps/desktop/src/main/pending.ts`     | agent 等人回答的权限请求和表单:挂在各自的 session 上,另按 key 建索引                                                      |
| `apps/desktop/src/main/actions.ts`     | 页面对一个工作位置做的事(会话、文件、终端、agent、connector、plugin)和它们的埋点;失败作为回答返回的,走 `runAction`        |
| `apps/desktop/src/main/app.ts`         | 窗口、安全设置、IPC;只有它知道怎么连各种 host                                                                             |
| `apps/desktop/src/main/preferences.ts` | 外观和语言:读写 `preferences.json`,启动时和改动时应用主题。不依赖 Electron                                                |
| `apps/desktop/src/main/analytics.ts`   | 埋点的接线:匿名 id、开关、key 从哪来。事件字典和规则见 [analytics.md](analytics.md)                                       |
| `apps/desktop/src/preload/preload.ts`  | 给页面一个对象 `window.cycle`(`AppApi` 的方法加 `onEvent`),没有别的                                                       |
| `packages/ui/src/api.ts`               | main 与页面之间的契约(只有类型和方法名)                                                                                   |
| `packages/ui/src/model/`               | 会话模型:把 ACP v2 的 `session/update` 累加成对话。纯 TS,没有 React,main 也用它                                           |
| `packages/ui/src/store/`               | 页面的状态和动作。没有 React,用假桥接测试                                                                                 |
| `packages/ui/src/react/`               | 组件(ui-sdk,Streamdown)                                                                                                   |

## 为什么 main 持有会话状态

页面重载后只会收到之后的更新;`CycleClient` 也按 `seq` 去重。所以 **main 为每个被观看的 session 保存会话和未回答的权限请求**,页面(重新)打开时一次拿到整个状态和一个 `version`;之后每个事件带 `version`,页面只接受 `version + 1`,更小的忽略,出现空洞就重新向 main 要。冒烟测试里重载页面后会话完整回来。

## 工作位置、workspace 与侧栏

> 2026-11-24 起,本节以前叫"环境"(environment)的东西改名为 **Work in / 工作位置**(代码里 `location`),"环境"这个词改指可复用的准备配置,见下一节和决定笔记 [2026-11-24-work-in-and-environments](../.agents/notes/2026-11-24-work-in-and-environments.md)。

状态:daemon 一侧(协议 0.2:`updatedAt`、`cycle/unread`、`cycle/background`、`mark_read`)已实现;客户端一侧(工作位置、一次一个 workspace 的侧栏、switcher、标记)已实现,哪些还没做见下面"现状"。代码里的名字是 location(`LocationConfig`、`locationId`)。设计依据见决定笔记 [2026-11-18-sidebar-workspace-environment](../.agents/notes/2026-11-18-sidebar-workspace-environment.md)。

### 工作位置(location)

工作位置是**客户端**的概念:daemon 不知道自己被当作本地还是远程(协议只看到一个连接)。

```ts
type LocationConfig = {
  id: string; // 客户端分配,稳定;会话在列表里的身份是 (locationId, sessionId)
  name: string;
  kind: "local" | "remote"; // 以后可能有 "cloud"
  transport: // 只有 remote 有
  { type: "ssh"; host: string; command?: string[] }; // 以后可以加 websocket 等,不改别的字段
};
```

- `remote` 不等于 SSH:SSH 只是现在唯一的 `transport`。
- 可以**同时连着多个** daemon,侧栏的会话是它们的**汇总**。每个工作位置有自己的连接状态。
- 工作位置的能力(能做什么)来自 daemon 的 `initialize`(§3 `_meta["cycle/capabilities"]`),界面按能力开关功能,不写 `if (remote)`。
- 一个 session 在创建时绑定到它的工作位置,不能换:远程的 cwd 在本机不存在。
- **断线**:一个工作位置断线(含重连中)时,它的会话保留最后一次的列表,灰显,不能新建 session、不能发 prompt;连上后用新列表替换。灰显的行 hover 的 tooltip 说明是哪个工作位置、为什么(断开、重连中)。**只在应用的一次运行内**:最后一次的列表由主进程保存在内存里,页面重载后仍在,但重启应用后没有;启动时就连不上的工作位置没有"最后一次"。
- **版本落后的远程 daemon** 要能用:列表里没有的字段按缺失处理(protocol.md §3、§6),界面不报错。

### 现状(哪些已经做了)

代码里的名字是 location(`LocationConfig`、`locationId`、桥上的 `locations()` 等);界面文案里选择器和设置页分区叫 "Work in"(中文"工作位置"),句子里写 "location"(Add location 等),不写 "host"。词本身可以出现;只有一个工作位置时,不出现按工作位置分组、工作位置标题这类让人去选的东西。

- 主进程在启动时连接所有 host,各自独立,连不上的不拖累别的;原因记在它的状态里,侧栏的 host 状态行里显示。
- 会话是所有工作位置的一个汇总,身份是 `(locationId, sessionId)`,按 `updatedAt` 排序;旧 daemon 的会话(没有 `updatedAt`)排在有的之后,彼此按 `lastSeq`,不同 daemon 的不混排。
- 侧栏一次只显示一个 workspace(`sessions.ts` 的 `workspacesOf`、`currentWorkspace`)。显示哪个:switcher 里选的(只对选它时打开的那个 session 有效,打开了别的就放弃),然后是打开的 session 所在的,最后是最近有活动的。
- Switcher 按 host 分组(本机在前,多于一个 host 时才有分组标题,标题带连接状态),组内最近有活动的在前;远程 workspace 带 server 图标,图标的可访问名和 tooltip 是"On <location> · <state>";同名目录跨 host 时名字后带 host 名。Switcher 上的方块数字是**其他** workspace 里最紧急的一类,完整的计数在 aria-label。
- 当前 workspace 里的会话:Needs you、Running(包括有后台子 agent 的)、Today、Yesterday、Earlier(本地日界线)。older 的每个 workspace 先显示 20 条,有标记的和打开的永远显示。一行只有一个标记:needs-you > running > background > unread;断线 host 和已归档的会话没有标记。Loop 自动创建的会话(带 `_meta["cycle/origin"] = { kind: "loop", ... }` 或在当前项目 `loop/timeline/list` 的 `knownSessionIds` 中)默认从侧栏会话列表与工作区计数中抽离(不占未读角标),在项目下的 `Timeline` 页面按时间轴集中查看与接入(CYC-534)。
- 打开的会话有 `cycle/unread` 时,窗口在前台,就告诉 daemon 已读(`markRead`;main 用它自己最近读到的那一行的 `lastSeq`,不会超出日志;不支持的 daemon 不会被问,失败也不弹错误条)。
- 断线的 host:会话灰显、tooltip 说明原因,不算在标记里,侧栏里有它的状态、原因和"Retry"。
- 新建 session 打开一个**空白对话**(`blank.tsx`,store 的 `blank`),不是弹窗,也不请求 daemon:输入框上面一行是"在哪里跑"(CYCL-55):工作位置(只列已连接的,多于一个才有)、文件夹和 agent(多于一个才有)。文件夹是一个按钮，只显示文件夹名，提示里是完整路径;点开(或 ⌘O)是一个菜单：这个工作位置上有过 session 的文件夹(新的在前)、"Browse…"(本机用系统的选择器，远程用 daemon 列文件夹;都不能时没有)和 "Enter a path…"(一个输入框的表单,Enter 确定)。daemon 能说信任时，选好的文件夹还没有决定就在旁边标 "Not trusted yet",发出第一条消息时照旧会问。设置(权限、模型、effort)只在输入框下面的芯片里改，从 agent defaults 读来;空白对话不再有标题栏的 "…" 菜单和设置弹窗，没有选项的设置等 session 建好后再改。打开时焦点在输入框;没有文件夹时在文件夹按钮上。有东西挡着第一条消息时，上面只说一件事、给一个出口：工作位置没连上(原因原话,"Connect again";草稿和附件都留着，输入框上方说一句)、正在连接、没有可用 agent(输入框不能用,"Check again")、agent 的设置读不出来("Read settings again")。**首条消息发出时**才依次 `session/new` 和 `session/prompt`(决定笔记 `2026-11-19-session-starts-at-first-message`):这期间消息先显示在空白对话里、上面的选择锁住;建不成,消息回到输入框并显示原因;建成了而消息发不出去,打开那个 session,消息在它的输入框里。daemon 的列表只列有过用户消息的 session,所以没发过消息的不会出现在侧栏。空白对话里 @ 搜它选的文件夹(daemon 要有 `filesInFolder`);斜杠命令要等 agent 启动后才有。
- 新建 session:默认在当前 workspace 的工作位置和目录;可以选工作位置(只列已连接的);"Browse…"只对本机有。新会话的默认值按工作位置分别设置，在设置页各 agent 的 Harness 分区(Session defaults 一组)。
- **文件夹信任**(protocol.md §8 "信任文件夹"):空白对话发出第一条消息时、新建 session 之前,目录还没有决定(它和它的上级都没有),先弹出 "Trust this folder?":说明信任之后项目自己的设置能在这个工作位置里运行命令(hooks、`.mcp.json` 里的服务器和 helper),下面是目录的真实路径;按钮是 Back(回到空白对话,消息还在输入框里)、Start without trusting、Trust and start。两个 Start 都先记下决定,再新建、发出消息;记不下就说明原因,什么都不建。已经有决定的目录不问。daemon 不支持(没有 `trust` 能力)时不问。侧栏 switcher 旁的 "…" 菜单第一项是当前 workspace 的 "Trust this folder"(先确认,说明同上)或 "Stop trusting this folder"(直接生效);工作位置未连接或 daemon 不支持时没有这一项。

设置文件 `settings.json` 是 `{ "locations": [{ id, name, kind: "local" | "remote", transport?: { type: "ssh", host, command? } }] }`。2026-11-24 以前的 `{ "environments": [...] }`(条目相同)照读;再早的 `{ "hosts": [{ id, name, kind: "ssh", host, command? }] }` 读作 remote 加 ssh transport。三个键按 `locations` → `environments` → `hosts` 取第一个存在的,id 不变(会话和草稿都按 id 认);只有保存时才写新格式,旧的两个键不再写;这个版本读不懂的条目(更新的版本写的)不显示,但保存时原样写回。

### workspace

- **workspace = 工作位置里的一个 cwd**,即 `(locationId, cwd)`。同一个路径在两个工作位置里是两个 workspace。
- 不把 git 仓库的子目录合并成一个项目。**worktree 里的 session 归到主 checkout 的 workspace 下**:侧栏按 session 行的 `cycle/worktree.root` 分组,没有这个字段就按 `cwd`(docs/protocol.md §6 "Worktree")。
- 远程工作位置的 workspace 在侧栏里带一个**图标**,hover 的 tooltip 写它属于哪个工作位置(名字,以及连接状态);本地的没有图标。工作位置名不能只靠 tooltip:图标有可访问名,里面包含工作位置名。不同工作位置里同名的目录,标题再带上工作位置名区分。
- 在一个 workspace 里新建 session,就在它的工作位置里新建。要在别的工作位置里工作,就是选另一个 workspace,或者"New workspace…"时先选工作位置、再在那个工作位置的文件系统里选文件夹。

### 侧栏

一次只显示一个 workspace(沿用 old-cycle 2026-11-08 的决定):

- 显示哪个:你在 switcher 里选的,直到打开了别的东西;然后是当前打开的 session 或草稿所在的 workspace;最后是最近有活动的(`updatedAt` 最大的)。从列表里打开任何一行,都会放弃 switcher 的选择。
- **Switcher** 是一个菜单,列出所有 workspace,按工作位置分组(本地在前;多于一个工作位置时才显示分组标题,标题带连接状态),组内按 `updatedAt` 倒序。只有一个工作位置时,没有按工作位置分组的标题(没有可选的东西)。
- Switcher 上有一个方块数字徽章,数**其他 workspace**(所有工作位置)里最紧急的那一类;完整的计数写进 aria-label。
- 搜索跨所有 workspace 和工作位置,结果按 workspace 分组。
- 版式(DESIGN.md §4.1、§4.7):顶部固定 `New`、`Search`、`Connectors`、`Loop`(点开进入跨项目 Overview)四项全局动作;分隔线之下是当前 workspace 的 switcher;当本地 workspace 的 git remote 匹配到 Loop Project(`owner/name`)时,紧接在 switcher 下展示 `Kanban` 和 `Timeline` 入口(再以细分隔线与会话列表隔开);只有中间的会话列表滚动;底部一行是账号菜单入口(含版本、更新状态和进入设置页的按钮,见下面"设置页")。

当前 workspace 里的会话分组:**Needs you**(`requires_action`)、**Running**(`running`,以及有后台子 agent 的)、然后 Today / Yesterday / Earlier,按本地日界线分,用 `updatedAt`。每个 workspace 默认显示 20 条,"Show N more";有状态的和当前打开的永远显示。

一行只带一个状态标记,优先级:`requires_action` > `running` > background(`cycle/background` > 0)> unread(`cycle/unread`)。来源都是 daemon 的列表字段。

排序用 `updatedAt`,不用 `cycle/lastSeq`(后者按记录条数,不是时间)。旧 daemon 的 session 没有 `updatedAt` 时排在有的之后,彼此按 `lastSeq`。

### Worktree(CYC-273)

交互参考 shrimpdot-durable 的分支与 worktree 选择(它的决定笔记 `2026-10-09-branch-worktree-picker`),按 Cycle 的范围取舍。

- **新会话页的两个 chip**(文件夹、权限那一行,只在本机、daemon 有 `worktrees` 能力、文件夹在 git 仓库里时出现;否则两个都不显示):
  - **分支 chip**:始终显示一个分支名,没选时是当前检出的分支。菜单顶部是搜索框(打开就在里面,直接打字;↓ 进列表,Enter 选第一项,输入法组字中的 Enter 不算),下面是"本地分支",当前分支标"Current"、行尾打勾,远端默认分支(如果没有同名本地分支)排在最前。没有匹配时写"No matching branches"。
  - **Worktree 开关**:一个文字加对勾的 chip(`role="switch"`),默认值来自设置里该 agent 的开关。
  - 选当前分支以外的分支会**自动打开** Worktree,因为 Cycle 不切换用户自己的检出(shrimpdot 的"切换分支"这里不做);关掉开关,chip 回到当前分支。选当前分支且开关是关的,什么都不变。
  - 分支只列本地的,不 fetch(远端分支、先 fetch 都留待以后)。
- **会话里**:没有专门的一行。曾经在消息框上方有一行写 "Worktree" 和分支名,但它和页面其余部分的样式不一致,已去掉(2026-11-27)。shrimpdot 那一行末尾的 `+N −M` 改动数没有做,Cycle 的改动入口在右侧面板。
- 图标:分支 chip 没有图标(iconmcp 里的分支图标还没取,取到再加);搜索框用已有的 `SearchIcon`。

### 待定

- Switcher 分组:同一个 workspace 里有 session 在别的工作位置的情况不会出现(workspace 属于一个工作位置),所以不需要处理。如果以后同一个仓库要在本地和远程之间对应起来,那是另一个决定。

## 工作位置与环境(草稿,2026-11-24)

状态:草稿,等 owner 过目。"工作位置"一节已实现(2026-11-24 改名);"环境"一节也已实现(2026-11-24,setup/cleanup 只存不跑,见下面的"待定")。决定和理由见笔记 [2026-11-24-work-in-and-environments](../.agents/notes/2026-11-24-work-in-and-environments.md),协议见 protocol.md §6"环境"。

有两个概念,以前都叫"环境":

|                   | Work in / 工作位置(`location`)      | 环境(`environment`)                          |
| ----------------- | ----------------------------------- | -------------------------------------------- |
| 是什么            | session 在哪跑:连着的哪个 daemon    | 怎么准备和使用工作区:脚本、变量、动作        |
| 例子              | This computer、`dev-box`(SSH)       | "Node + Postgres"、"Python 3.12"             |
| 在哪定义          | 设置页 Work in 分区,`settings.json` | 设置页 Environments 分区,`environments.json` |
| 和 session 的关系 | 创建时绑定,不能换                   | 创建时选一个(或不用),daemon 存一份快照       |

agent 进程自己的环境变量(daemon `config.json` 的 `allowEnv`/`env`、隔离的 `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`)是第三件事,不变;设置页 Harness 里原来的 "Host configuration"(宿主配置)改叫 "Runtime"(运行信息),免得和环境混。

### 工作位置

状态:已实现(2026-11-24)。

就是上一节的"工作位置"(以前叫"环境"),只改了名:类型 `LocationConfig`、`locationId`,会话的身份 `(locationId, sessionId)`,workspace 是 `(locationId, cwd)`。id 不变,所以按 id 存的草稿、置顶、右侧面板都不用迁移:它们在 localStorage 里的键是 `<id>:<sessionId>`,里面没有带 environment 的字段名。

界面文案:新建 session 那一行的第一个选择叫 "Work in"(中文"工作位置"),选项是 "This computer" 和各远程位置的名字;设置页分区 "Environments" 改名 "Work in",按钮 "Add location"。以后有 cloud 时它是这里的又一种 `kind`。

`settings.json` 写成 `{ "locations": [...] }`(条目格式不变)。读时三个键都读:先是 `locations` 的条目,再是 `environments`、`hosts` 里 id 还没出现过的条目(旧版应用打开新文件后只会往 `environments` 里加,这样它加的不会丢);保存时把这些合起来写进 `locations`(旧的两个键去掉),别的键和读不懂的条目原样写回。文件的读写(整个写、改名换上、一次一个、不是 JSON 的另存为 `.broken-<时间>`、读不懂的原样写回)和 `environments.json` 共用 `apps/desktop/src/main/json-file.ts`,两个文件都是 0600(`settings.json` 里有 ssh 的地址,收紧没有坏处)。埋点里指工作位置的事件和属性也一起改了名,见 analytics.md。降级到旧版本时旧版读不到 `locations`,看不到远程位置(文件里的数据还在)。

### 环境

状态:已实现(2026-11-24)。代码:主进程 `apps/desktop/src/main/environments.ts`(文件和校验)、`actions.ts`(`createSession` 带快照、`createTerminal` 带 `actionId`);页面 `packages/ui/src/environments.ts`(`.env` 读写、校验,是 `@cycle/protocol` 规则的副本,测试保证一致)、`src/store/environments.ts`、`src/react/environments.tsx`(设置分区、编辑框、空白对话的选择、顶栏动作)。和下面草稿不同或草稿没说的地方:

- **桥接方法**:`environments()` 一次给出全部环境和 `defaults`(这就是"取默认");`saveEnvironment`、`removeEnvironment`、`setEnvironmentDefault(locationId, cwd, id | null)` 都回整个新状态。保存先按 daemon 的规则查(名字、重名、保留名、64 KiB,另加:环境要有名字、动作要有名字和至少一个系统的命令),不合格就回 `{problem, …}`,什么都不写。
- **快照由主进程拼**:页面在 `createSession` 里只给 `environmentId`,主进程从 `environments.json` 取这个环境当时的样子(去掉空脚本)放进 `session/new` 的 `_meta["cycle/environment"]`。daemon 以 `-32602` 拒绝时,`createSession` 不抛错,而是回 `{problem: {reason, name?}}`(`reason` 的清单是 `api.ts` 的 `ENVIRONMENT_REFUSALS`,主进程和页面共用),页面按 reason 换成自己的一句话(只写变量名,不写值),消息回到输入框;环境在这期间被删了是 `missing`。`missing` 和 `needs_fix` 只由主进程给,daemon 回的这两个词不算。
- **和 daemon 一样的校验**:页面和主进程的校验与 daemon 的 `checkEnvironment` 一致(另加:环境和动作要有名字、动作要有命令),包括动作的 id 不能为空、不能重复。`environments.json` 里读到的环境(手写的、别的版本写的)不合格时,设置页那一行写"Needs a fix: …",不会被发出去;页面发之前先查,主进程取快照时再查(回 `needs_fix` 和环境名,页面说要去设置里改;`invalid_environment` 只留给 daemon 自己读不懂的环境)。编辑框打开时给没有 id 或 id 重复的动作换一个新 id,再保存一次就好了。
- **workspace 的键**:默认按 `(locationId, cwd)` 记,`cwd` 只去掉末尾的斜杠(根目录 `/` 除外;空格不动，文件夹名可以以空格结尾),所以 `/Users/me/repo/` 和 `/Users/me/repo` 是同一个;读旧文件时也这样换算。
- **密钥**:变量文本框里只写一个 `NAME`(没有 `=`)的行是密钥;写成 `KEY as NAME` 则取 `secrets.env` 里 `KEY` 的值给变量 `NAME`(别名,让不同环境的 `GH_TOKEN` 取不同的 token)。值不存在 `environments.json` 里,也不发给 daemon,由 session 所在机器上 `<daemon 数据目录>/secrets.env`(默认 `~/.cycle/secrets.env`,`NAME=value` 格式)提供。只给终端和动作,agent 拿不到。那个工作位置的 `secrets.env` 里没有值,session 不开始,提示缺哪个名字。
- **Vault(设置页分区)**:管理一个工作位置的 `secrets.env`(protocol.md §6 "保险库"),位置选择同 API keys(`LocationScope`)。一行一个键:名字,下面一行写哪些环境在用它(环境的密钥取 `from ?? name`,没有就写 "Not used by any environment");行尾的箭头打开详情。搜索框按名字过滤。**只写不读**:值不在页面、主进程和 store 里,详情里的"值"是一串固定的点(不泄露长度),替换值要重新输入。
  - **详情**对话框:名字、值(点)、使用它的环境;左下 Remove(`destructive`,先确认,焦点在 Cancel),右下 Edit 和 Done(默认焦点)。
  - **新建/编辑**对话框:新建时焦点在名字上,名字要是合法的变量名,已有同名时提示"保存会替换";编辑只换值(名字写成文字,不是输入框,焦点直接在值上,密码框,总是空的);回车提交。
  - 状态:读取中、读不出(原话加 Try again,已读到的保留)、空(出口是 New item)、搜索无结果。daemon 没有 `vault` 能力时读取失败,按"读不出"显示原话。
- **agy**:与 Claude / Codex 一样,agy 的命令也通过会话级私有脚本拿到环境的字面变量(`ZDOTDIR` / `BASH_ENV`,见 protocol.md §6,CYC-314),空白对话不再对 Antigravity 显示特殊提示。
- **还没选文件夹时也能选**:那时选的是一个"待定"的选择(一开始是 "No environment",不沿用上次的:新会话从干净的状态开始,和 agent 的设置一样),换文件夹、换工作位置都保留它。选了文件夹以后,这个 workspace 记过默认就用它的默认(待定的让位);没记过就还是待定的那个,并在 session 建成时记成这个 workspace 的默认。有文件夹时再选,和以前一样立刻记成默认。daemon 没有 `environments` 能力时,按钮在但 `aria-disabled`,提示 "Cycle on {location} needs an update to use environments.",也不发环境。
- **默认为空就是 "No environment"**;指向已删环境的默认当作没有,删环境时主进程一并删掉指向它的默认。
- **按系统分的脚本**:一个文本框,上面一个分段选择 "All systems / macOS / Linux / Windows"(不叫 "Default":AGENTS 规定选项不写光秃秃的 Default),有内容的系统带一个点。动作的命令同样。
- **动作的图标**:`icon` 存一个固定的 id,一共 8 个:`terminal`(默认)、`play`、`test`、`build`、`database`、`server`、`refresh`、`clean`,清单只在 `packages/ui/src/environments.ts` 的 `ACTION_ICONS` 一处,图形是 iconmcp 的 terminal、play、flask、hammer、database、server、refresh-cw、trash。编辑框里每个动作有一个 "Icon" 下拉(图标加名字)。不认识的 id(更新的版本写的)画成终端,编辑框里也显示成 Terminal,不改它就原样写回。顶栏按钮和溢出菜单都画各自的图标。
- **顶栏**:动作不多于 3 个时都是按钮,多了显示前 2 个加一个"终端+箭头"的菜单(菜单里每项带自己的图标);窗口窄于 1000px 时只剩一个列出全部动作的菜单,给标题留地方。需要 `terminal` 和 `environments` 两个能力、且已连接,否则按钮 `aria-disabled`。
- **在哪看用的哪个环境**:右侧面板 Overview 的 Location 一块,多两行"Environment"(名字)和"Variables"(只列名字)。
- **埋点**:见 analytics.md:`environment_config_saved`、`environment_config_removed`、`environment_chosen`(在空白对话里选的时候,`none`)、`environment_action_run`;`terminal_opened` 的 `via` 多了 `action`,`settings_section_shown` 多了 `environments`。

```ts
type Scripts = { default?: string; macos?: string; linux?: string; windows?: string };

type Environment = {
  id: string; // 客户端分配,稳定
  name: string;
  setup?: Scripts; // 新建 worktree 后在 worktree 根目录跑
  cleanup?: Scripts; // 删除 worktree 前在 worktree 根目录跑
  variables: { name: string; value: string }[]; // 有序;名字不能重复,不能是保留名(protocol.md §6)
  actions: { id: string; name: string; icon?: string; command: Scripts }[];
};
```

- **全局定义**:不属于哪个工作位置,也不属于哪个项目。同一个环境在本机和 SSH 上都能用,机器不同的地方用按系统分的脚本处理;daemon 按自己的系统取 `macos`/`linux`/`windows`,没有就用 `default`,都没有就不跑。
- **存储**:`userData/environments.json`,`{ "environments": Environment[], "defaults": { [locationId]: { [cwd]: environmentId } } }`,权限 0600(变量可能是密钥)。不和 `settings.json` 合在一起,因为 `settings.json` 里旧的 `environments` 键是工作位置。写法同其他设置文件:整个写、改名换上,读不懂的条目原样写回。
- **选用**:每个 workspace 记一个默认环境(`defaults`)。空白对话"在哪里跑"那一行在文件夹后面多一个环境的选择:默认是这个 workspace 记的,没有就是 "No environment";选了别的就记成这个 workspace 的新默认。只有在至少定义了一个环境、且该位置的 daemon 声明了 `environments` 能力时才出现;daemon 太旧时它在,但不能选,提示说明要升级那边的 daemon。
- **快照**:首条消息发出、`session/new` 时把选中的环境整个发给 daemon,daemon 存一份。之后改或删这个环境,不影响已有的 session,只影响新建的。会话标题的菜单里能看到它用的是哪个环境(名字;变量只列名字,不列值)。
- **什么时候生效**:

  | 部分    | 时机                                                                                                                       |
  | ------- | -------------------------------------------------------------------------------------------------------------------------- |
  | 变量    | session 的每个 agent 进程、它跑的命令、它的终端、它的脚本和动作                                                            |
  | 密钥    | 只有终端、动作、你开新 session 时跑的 setup;agent 的命令拿不到,agent 自己进出 worktree 时跑的 setup/cleanup 也拿不到(见下) |
  | 动作    | 顶栏按钮;点了在这个 session 的一个新终端里跑(`cwd` 是 session 的)                                                          |
  | setup   | 只在新建 worktree 后跑;不在主 checkout 里跑                                                                                |
  | cleanup | 只在删除 worktree 前跑                                                                                                     |

  setup 在 Cycle 新建 worktree 后运行一次,cleanup 在 Cycle 删除 worktree 前运行(docs/protocol.md §6 "Worktree")。setup 失败时 session 照常创建,在 session 里显示输出;cleanup 超时 60 秒,失败不阻止删除。
- **编辑**:设置页 Environments 分区,每个环境一行(名字、变量个数、动作个数),菜单里 Edit、Duplicate、Remove(先确认;正在用它的 session 不受影响)。编辑表单仿 Codex 的:名字;setup、cleanup 各一个按系统分页的文本框;变量用 `.env` 格式的文本框(一行一个 `KEY=value`,`#` 开头是注释,保存时校验名字);动作列表。
- **埋点**:只记事件和个数(`environment_config_saved`:有无 setup/cleanup、变量个数、动作个数;`environment_chosen`),不记名字、变量名和值、脚本内容。以前的 `environment_saved` 指的是保存工作位置,2026-11-24 已改成 `location_saved`(见 analytics.md);因为旧版本还在发它,环境的事件另起名 `environment_config_saved`、`environment_config_removed`。

### 待定

- 要不要支持从项目里的文件(类似 Codex 的 `.codex/`)读环境,给团队共享。
- 网络访问控制(Claude 的 cloud environment 有)只对 cloud 有意义,本机和 SSH 不做。

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

- `packages/ui/src/styles/app.css` 引入 Tailwind、ui-sdk 的 `web.css`(在 `components` 层)、Streamdown 的样式,`@source` 指向 Streamdown 的代码,并用 `@theme inline` 把那些颜色名映射到 ui-sdk 的 `--ui-*` 变量。Cycle 自己的样式按领域分在同目录的几个文件里(`base`、`motion`、`layout`、`sidebar`、`main`、`conversation`、`composer`、`pages`),`app.css` 按顺序导入它们，顺序就是层叠的顺序。换 ui-sdk 的主题,Markdown 也跟着换。
- 一个 DOM 测试检查 Streamdown 渲染出的每个工具类都在构建出的 css 里。它抓到过缺口(上面的颜色名没定义,Markdown 会"光着身子")。
- 生成的 `built.css` 不进 git;`bun run check` 的第一步会生成它。

## 测试

- 门禁里(`bun run check`):会话模型、store(假桥接)、`ConnectionManager`(真 daemon)。
- 界面(`bun run test:browser`,CI 的 `browser` 作业):页面组件和 Markdown 安全,在无界面的 Chromium 里,用真实的布局和输入事件(`packages/ui/test/browser/*.browser.tsx`,见 [testing.md](testing.md))。
- `packages/client`:`bun run test:integration` 把客户端打成包,用 Electron 自带的 Node 跑,证明它在 Node 下能用(Bun 通过自己的测试说明不了这一点)。
- `apps/desktop`:`bun run test:integration web`(会先 `build`)。构建出的页面在无界面的 Chromium 里,用浏览器自己的鼠标和键盘事件操作,后面是真的 `ConnectionManager`(和主进程里的同一个)、真 daemon、Claude 适配、真 SDK 和模拟 API:连上工作位置、点击和打字创建 session、打字和粘贴 Markdown、发消息、看到流式回答、出现权限卡片并点击 Allow(工具真的运行了)、重载页面后会话回来。页面的桥接由测试按 preload 的样子造出来(`test/web/web-app.ts`);preload 本身和页面的锁定由 `bun run test:integration package` 在打包后的应用里检查。

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
- **差分**(`src/main/delta.ts`,决定笔记 `2026-11-18-update-by-the-difference`):清单除了整包的 `file`/`sha256`/`size`,还有 `tree`,即包内每个文件(路径、模式、大小、SHA-256)、链接和目录的表,发布时由 `release-assets` 对最终签名的 `.app` 扫出。客户端拿它和已安装的包比较:没变的文件从已安装的包复制(APFS 上是克隆,不占空间),缺的或变了的,用 HTTP Range 从同一个 zip 里取(先读末尾的中央目录,相邻的小文件合并成一次请求,大文件单独流式解压),不另发补丁。信任的是文件表(来自清单,与整包的 SHA-256 同一条信任链;差分时**不**再检查整包的 SHA-256 和大小,因为整包没有下载):拼出的包里每个文件都要等于它的 SHA-256,包的形状(文件、链接、目录、模式)要与它完全一致,然后照常过版本、平台和签名检查。文件表的路径必须在包内(相对、无 `..`、不重复、父目录先列、链接不出包、模式只有 rwx),不合格的表整张不用。服务器不支持 Range(必须是 206 且 `content-range` 与请求一致)、哈希不符、检查不过、或要取的超过整包的 80%,都**回退整包下载**一次(请求被限流或磁盘写满除外:整包会遇到同样的事,直接报错;并行取文件时一个失败,其余请求立刻中止),原因写进日志(`[update] …`),进度条的总量随之换成整包。没有文件表的发布(0.2.1 及以前)和没有这段代码的客户端都是整包。
- **按块差分**(决定笔记 `2026-11-23-update-by-blocks`):Developer ID 签名带时间戳,每次发版所有 Mach-O 的字节都不同,即使代码没变,所以按文件比较几乎全变。发布时 `release-assets` 另出一个块包 `Cycle-<version>-<platform>-<arch>.blocks`:大于 1 MiB 的文件按 1 MiB 切块,每块单独 raw deflate,清单的 `pack` 列出每块的 SHA-256、偏移和压缩后大小。客户端对变了的大文件逐块比较:已安装文件里有的块直接复制,没有的从块包按 Range 取,解压后要等于块的 SHA-256,拼好的文件仍要等于文件表的 SHA-256。一块都复用不了的文件从 zip 整个取。块包不合格或 release 里没有,只是变了的文件从 zip 取(日志写原因);块不符和其他差分失败一样回退整包。顶部横幅在差分时写 "Downloading the changes for 0.2.2"。
- **替换**:由一个脱离的小 shell 脚本等旧进程退出后 `mv` 换包并 `open -n` 打开新的;替换失败会放回旧包并照样打开。不在运行中的进程自己换自己,是因为替换正在运行的 Electron 的包可能让它崩溃。下次启动清理遗留的临时目录。本地 daemon 不在应用包里运行(见下面"本机 daemon"),所以换包时不停它,会话照常工作;只有更早的应用从包里启动的 daemon 还在运行时,才像以前那样先停掉它(有会话在工作就不装,说明是哪些)。
- **下载只来自**仓库自己的 release 地址(`https://github.com/OhMyJames/cycle/releases/download/`)。从 0.3.16 起,发布(打 tag 时仓库变量 `RELEASE_SIGN=true`)用 Developer ID 签名并公证,已签名的应用只接受同一团队签名的更新,来源由签名证明。0.3.15 及以前的 ad hoc 包发布在旧仓库 `OhMyJames/Cycle-V1`,只看那里的更新,要手动重装一次新版本。打开签名后,之后的每次发版都必须签名(签名用的证书和 API key 在仓库的 Actions secrets 里),否则已签名的应用会拒绝更新。
- **没有本机 alpha**(CYC-468,2026-11-27):不再有 `bun alpha`、`CYCLE_VERSION`、`<CYCLE_HOME>/alpha/` 的读取和 "Cycle Alpha (local)" 证书校验,更新只读上面的 GitHub release;只改页面的改动走下面的界面热更新。已用 alpha 包的机器(版本号形如 `0.3.32-alpha.N`,签名身份与正式版不同)不会自动换回:退出应用,从 GitHub release 下载 `Cycle-<版本>-darwin-arm64.zip`,解压后替换 `/Applications/Cycle.app`,再打开。钥匙串会因为签名身份变了再问一次,之后的更新不再问。`<CYCLE_HOME>/alpha/` 里已有的文件不动,也不再读取。
- **装不上时**会提前说明:应用所在的目录不可写,或应用是从下载位置直接打开的(App Translocation,只读)。
- 测试用的 `CYCLE_UPDATE_URL` 只接受 `127.0.0.1` 或 `localhost`,不能把应用指到别处。
- 测试用的 `CYCLE_TEST_HIDDEN_WINDOW=1` 让应用不显示窗口、不发系统通知;macOS 上应用也不进 Dock、不能到前台。窗口里的页面照常运行,测试经 DevTools 读它。

## 本机 daemon(CYC-538)

安装好的应用不从自己的包里运行 daemon,而是从 `<数据目录>/daemon/bin`(默认 `~/.cycle/daemon/bin`)运行,这样应用可以随时更新自己,daemon 也可以在空闲时自己更新(docs/daemon.md "自动更新")。包里的 daemon(`Contents/Resources/app/bin`)是种子,它的版本写在 `build.json` 的 `daemonVersion`。

- **启动时**(`src/main/daemon-home.ts`):那里没有 daemon,或者有一个更旧的、没在运行的,就把种子复制过去(APFS 上是克隆,不占空间;去掉从浏览器下载留下的隔离标记,免得 Gatekeeper 把每个程序当成刚下载的),换掉原来的。那里有一个更旧的、正在运行的,就放进 `<目录>.staged`,运行中的 daemon 空闲时自己换过去;已经放着一样新或更新的就不动。那里的一样新或更新(它自己从通道更新过)就什么都不做。复制失败时用包里的 daemon,和以前一样。结果记成 `local_daemon_seeded`(docs/analytics.md)。
- 开发运行(`bun run start`)不受影响,仍按 `CYCLE_DAEMON_BIN`、构建目录、源码的顺序找。

## 界面热更新(CYC-469)

只改页面(`apps/desktop/src/renderer`、`packages/ui`)时,不发版、不换应用包:安装好的应用后台取一份 CI 签名的页面包,校验通过后,下次启动或点 "Reload" 就用它。页面包发给同一**接口契约主版本**的所有应用,不管页面比应用新多少:接口只新增时旧应用照收,删改了才升主版本、旧应用等整包更新。签名和密钥的决定见 `.agents/notes/2026-11-26-interface-bundles-signed-by-ci-key-not-by-github-account.md`,按主版本发包的决定见 `.agents/notes/2026-11-27-interface-bundles-go-to-every-app-of-the-same-contract-major.md`(CYC-539)。

- **接口契约(CYC-539)**:页面能依赖的是 `packages/ui/src/api.ts` 的 `AppApi`、`AppEvent`(连同它引用的 `model/` 类型和协议 SDK 的类型)和 preload。`CONTRACT_MAJOR`(`src/shared/contract.ts`)是它的主版本,`package` 把它记进 `build.json` 的 `contract`,和 `uiVersion`(`git rev-list --count HEAD`,main 上单调递增)一起。实际只会出现"页面不比应用旧"这一种组合(比自带页面旧的包不收),所以同一主版本里允许的改动是:新增方法、新增事件或事件的变体、页面发出的参数末尾新增可选参数或对象里新增字段、应用回答里新增可选字段;删掉方法也允许(新页面不再调)。不允许的:新增必填参数、页面发出的联合类型变宽、回答里少了字段或变窄、删事件变体或字段等——要升 `CONTRACT_MAJOR`。**门禁**:`apps/desktop/test/ui-contract/snapshot/` 是上一次提交时 `api.ts` 及其依赖的声明(`tsc --declaration`,去注释),`test/ui-contract/compat.ts` 在 `bun run typecheck` 里用类型检查对比快照和现在的源码(两边都包在元组里比较,避免联合类型逐项分配),主版本没升而不兼容时编译失败并列出方法名;`test/ui-contract.test.ts` 要求快照就是现在源码生成的那份、快照里的每个 import 都能解析(解析不了的类型会变成错误类型,类型比较全部放过),还用小例子钉住分类规则。改了 `api.ts` 就跑 `bun run --cwd apps/desktop ui-contract` 更新快照:它先跑兼容检查,不兼容又没升主版本就拒绝;协议 SDK 版本或 preload 源码变了(类型比不出来)也拒绝,除非升主版本或带 `--accept "<理由>"`(理由写进提交说明)。**语义变化**(类型没变,但主进程对某个方法或事件的行为变了、页面看得出来)门禁看不见,由改的人升主版本;忘了的兜底仍是 15 秒启动确认和回退。已知的空子:一个方法在某次提交删掉、之后又以不兼容的类型加回来,快照链看不到中间那段壳——不要这样做,换个名字。
- **发布**:`.github/workflows/ui-release.yml` 在每个 main 提交上构建、打包页面(`bun run ui-package`)、用 `ui-release` 环境里的私钥 `UI_SIGNING_KEY` 签名,发布(`bun run ui-publish`)到滚动 release `ui-latest`(预发布、非 latest;tag 不以 `v` 开头,所以整包更新器的发布列表读取会跳过它)。资产:`ui-c<主版本>.json`(清单 `v: 2`:`contract`、`uiVersion`、`keyId`、归档名、大小、SHA-256、页面每个文件的 SHA-256)、`ui-c<主版本>.json.sig`(对清单原始字节的 Ed25519 签名,base64)、`ui-c<主版本>-<uiVersion>.zip`。先传 zip,再传签名,最后传清单(清单是指针)。同一主版本里已发布的 `uiVersion` 不低于本次时不发布(排队的旧提交不覆盖新的)。按"线"保留:一条线是一个主版本(`c<主版本>`),或 CYC-539 之前的应用用的壳哈希(`ui-<shell>…`,清单 `v: 1`,不再更新)。每条线留最近 3 个 zip;最近 3 次整包发布(清单里的 `contract`,更早的是 `shell`)用的线和一周内发布过的线留着,其余整组删。
- **取包**(`src/main/ui-updater.ts`):启动时和之后每 5 分钟,直接取 `https://github.com/OhMyJames/cycle/releases/download/ui-latest/ui-c<自己的主版本>.json`(带 `If-None-Match`;这是下载地址,不走 API 限额;404 = 没有)和 `.sig`。依次检查:清单合格(`parseManifest`,只认 `v: 2`,路径无 `..`、绝对路径、反斜杠);签名由壳里公钥表(`src/main/ui-keys.ts`,按 `keyId`)中的钥匙签出;`contract` 是自己的主版本;`uiVersion` 高于见过的最高版本(`state.json` 的 `floor`,也不低于自带页面的版本,防回滚);zip 的大小和 SHA-256;解开后的文件集合正好等于清单所列、每个文件的 SHA-256 都对(多一个、少一个、符号链接都不行)。都过了才改名进 `<userData>/ui/<uiVersion>/`。只在整包更新正在下载或安装(人已经点了更新)时不取;整包更新只是"可装"时照取,不然发版频繁时界面更新会长期停住。任何失败都只写日志(`[interface] …`),下次再试。**公钥表为空时整个功能关闭**:不发请求,只用自带页面。从源码运行时也不取(它的页面就是正在改的那份),除非测试用 `CYCLE_UI_URL` 指了回环地址。
- **用哪个页面**(`src/main/ui-store.ts`、`ui-page.ts`):`<userData>/ui/state.json` 记 `current`、`previous`、`floor`、`bad`。每次启动选页面时都**重新验签、逐文件校验**:通过的 `current`,否则 `previous`,否则包内自带的页面(从不删除、从不标坏)。页面仍是 `file://`,所以 `localStorage`(草稿、置顶)在页面包之间保留;`ipcMain` 的来源检查和 `will-navigate` 都跟着当前页面的地址走。
- **没起来就退回**:加载页面包时,页面要在 15 秒内调用 `interfaceBooted()`(`main.tsx` 里的 `Booted` 组件,React 第一次渲染提交后),否则、或渲染进程在这之前退出、或加载失败,这个版本进 `bad`,换 `previous`,最后换自带页面。已经报过启动的页面之后崩溃不算它的错。
- **旧应用上的新页面**(`src/renderer/bridge.ts`):应用的 preload 按它自己的方法表造 `window.cycle`,比页面旧的应用缺页面新增的方法。页面启动时用自己的方法表补齐:缺的方法换成一个被拒绝的 Promise("This version of Cycle cannot do … yet. Update Cycle to use it."),和应用拒绝一次调用一样走页面已有的错误处理,不会在调用处抛 `TypeError`;缺了哪些在控制台记一行。所有方法都必须返回 Promise(门禁也检查)。`test/integration/web.integration.ts` 用缺了一批方法的桥启动页面,要求能连上、无未捕获错误。
- **生效**:取到的页面包不立刻换。侧栏通知出现 "A newer interface is ready" 和 "Reload"(整包更新正在下载或安装时不显示;只是可装时照常显示);点 "Reload" 调 `applyInterfaceUpdate()`,窗口重新加载,会话状态在 main 里,不丢。不点,下次启动就用。账号菜单的版本后面、设置页 Updates 里,在页面版本和自带的不同时多一个 "UI <版本>"。
- **第一次**:新接口(`interfaceState`、`interfaceBooted`、`applyInterfaceUpdate`)和公钥都在壳里,所以带上这个功能的第一个整包版本要正常发;之后只改页面的提交才不需要发版。0.3.35 及以前的壳哈希包含 `main.mjs`;0.3.36–0.3.40 按壳哈希取 `ui-<shell>.json`,CYC-539 之后不再给它们发包,它们等整包更新;按主版本取包的第一个整包版本要正常发。
- **密钥**:私钥只在 GitHub Environment `ui-release`(只许 `main` 分支使用)的 secret `UI_SIGNING_KEY` 里,PKCS#8 Ed25519(PEM 或 DER 的 base64),`ui-package` 签名后用壳里的公钥再验一次,对不上就失败,不会发出没有壳认的包。**轮换**:生成新钥匙,公钥以新的 `keyId`(如 `k2`)加进 `UI_KEYS`,随一个整包版本发出;等没有只认旧钥匙的应用在用后,把 `UI_SIGNING_KEY`(和 `UI_SIGNING_KEY_ID`)换成新的,最后从表里去掉旧的。私钥怀疑泄露:删掉 secret 立即停发,换钥匙,旧公钥随下一个整包版本去掉(在那之前装着旧壳的应用仍认旧钥匙,所以要尽快发版)。
- **清除**:删除 `<userData>/ui/` 即回到自带页面。
- **测试**:`test/ui-bundle.test.ts`(清单、命名、签名)、`ui-contract.test.ts`(快照、分类、补齐方法)、`ui-store.test.ts`、`ui-updater.test.ts`(假 `fetch`、假解压)、`ui-page.test.ts`(回退、计时,假窗口)、`ui-package.test.ts`、`ui-publish.test.ts`(假 `gh`);`test/integration/interface.integration.ts` 在 macOS 上用真实的 Electron(从 `dist` 运行)走完整个流程:取包、Reload、草稿保留、重启、不绘制的包被放弃、改过的包不被使用。从源码运行时,应用可由环境变量 `CYCLE_UI_KEYS`(JSON,`keyId` → SPKI base64)、`CYCLE_UI_URL`(只许回环地址)、`CYCLE_UI_BOOT_MS` 指向测试用的钥匙和地址;**安装好的应用不读这些变量**。

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
- **上下文用量（CYCL-74）**：输入框工具条右端是用量环，显示 agent 报的已用占窗口的比例（不到 1% 写 “<1%”）。它是按钮，点开是和模型、权限同一种弹层，按 Claude Code 的 `/context` 的样子直接列数字，不写说明：第一行是 “Context window” 和 “已用 / 窗口（百分比）”；下面一条按部分分段的条；再下面每个部分一行（色块、名字、token、占窗口的比例），用到的按大小排，然后是给压缩留的、剩下的，没加载进窗口的工具定义（`deferred`）不列；最后是自动压缩点、本会话费用、完成的压缩次数。各部分来自 `usage_update` 的 `_meta["cycle/context"]`（protocol.md §8），按 `id` 用 Cycle 自己的文字，不认得的用 agent 给的名字；agent 没给就只有总数和条。只列 agent 报过的。只有三种没有数字的状态写一行字：还没有用量（环是空的）、正在压缩、压缩完成后还没有新的用量（环的底圈改成虚线、弧线变淡，条变淡，不列各部分，因为它们是压缩前的）。下面是订阅账号的 “Plan usage”：每个限额一行（5-hour limit、Weekly limit，以及按模型的周限额），写用掉的比例和多久后重置（一小时内写分钟，一天内写小时分钟，再远写星期和时间），下面一条细条；快到时（70% 或 agent 说 warning）用注意色，到了（90% 或 rejected）用危险色。数据来自 daemon 记住的该 agent 账号的最新一份（protocol.md §8 “套餐用量”），所以同一工作位置的会话看到的是同一份；过了重置时间的那一行不再显示；API key 登录没有这一段。点开发 `context_details_opened`，只带是哪种状态、有没有列出各部分、有没有显示套餐用量。
- **在新会话中继续（CYC-279）**：会话空闲，且已用超过 200K，或超过 55 分钟没有动静且已用超过 100K（缓存已过期，下一条回复要把整段对话全价再发一遍）时，输入框上方的托盘出一行提示和 “Continue in new session”。它不调用模型、不生成摘要：在同一工作位置、同一文件夹、同一个 agent 上打开新会话页（文件夹已是 worktree，所以不再另建 worktree），输入框里放好对旧会话的 @ 提及（`cycle://session/<id>`），不自动发送；发送时由 daemon 展开成对话文字的记录（protocol.md “提及(@)另一个 session”），所以新会话只带对话文字，不带工具调用和文件改动。daemon 不支持会话提及（`sessionMentions`）时不出这一行。“Dismiss hint” 在内存里记住，该会话有新动静后再出现。发 `continue_hint_shown` / `continue_hint_used`，只带原因（`context` / `idle`）。
- **回看**:空输入框里按 ↑ 取回上一条发过的消息(从对话里读),↓ 回来;只有光标在首块、末块时才生效。
- **命令**:消息最开头的 `/` 列出 agent 的命令(`available_commands_update`),空格之前有效;**提及**:`@` 之后列出 session 目录里的文件和文件夹(`_cycle/files/search`),文字里写 `@路径`,发送时另附 `resource_link` 块(决策笔记 `2026-11-18-mentions-are-resource-links`)。daemon 声明 `sessionMentions` 时,菜单在文件和文件夹之后另有 **Sessions** 一组:同一工作位置里标题含所输入文字的其他 session(不含当前这个和已归档的),最近的在前,最多 6 个;两组都有时各带小标题,只有文件时和以前一样不分组。文件结果到了才一起显示,行不会在指针下移动。选中的 session 在文字里写 `@标题`(去掉 Markdown 会读成格式的符号),附一个 `cycle://session/<id>` 的 `resource_link`;daemon 发给 agent 时把它换成那个 session 的简短记录(docs/protocol.md §8,决策笔记 `2026-11-22-session-mentions-expand-in-the-daemon`)。发出的消息里 `@标题` 画成带对话图标的标签(chip),悬停显示完整标题,不显示 agent 收到的记录;输入框里仍是 `@标题` 文字。旧 daemon 没有这一组。两种菜单都以整个输入框为宽,单行时输入格很窄也不受影响(窄窗口下实测 320px 宽的主区);长文件名末尾省略,目录提示最多占一行的 40%;`@` 之后文件夹里什么都没有时写 "This folder has no files or folders."(CYCL-75)。
- **测试**:界面测试在真实浏览器里对输入框真的敲字和按键(`test/browser/box.ts`);粘贴在 `web` 套件里走(`web.integration.ts` 敲 `**bold**` 并检查渲染,再粘贴一段带星号的文字,检查它按原样放入)。
- **系统输入法验证（CYCL-110，2026-11-20）**：macOS 26.5.2、Electron 45.3.4，使用独立应用数据目录、真实 composer、系统输入源和原生键盘事件。简体拼音在 `@` 后输入 `nihao`，↓ 选择候选，第一次 Enter 确认“你好”并保留草稿，第二次 Enter 选中 `你好.md`。日文罗马字输入也观察到 Enter 结束组合并保留草稿。两种输入法的候选窗均出现在输入行下方。在组合中触发 Electron 的粘贴命令，中文确认后留下 `@你好PASTE_MARK`，日文确认后也保留了组合文字和剪贴板标记。
- **组合期间的 ⌘V（CYCL-116）**：macOS 在 Electron 的 `before-input-event` 之前便把按键交给了输入法。桌面主进程通过 AppKit 在本应用内处理按键：当前编辑器有组合文字且按下 ⌘V 时，先让应用菜单执行快捷键。用上述系统简体拼音复测，普通和组合中的 ⌘V 均只触发一次 paste。在 `@nihao` 的候选未确认时粘贴 `PASTE_MARK`，再用 ↓ 和 Enter 确认，草稿为 `@你好PASTE_MARK`。单独验证提及时，第一次 Enter 确认“你好”，第二次选择 `你好.md`，均保留在草稿中。
- **没做**:@ 提及没有 chip 节点(是普通文字加一个记在草稿里的链接),所以从存储恢复的草稿里文字还在、结构化的链接没有;提及里没有别的 session;输入历史只读当前对话里的消息;Lexical 对撤销/重做、拖选等的行为没有逐项验证。

## 设置页(CYCL-56)

应用级的设置在一个**整窗页面**里,不再分散在菜单和对话框中。侧栏底部的按钮或 `⌘,`(非 Mac 为 `Ctrl+,`)打开;页面是窗口外壳(`shell.tsx`,CYC-530)里的一个地方:侧栏仍是窗口的侧栏(同样可拖宽、可折叠),顶行之下的会话列表换成"Back to sessions"(从 Loop 打开时是"Back to Loop")和分区导航,右边是选中的分区。`Esc`、Back 或再按一次 `⌘,` 回到打开它的地方(会话或 Loop);`⌘N`、`⌘K` 在页面上仍然可用,新建或选中会话就离开页面,系统通知点开的会话也一样。会话那一侧在页面下面保持挂载、只是不显示(`hidden` 加 `inert`),所以回来时对话的位置、展开的工具、没写完的消息都在。

- **框架**(`page-layout.tsx`):`PageLayout`(返回、分区导航、分区内容;导航经外壳的 `ShellSidebar` 放进侧栏,分区名经 `ShellTitle` 放进标题栏)、`PageGroup`、`PageRows`、`PageRow`。分区导航是 SDK 的 Tabs 竖排:方向键切换,只挂载当前分区。Connectors 页(CYCL-82,见下面的 "Connector")用的是同一套。
- **General**:界面语言(见下);版本、更新状态、"Check for updates"(开发运行不能更新时不显示按钮,只说明原因)、有新版本或安装失败时的 "Update and restart";统计开关(Usage statistics)。没有上报目标,或用环境变量 `DO_NOT_TRACK` / `CYCLE_ANALYTICS=off` 关掉时,不显示开关,规则与以前的菜单项相同(docs/analytics.md);首次启动的说明仍在会话页顶部,文字改为指向 Settings。
- **Appearance**:主题(Match system、Light、Dark,见下)、代码配色和示例。
- **Work in**(工作位置):每个工作位置一行:状态(点、词)、名字、远程的 ssh 地址,断开时下面是 ssh 的原话和 "Connect again";远程工作位置行尾的菜单里是 Edit、Remove(先确认)。"Add location" 在分区右上。增、改仍是原来的表单对话框,开在设置页上面。
- **Model providers(模型服务商,分组)**:设置导航里和 Harness 并列的一组,三项,共用一个 "Work in" 选择器(连着多个工作位置时出现)。
  - **Subscriptions(订阅)**:Claude、Codex、Antigravity 各一组,每组一行账号:状态点、身份(邮箱 / `Signed in` / `Not signed in`)、认证方式与套餐、`viaEnv` 覆盖变量名(不显示值)、套餐用量(`PlanUsageBars`)、界面内 **Sign in**(弹窗展示白名单域名、不静默打开浏览器、永久保留可复制的 `cycle login <agent>` 兜底)与 **Sign out**(`ConfirmDialog`),各组自带 Refresh。`ConnectionManager` 按工作位置 `kind` 与 daemon 声明的 `signInModes` 选登录模式(Codex 本地 `browser`、远端 `device_code`;Claude 与 Antigravity `"code"`)。空白页遇到未登录时的 "Open subscriptions" 直达这里。
  - **API keys**:自带模型(protocol.md §10),即原来 Codex 页里的 Model providers,内容不变,只是不再挂在某个 agent 页下。
  - **Team(团队)**:先列出、置灰、行尾写 "Soon",不能选;键盘方向键可以走到它(标签页规范),但不会打开。以后接团队的网关。
- **Harness（Claude / Codex / Antigravity 及扩展 agent，CYCL-226）**：替代原平铺的 `Defaults` 分区，在设置导航中按 **Harness** 分组固定列出内置 agent（以及新 daemon 声明的扩展 agent），每页自上而下分为三组(账号与套餐用量已挪到上面的 Subscriptions):
  1. **Session defaults**：原 Agent defaults 编辑区（`_cycle/agent_defaults/*`）；连着多个工作位置时先选工作位置(选择器叫 "Work in")；旧 daemon 未声明 `agentSetup` 能力时平滑降级为只显示此区块。
  2. **Agent settings**（`RuntimeConfigForm`）：编辑 Cycle 托管的热生效运行时开关（`boolean` 开关、有界 `integer`、封闭 `oneOf` 选择、`enabledWhen` 联动禁用、`applyScope` 生效时机、`danger` 警示、单字段 `Reset` 传 `null` 恢复继承、`revision_conflict` 重载提示、`fileError` 只读降级、未来未知类型只读展示；无属性且无 `fileError` 如 Codex 时自动隐藏）。
  3. **Runtime**(运行信息,原 Host configuration)：只读展示二进制路径/版本、托管数据目录、`allowEnv` 与 `envNames` 变量名（绝不显示值）、`config.json` 路径及 `stale`/`error` 提示（本地支持在文件管理器中显示，远端支持复制路径）。空白页遇到 agent 不可用且 daemon 支持 `agentSetup` 时，提供直达对应 Harness 设置页的快捷按钮;二进制有问题时 Harness 页顶上仍有提示。
- **Keyboard shortcuts**:只读的清单,列出全部快捷键和按键(DESIGN.md §5.4 的那一张),按"应用"和"会话中"分两组。不能改键:改键要处理冲突、输入法和原生菜单,没有排进这一轮。
- **主题和语言(CYCL-79)**,理由见决定笔记 [`2026-11-22-appearance-and-language-preferences`](../.agents/notes/2026-11-22-appearance-and-language-preferences.md):
  - 由**主进程**保存和应用。页面经桥上的 `preferences()` 读、`setPreferences()` 改;主进程先写 `preferences.json`,写成功才生效,写不成就报错、什么都不变。读不懂的值(手改坏的、更新的版本写的)按"跟随系统"处理,文件里不认识的键原样写回。
  - **主题**用 Electron 的 `nativeTheme.themeSource`:窗口里的 `light-dark()` 和 `prefers-color-scheme`、代码配色的深浅、原生的菜单和对话框一起变,样式不用改。启动时在建窗口之前就应用,所以第一帧就是选定的主题。
  - **语言**:English 和简体中文两份目录(`packages/ui/src/messages/`),每种语言用它自己的名字列出。"Match system" 取系统首选语言:简体中文的 locale(`zh`、`zh-CN`、`zh-Hans-*`)用中文,繁体(`zh-TW`、`zh-HK`、`zh-Hant-*`)和其他语言用 English。选了立即整页切换,不用重启;页面在读到偏好之后才画第一屏,所以不会先闪一下英文。`<html lang>` 跟着变。主进程自己说的话里,系统通知跟随所选语言。
  - **不翻译的**(decision 0012):agent 的输出、ssh 和 daemon 的原话、命令、路径、版本号、agent 给的设置名和选项名;另外主进程自己产生的报错(更新失败的原因、"Updates are for the installed app."、本机工作位置的名字 "This computer")目前仍是英文。
  - 埋点:`theme_changed`、`language_changed`(主进程发,只带选了哪一项)。
  - 中文目录的键和占位符与 en-US 一致由类型和测试保证(`test/languages.test.ts`);译文本身没有经过母语审校之外的检查,真实窗口里各处的中文版式只在画廊里看过设置页和一个对话场景。
- **下一轮输入建议(CYCL-225)**:General 里的开关 "Suggest the next message",默认开，和主题、语言一样存在 `preferences.json`。主进程发每条 prompt 时按它带上 `_meta["cycle/promptSuggestions"]`(protocol.md §8),所以关掉之后 agent 不再做建议。agent 给的建议(`_cycle/prompt_suggestion`)在输入框空着、agent 空闲时代替原来的提示文字，样式不变;→ 或 Tab 把它变成输入内容，光标在末尾。打字时它让位，清空后再出现，下一个 turn 开始(`user_message`、`running`、`requires_action`)就作废。关掉开关时，已经收到的建议也不显示。没有建议的 agent 照旧显示原来的提示文字。埋点:`prompt_suggestions_toggled`(主进程)、`prompt_suggestion_accepted`(页面，只带按的是哪个键)。
- **存储(CYC-277)**:每个 agent 的 Harness 页末尾有一组 Storage,按所选 location 显示该 agent 在 daemon 机器上的 HOME 里占了多少(协议见 protocol.md §16 "本地存储"):**Caches**(包管理的下载缓存,一个 Clear caches 按钮,点了先确认,说明登录和会话记录保留、下次用到会重新下载,确认后在行里写"已清理多少")和 **Session records**(会话恢复要读的记录,只显示不提供清理)。三种不出现按钮的情况:daemon 没声明 `storage` 能力(整组不显示,也不去问),agent 的 HOME 是用户自己的文件夹(说明原因),还没存过东西(说明何时会有)。agent 有会话在工作时 daemon 拒绝清理,界面在确认框里照实说,框不关。埋点 `storage_cleaned`(主进程发,只带 agent 和结果)。测试 `packages/ui/test/browser/storage.browser.tsx`。
- **旧入口**已去掉:侧栏底部的 App settings 菜单、switcher 旁菜单里的 Add location、Agent defaults、Edit、Remove。会话自己的设置(Session settings)仍在会话标题的菜单里,它属于会话。
- **埋点**:打开页面是 `panel_opened` 的 `settings`(带 `via`),换分区是 `settings_section_shown`;分区里的动作沿用原有事件(`analytics_toggled`、`update_checked`、`location_saved`、`agent_defaults_saved`、`code_theme_changed` 等)。
- **没验证**:安装版真实窗口里的拖动区域和红绿灯位置(画廊里看过版式,深浅色、1200×800 和 720×480)。

## Connector

侧栏顶部的 **Connectors** 打开 **Connectors 页**(CYCL-82):和设置页一样的整窗页面(`PageLayout`,`connectors.tsx` 的 `ConnectorsPage`),管理某个工作位置的 daemon 替所有 agent 保管的东西。原来的对话框已去掉。

- **进出**:和设置页相同。页面打开时会话那一侧保持挂载、不显示(`hidden` 加 `inert`);`Esc` 或 Back 回到会话,焦点回到侧栏的 Connectors 按钮;页面上面开着表单、确认或菜单时 `Esc` 只关它们;`⌘N`、`⌘K` 仍可用,新建或选中会话就离开页面;按 `⌘,` 换到设置页。同一时间只有一个页面。再次进入回到上次的分区。没有自己的快捷键。
- **分区**:清单在 `connectors-sections.ts` 的 `CONNECTORS_SECTIONS`(这些词也是埋点里的词),每个分区在 `connectors.tsx` 的 `SECTIONS` 里写明它需要 daemon 的哪项能力和画什么。现在有两个:**Plugins**(`plugins`,能力 `plugins` 里至少有一个 agent,protocol.md §15,CYCL-84)和 **MCP servers**(`mcp`,能力 `connectors`,protocol.md §14)。页面默认打开第一个。
- **工作位置**:页面一次管理一个工作位置,这个选择属于整个页面,各分区共用。候选是已连接、并且至少声明了一个分区所需能力的工作位置;默认是当前打开的会话所在的工作位置。多于一个时,分区顶部有一行 Work in 选择器;换工作位置后分区从头读取。一个候选都没有时说明原因,并给去 Settings → Work in 的按钮。选中的工作位置做不了当前分区的事(daemon 太旧)时就地说明,不发请求。工作位置断开后它不再是候选。
- **MCP servers**:一组 `PageRows`,每行是状态点和名字,下面一行是状态词(Ready、Needs sign-in、Off,出错时按 `reason` 写成固定的句子)和去哪里(http 的主机,或 stdio 的命令,等宽,放不下时保留末尾);行尾是开关(立即生效),需要登录的 OAuth 服务器有 Sign in,编辑、退出登录、删除在行尾的菜单里。某一行的操作失败,原因写在那一行下面。删除前先确认(`destructive`,焦点在 Cancel),因为它的登录和密钥会一起永久删掉。"Add connector" 在这一组的右上;一个都没有时它在空状态里。读取中、读不出来(原话加 "Try again";已读到的清单保留)各有状态块。等浏览器登录时列表上方有一行说明和 "Stop waiting"。
- **Plugins**(`plugins.tsx`):某个工作位置上某个 agent 的 plugin。daemon 声明了多个有 plugin 的 agent 时,顶部多一行 Agent 选择器。三组:
  - **Installed**:每行是状态点、名字、一行事实(On/Off、版本、它带了什么:几个 skill、命令、子 agent、hook、MCP 服务)和一行说明(放不下时截断);行尾是开关和菜单(Update、Uninstall)。它带的服务器还要登录或要填值时,在这一行下面逐条写明,并给 Sign in 或 Set values。卸载前确认(`destructive`),它的 MCP 服务的登录会一起删掉。
  - **Available**:搜索框(停顿 200 毫秒后查询,回车立即查)和来源选择(多于一个来源时才有);每页 30 个,下面写"Showing n of total"和 Show more。已装的标 Installed,没装的有 Install。**安装前一定确认**:对话框写明来自哪个来源,以及 plugin 可以在那台机器上运行代码(hook、命令、MCP 服务)。确认后对话框立即关上,结果写在那一行(取仓库可能要几十秒)。
  - **Sources**:来源的清单(种类是固定的词,地址等宽、保留末尾);Add source 是表单对话框,写明"来源里列的东西可以被安装并运行";Refresh lists 重新取清单;agent 自带的来源不能移除。
  - 失败时先是 Cycle 的一句话(按 `PluginProblem` 的词),下面等宽显示 agent 自己的原话。
- **plugin 带来的 connector**:在 MCP servers 里和用户自己加的排在一起,标"From the … plugin",没有开关、编辑和删除(这些随 plugin 走),可以登录、退出登录、填值。要用户填的值(`requires`)在 `connector-values.tsx` 的对话框里填,只写不读。
- **表单**:添加和编辑是开在页面上面的表单对话框(DESIGN.md §4.5):回车提交,打开时焦点在名字上,Cancel 在左。字段:名字;远程 URL 或本地命令(参数一行一个、可选的工作目录);远程的可以选 OAuth,并可填 client id(给不支持动态注册的服务器)。密钥是 http 的请求头或 stdio 的环境变量,**只写不读**:页面送出值,之后只看到名字和"已设置",能替换或删除,看不到值。
- **凭证上线路的方向**:长期凭证(OAuth access/refresh token、API key)仍严格不上线路。在此之外有两个有意登记的受控例外:
  1. **Connector 密钥与 OAuth(唯一持久密钥单向上行例外)**:页面把用户填的密钥经主进程送给 daemon;daemon 从不回传。Connector 的 OAuth 授权码不经过页面:主进程在 `127.0.0.1` 的随机端口开回调,把这个地址交给 `auth/start`,用 `shell.openExternal` 打开 daemon 给的地址(只开 https,或指向本机的 http),拿到回调后把 `code`、`state` 交给 `auth/finish`。PKCE 的 verifier 在 daemon,授权码单独拿到没有用。同一时间只有一个登录在等浏览器,新的会取消旧的;最多等十分钟;回调服务器在每条路径上都会关掉(`connector-auth.ts`,`test/connector-auth.test.ts`)。
  2. **Harness hosted-callback 一次性授权码(第二个有意例外,CYCL-226 / CYCL-233)**:在 Settings → Harness 的 `"code"` 登录模式(Claude `claude auth login --claudeai`、Antigravity `agy acp --login`)下,用户从外部浏览器粘贴的短期一次性 OAuth authorization code 经页面输入框 → 主进程 → L1(`_cycle/agent_auth/submit`)送至 daemon。与 Connector 不同,此处授权码经由页面输入框进入主进程,因此落实以下硬性缓解措施:
     - **零持久化零日志**:授权码仅驻留内存并一次性写入登录子进程 stdin,永不落盘、永不写入 session JSONL / `daemon.log` / 错误对象 / 埋点(`apps/daemon/test/agent-auth.test.ts` 与 `apps/desktop/test/manager.test.ts` 均有防泄漏断言);
     - **PKCE + 连接绑定 + 单次消费 + 10 分钟 TTL**:PKCE verifier 留在登录子进程侧,`flowId` 绑定发起连接且 `submit` 原子单次消费(`pending → submitting`),超 10 分钟或连接断开/daemon 关闭立即终止子进程;
     - **桌面端硬编码防钓鱼白名单 + 禁止静默外链**(`apps/desktop/src/main/agent-auth-guard.ts`,`test/agent-auth-guard.test.ts`):允许的 HTTPS 域名完全硬编码在桌面主进程(`claude`:`claude.com`/`claude.ai`/`platform.claude.com`;`codex`:`auth.openai.com`;`agy`:`accounts.google.com`),绝不由 daemon 声明,同时校验 `authorizationUrl` 与 `verificationUrl` 并拒绝非标准端口、内嵌凭据或子域仿冒;只认官方 CLI 打开的那条路径(如 `claude.com/cai/oauth/authorize`、`accounts.google.com/o/oauth2/auth`、`auth.openai.com/codex/device`),带 `redirect_uri` 时它也必须回到该 agent 自己的回调(Claude 的 `platform.claude.com` 等、agy 的 `antigravity.google`、Codex 的本机回环),以免远端 daemon 递来同域名下别人应用的授权页;主进程绝不静默调用 `shell.openExternal`,仅在弹窗展示校验后的目标域名并由用户点击 `Open in browser` 时经 `openAgentAuthUrl(locationId, flowId)` 打开;任何失败、拦截或断线均保留可复制的 `cycle login <agent>` 终端兜底命令。
- **错误**:daemon 的拒绝(`data.reason`)在主进程变成固定的词(`connectorProblemOf`),页面按词显示整句,并写在出问题的那一行或表单下面。
- **plugin 的埋点**(主进程发,`test/manager-plugins.test.ts`):`plugin_installed`、`plugin_removed`、`plugin_toggled`、`plugin_updated`、`plugin_source_added`、`plugin_source_removed`、`plugin_sources_refreshed`,只有 agent 是哪一类、结果的词和个数,不发 plugin 的名字、来源地址和 agent 的原话。
- **埋点**:`connector_added`(传输、登录方式、密钥个数)、`connector_changed`、`connector_removed`、`connector_authorized`(`ok`/`failed`/`cancelled`)、`connector_signed_out`(主进程发);打开页面是 `panel_opened` 的 `connectors`,换分区是 `connectors_section_shown`(`section` 是固定的词)。不发名字、URL、命令和密钥(`test/manager-connectors.test.ts`)。
- **没验证**:真实的授权服务器(测试里是假的 daemon 和假的浏览器);安装版真实窗口里的样子(界面测试在无界面的 Chromium 里跑过)。

## Cycle 账号(CYCL-149)

决定见 [2026-11-23-sso-login-desktop-must-sign-in](../.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md)。桌面端必须登录;daemon、CLI、测试和 harness 不登录。

- **登录**(`main/account.ts`,OIDC 在 `packages/oidc`):authentik 的公共客户端 `clawdot-team`,端点从 discovery 读(discovery 的 `issuer` 必须是请求的那个,端点只认 https)。授权码 + PKCE(S256),`state` 常量时间比较,ID token 校验 `iss`、`aud`、`exp`、`nonce`(从 token 端点经 TLS 直接拿到,不验签名,OIDC Core §3.1.3.7)。回调复用 connector 那一个(`connector-auth.ts`):`127.0.0.1` 随机端口、`/callback`、只收一次、最多十分钟、每条路径都关掉;同一时间只有一个登录在等,再点只是等它的结果。
- **存储**(`main/account-store.ts`):安装版用 Electron 的 `safeStorage` 加密后放在 userData 的 `account.sealed`,密钥在钥匙串里(应用自己的条目,由签名约束)。钥匙串不可用时不落盘,宁可每次启动重新登录。从源码运行放 `account-dev.json`(0600),测试放 `account-test.json`;这两种都不碰钥匙串。从源码运行和安装版是 Electron 眼里的两个应用(名字、userData 都不同),各有一份登录。记的是 issuer、client、`sub`、显示名、email、最后一次 IdP 接受登录的时间和 refresh token;issuer 或 client 对不上就当作没登录。退出或被拒后只留下"是谁",没有 token,用来判断下次是不是换了人。
- **续期**:串行,同一时刻只有一个,其余等它;新的 refresh token 先写进存储再用。access token 只在内存里,剩不到 2 分钟才续,看的是墙上时钟。续期结果的 `sub` 变了按被拒处理。`invalid_grant` 是"需要重新登录"(`reauth`),网络错误、超时、5xx 是"暂时离线"(`offline`)。一个 5 分钟的定时器只负责"看一眼":离线时重试,超过一天没续就续一次让登录保持滑动。
- **启动闸门**:没有 refresh token、或最后一次被接受已超过 30 天,就只显示登录页,不连接任何工作位置、不读会话;主进程在 `dispatch` 里拒绝 manager 的所有方法,页面只拿得到账号、外观、更新这些主进程自己的方法。在宽限期内,启动时向 IdP 确认一次,最多等 5 秒:被拒进登录页,连不上照常打开(离线)。这 5 秒里窗口已经打开,显示"正在启动";页面问 `account` 时主进程等确认结束才回答。登录页显示时,`AppWindow` 根本不挂载,它的快捷键和副作用都不运行。
- **开着时被拒不踢人**:正在跑的会话、打开的窗口都不动,顶部一行提示"重新登录",点一下走登录流程;下次打开才进登录页。离线时顶部一行说明在线功能暂时不可用。
- **退出登录**(设置 → General 的 Account,先确认):先跑 `onSignOut` 注册的步骤(给 CYCL-162 清各工作位置的服务凭证用),然后先在本地忘掉登录、回到登录页,最后才向 revocation 端点吊销 refresh token(失败只记日志):离线时吊销要等满超时,这期间退出应用也不会留着登录。已连上的工作位置不断开,本地会话、设置、connector 不动。**换账号**:登录得到的 `sub` 和上一个不同,先做一遍退出的清理,再提示"已切换到 …";同一个人重新登录什么都不清,只吊销旧的 refresh token。
- **页面拿到的**只有 `AccountStatus`(状态、是否打开、是否在等浏览器、显示名和 email、原因和问题的固定词),没有任何 token;日志和报错只写发生了什么,token 和 IdP 的原话都不写(`test/account.test.ts` 把 IdP 见过的每个 token 和日志、状态、报错、埋点逐一比对)。
- **测试**:`CYCLE_SSO_ISSUER` 把 issuer 换成测试的替身 IdP(`@cycle/oidc/mock-idp`:强制 PKCE、校验回调地址、授权码一次性、refresh token 轮换),只接受本机的 http 地址;它只换"去哪登录",并且让登录存到测试自己的文件。安装版也认它:能设这个环境变量的人本来就能读写这台机器上的本地数据,登录页不是本地数据的安全边界;它挡的是"没有 Clawdot 账号的人用产品",而指向本机替身拿到的 token 对任何真实服务都没用。打包的集成测试先写好一份已登录的记录(`test/integration/signed-in.ts`);更新测试还设 `CYCLE_USER_DATA`,让更新后重新打开的应用仍用测试的目录,而不是用户真实的 userData。
- **埋点**:`sign_in_shown`、`signed_in`、`sign_in_required`、`offline_grace`、`signed_out`、`account_switched`(主进程发),只有固定的词和布尔,不报是谁。
- **没验证**:真实的 authentik(refresh token 的实际有效期、吊销);安装版真实窗口里的登录(界面测试在 Chromium 里跑,整个流程在 web 集成测试里对替身 IdP 跑过)。

## 终端(CYCL-98)

右侧面板里可以开 session 的终端:shell 跑在 daemon 那边,在 session 的文件夹里,本地和 ssh 一样(protocol.md §8"终端",决定笔记 [2026-11-22-terminals-in-the-daemon-over-l1](../.agents/notes/2026-11-22-terminals-in-the-daemon-over-l1.md))。daemon 没有能力 `terminal` 时,界面上没有终端的入口。

- **入口**:会话头部的终端按钮。没有终端时开一个;有就显示上次看的那个,没看过就显示最新的;正在看终端时再按就收起面板。面板标签条末尾的 **New terminal** 再开一个。每个终端一个标签,排在 Overview、Files、Diff 之后,标题是 shell 的名字,shell 设了标题就换成它。
- **标签从哪来**:终端是 daemon 的,不存在页面里。标签条显示的就是 daemon 列出的这个 session 的终端(`_cycle/terminal/list` 加 `changed` 通知);`side-panel.ts` 只记住上次显示的是哪一个。所以重开应用、刷新页面后标签还在,从 daemon 的屏幕重画。
- **关闭**:点标签上的叉,或者焦点在标签上时按 Delete 或 Backspace。关闭会结束 shell 和里面跑的东西,不再确认(删除会话才要确认)。关掉正在看的标签时,显示它前面那个。daemon 没收到关闭(连接正好断了)时,说出原因,重新读列表,shell 还在的话标签回来。
- **显示和输入**:页面用 `@xterm/xterm` 画,只有显示着的标签附着(`attach`),切走或收起就 `detach`,不看的终端不占这边的资源。`attach` 的应答和输出走两条路,先后不定:输出先到的先存着,应答到了以后丢掉屏幕里已经有的(`seq` 不大于应答的),落后时 daemon 发 `reset` 也一样(`terminals.ts` 的 `TerminalFeed`)。按键和粘贴原样发出,大段粘贴切成小于 64 KiB 的几段。复制粘贴用的是应用菜单的复制、粘贴,xterm 自己处理,页面不需要剪贴板权限。
- **尺寸**:跟着面板变,停下来 80 ms 后告诉 daemon;附着之后和终端拿到焦点时各告诉一次(多个客户端以最后一个为准)。daemon 给的屏幕(附着的应答、`reset`)是按 daemon 当时的尺寸画的:先按那个尺寸写进去,再缩放回面板的尺寸,行和光标才对得上。
- **状态**:shell 退出后标签变淡,底部一行说退出码,带 **Close terminal**;工作位置断开时底部一行说断开了,不能输入,连回来后重新附着;连回来发现终端已经没了(daemon 停了,包括空闲退出),标签留着,说它随 daemon 停止而结束,用户关掉标签为止;附着失败时说原因,可以重试。打不开时(数量到上限、会话已归档、文件夹不在了、shell 起不来、daemon 正在停止)主进程把 daemon 的拒绝转成固定的词(`terminalProblemOf`),页面显示对应的整句。
- **颜色**:底色、文字、光标、选区取 Cycle 的令牌,跟着深浅色变;16 个 ANSI 颜色是程序输出的内容,和代码配色一样用 GitHub 的配色(`terminal-theme.ts`)。
- **键盘**:焦点在终端里时,按键先给 shell。macOS 上 ⌘ 组合键 xterm 不处理,应用的快捷键照常;其他平台上 Ctrl 组合键归 shell,面板用按钮开关。
- **埋点**:`terminal_opened`、`terminal_closed`、`terminal_open_failed`,只有入口、状态、个数分档和原因的固定词。不发 shell、目录、输入和输出。
- **测试**:规则在 `packages/ui/test/terminals.test.ts`;界面在 `test/browser/terminal.browser.tsx`(假的 bridge);真 daemon 和真 shell 在 `apps/desktop/test/integration/web.integration.ts` 里:打开、输入、看到输出、刷新后重画、关闭。
- **没验证**:远端(ssh)工作位置上的终端,和打包后的真实窗口里的复制粘贴。

## 公共组件(CYCL-52)

后面的界面都从公共部件搭，不再各写一套;部件和它们的规格在 [DESIGN.md](../DESIGN.md) 第 3 层。CYCL-64 的盘点(2026-11-21 的快照)已全部处理完，见 git 历史。

SDK 的几个坑(beta.6,写在这里免得再踩):

- Menu 和 Popover 的内容默认用 `aria-labelledby` 指向触发器,传进去的 `aria-label` 盖不过它:要按标题命名,给标题一个 id,在内容上传 `aria-labelledby`。
- 两个菜单先后打开时,`finalFocus="trigger"` 可能把焦点还给前一个菜单的触发器;要还给自己的触发器,传一个返回它的函数(`setting-chips.tsx`)。
- 鼠标打开的菜单,焦点在菜单本身、没有高亮项,第一下方向键落在首项;键盘打开的直接落在首项。程序化 `focus()` 改不了它的高亮,所以选择器不再"打开就停在当前值"上,当前值用对勾标出。

## 还没做

- **plugin**(CYCL-57 之后):项目级范围(现在只装和启停用户级);运行中的会话即时生效(现在是下次启动 agent 时);来源要先运行自己命令的 plugin;plugin 自己的选项(Claude 的 `plugin configure`);工作位置的 Cycle 不支持 plugin 时页面仍默认打开 Plugins 分区(就地说明太旧)。真实登录只用 Linear 走通过(2026-11-23,经 daemon 和网关,不是在安装版窗口里点的),其他服务器没试。
- **远端 daemon 的升级**:应用只更新自己和自带的本地 daemon;远端的 daemon 由用户决定何时升。应用带一个 `MIN_DAEMON_VERSION`(`src/shared/release.ts`),**远端 daemon 低于它**才在标题栏下面出现一行提示和一个"Update to x.y.z"按钮;高于或等于它就不提示,即使比应用旧(多数版本只改界面,不动 daemon)。`dev`(从源码运行)和读不出版本的不提示,本地的也不提示。
  - **什么时候抬高它**:应用开始依赖旧 daemon 没有的东西(字段、方法、行为),而且不能像 `capabilities` 开关那样"没有就关掉那个功能"。发版时问一句:这次有没有这种改动。可以关掉的功能用 capabilities,不动它。门禁测试保证它是合法版本号且不晚于应用自己的版本。
  - **按钮做什么**:确认后,应用用该工作位置同一个 ssh 主机(`BatchMode`,不交互)在远端运行 `daemonUpgradeCommand`(下载本版本的 tarball、校验、`install.sh`、`cycle stop`),`cycle stop` 让连接断开,重连时接上新的 daemon,已打开的会话原样保留。确认框里,如果该机器上有会话在工作,会列出它们,让人选"等它们结束再更新"(远端后台 `cycle stop --wait`)或"立即更新并中断"(`cycle stop --force`);没有在工作的就是普通的 `cycle stop`,它不会中断确认之后才开始工作的会话。见 [daemon.md](daemon.md)"停止和升级"。
  - **失败时**:那一行变成错误并附上同一条命令,让用户在那台机器上手动运行(远端连不上 GitHub、没有 `curl`/`sha256sum`、ssh 需要交互,都会走到这里)。第一版不做"应用下载再传过去"。
  - 按远端架构选用 Linux x64 或 ARM64 包。理由见 `.agents/notes/2026-11-19-daemon-minimum-version-and-upgrade-button.md`。
  - **协议不兼容(与上面的最低版本不同)**:最低版本说的是"能不能用",而协议主版本不同时 daemon 在握手就以 `-32022` 拒绝,连接根本建立不起来(docs/protocol.md §3)。客户端把它保留成带 `supported`(daemon 说它支持的)和 `requested`(应用要的)的结构化错误,初次连接和重连都一样;重连时仍按退避继续试,换上兼容的 daemon 后自己连上。工作位置的状态里带 `incompatible`:`with` 说哪一边要改(daemon 的主版本低于应用的是 `daemon`,高于的是 `app`,比不出来是 `unknown`)。界面在那个工作位置下显示一行原因:`daemon` 时给出远端 Linux 上更新 daemon 的命令(本地 daemon 不给,它随应用更新);`app` 时只说要更新应用,**不**提示降级 daemon。普通的 ssh 或网络故障不带 `incompatible`,仍是连接错误和重连。连接成功后这行消失。目前两边的主版本都是 `0`,这条路径要等协议升主版本才会走到。
- **会话内容的全文搜索**:⌘K 搜的是标题、文件夹、agent 和主机(跨已连接的主机)。对话内容的全文要在历史所在的 daemon 里做。
- **图片和文件的发送只对声明了能力的 agent 开放**:附加的控件(按钮、粘贴、拖放)只在 `_cycle/agents/list` 里这个 agent 的 `promptCapabilities.image` 或 `embeddedContext` 存在时出现;只有 `image` 时只收图片(按钮叫 "Attach image"),有 `embeddedContext` 时还收文本文件和 PDF(按钮叫 "Attach files",选择框不限类型),其余文件就地拒绝并说原因(决策笔记 [`2026-11-22-attach-any-file`](../.agents/notes/2026-11-22-attach-any-file.md))。带附件支持的 daemon(decision 0010)上的 Claude 声明了;更早的 daemon 不报告,界面上就没有附加入口,不会发出 daemon 不认的内容。主进程这一段有测试(`apps/desktop/test/manager.test.ts`):能力被报告,图片块原样送达 agent,没有声明的 agent 拒绝图片。
- **Claude 的 `config.json`**(`configDir`、密钥):没有 UI,因为它会把凭证放上线路。要在 daemon 所在机器上手改。CYCL-80 研究的结论是界面只显示状态(从不显示值)、修改仍在那台机器上做,见决定笔记 [`2026-11-22-claude-config-status-not-values`](../.agents/notes/2026-11-22-claude-config-status-not-values.md);还没有实现。
- 多窗口、可访问性审查(ui-sdk 的组件有基础的键盘和 ARIA,我们自己的部分没单独审)。
- 真实账号的浏览器 OAuth 授权暂缓（CYCL-110）。独立目录和凭证边界的验证见 [Claude 适配](adapters/claude.md#隔离登录验证)。

## 通知

一个你没在看的会话需要你(等你回答、做完了、agent 没了)时,主进程用系统通知告诉你;设计和限制见 DESIGN.md 附录 D。主进程在每次重读会话列表时和上一次比较(`ConnectionManager` 的 `attention` 选项),窗口在前面时不显示;点通知回到那个会话(`focus-session` 事件)。macOS 上通知需要应用已签名并经用户允许,这一点没有在 Mac 上验证。

断线期间一个正在看的会话被别的客户端删除时,重连后主进程发 `session-gone` 事件:界面丢掉这个会话的视图(包括它的权限卡片)、草稿和"当前打开"的选择。重连后某个会话的历史读不出来(`-32015`)时不发 `session-gone`(会话还在,视图和草稿保留):这个会话不再被观察,待答复的权限卡片按取消处理,其他会话照常恢复,主机回到 connected;它在列表里带 `historyFailed` 标记,重新打开会看到原因,也可以从列表删除。
