# AGENTS.md

给在本仓库工作的 coding agent 和协作者的说明。

You are the owner and long-term maintainer of this codebase, and its design is up to you.

## 项目

cycle-v1 是 ADE(agentic development environment),是 cycle 的重写。这是全新的代码库:不拷贝旧 cycle 的代码。
可以读旧 cycle 里**已经写下的经验**,取"为什么"和踩过的坑,不取实现:old-cycle(`OhMyJames/old-cycle`,Cycle 2.0,同样是 ACP v2 加 Claude)的决定笔记 `.agents/notes/`、设计文档 `.agents/designs/`,以及它那些写了规则的纯函数(如 `acp/blocks.ts` 的排版规则)。
用到时,把结论写进我们自己的 `docs/decisions/` 或文档,注明出处;我们的前提和它不同(daemon 自己存 JSONL,L1 事件由 L2 映射而来),不要照搬它为透明代理做的补丁。
目标和范围见 [README.md](README.md)。

## 当前阶段

v1 已可用(桌面应用加 Linux daemon),在迭代功能。协议先行:改行为先改 `docs/protocol.md`,再改实现。文档入口见 `docs/` 下的 architecture、daemon、desktop、testing。

## 架构约束

- 三层:L1 客户端到 daemon(自有协议,稳定,zod schema)、L2 daemon 到 agent(以 ACP v2 为主要参考)、L3 agent 适配。
- 不使用官方 `claude-agent-acp`;Claude 适配自己写,且必须自包含、传输可替换,为云端 sandbox 留路。
- L1 的消息模型以 ACP v2 为蓝本,字段和语义保持一致,不另造事件模型。ACP 类型直接从 `@agentclientprotocol/sdk/experimental/v2` 导入(精确版本固定在根目录 `package.json` 的 `workspaces.catalog`,门禁禁止导入 `unstable` 或其他入口,见 `.agents/notes/2026-11-19-workspace-layout-and-direct-acp-sdk.md`)。Cycle 自己的扩展用 `_cycle/*` 和 `_meta`,用 zod 定义在 `@cycle/protocol`。
- daemon 自己保存会话历史(JSONL),不依赖 agent 重放。只管理 Cycle 自己创建的 session。
- session 事件日志用 JSONL,放在存储接口后面。
- L1 事件由 L2 的 ACP 更新映射而来,不原样透传,使客户端不受 ACP 变化和具体 agent 的影响。
- agent 是可替换的接口。`HARNESSES` 里已有 Claude、Codex、agy;pi 仍在接入中(CYCL-154)。daemon 核心之外按名字认 agent 的地方都从 `apps/daemon/src/harnesses.ts` 的清单读，不要再写死某一个 agent;加一个 agent 的步骤见 [docs/daemon.md](docs/daemon.md) 的"加一个 agent"。
- 协议和传输分离。远程连接走 SSH 隧道,协议本身不依赖具体传输。
- v1 桌面端规划包括右侧面板、diff 视图、交互式终端、内置浏览器及 browser use、plugins 和 settings 页。后续设计沿用三份决定笔记：[右侧面板（CYCL-89）](.agents/notes/2026-11-19-right-panel-scope.md)、[终端（CYCL-96）](.agents/notes/2026-11-19-desktop-terminal-scope.md)、[browser use（CYCL-100）](.agents/notes/2026-11-19-browser-use-scope.md)。
- 独立 Web 端仍在 v1 范围外。git worktree 由 daemon 管,见 [决定笔记](.agents/notes/2026-11-24-worktree-is-cycles.md)(CYC-273)。多个 agent(以及它们各自的模型 provider)已在范围内，见上面"agent 是可替换的接口"一条和 `docs/adapters/`。

## 界面

改 `packages/ui` 或 `apps/desktop` 渲染进程前,先读 [DESIGN.md](DESIGN.md)(五层设计系统,令牌、材质、组件、范式的单一事实源)和 `.claude/skills/cycle-design-taste`(怎么写、怎么审)。控件工程边界见 `packages/ui/AGENTS.md`。判断标准有两条:用户的注意力应该在 agent 在做什么上;复杂留给系统,不留给用户(细则在 DESIGN.md 的"定位与原则")。

## 命令

- `bun run check`:门禁,提交前必须通过(pre-commit 钩子会运行它)。依次检查边界、类型、lint、测试。
- `bun run test:browser`(根目录):界面测试,在无界面的 Chromium 里跑(`packages/ui/test/browser`),不在门禁里(约 23 秒、2 GB),CI 的 `browser` 作业每次跑。改了界面,提交前自己跑一次。
- `bun run format`:格式化并修复可自动修复的 lint。
- `bun run test:integration`(根目录):集成测试,串行跑 8 个套件(Node 下的客户端、Claude、Codex 和 agy 适配、真实 ssh、整个后端、打包后的应用、浏览器里的端到端),每个套件有自己的时限。每次全跑,不按改动挑选(见 `.agents/notes/2026-11-21-integration-runs-every-suite.md`),清单在 `scripts/integration-suites.ts`。它们会启动真实进程(Claude、daemon、打包后的 Electron 应用,Linux 上在 xvfb 下,macOS 上窗口隐藏、不抢焦点;以及无界面的 Chromium),最重的约 1.5 GB,所以不在门禁里。`bun run test:integration web` 只跑名字里有 web 的。
- **真实模型的运行**必须显式开启:`CYCLE_REAL_MODEL_TOKEN=... bun run test:real`(在 `harness/claude` 下;daemon 层的在 `apps/daemon` 下用 `test:real:daemon`;agy 用 `CYCLE_AGY_REAL_HOME=... bun run --cwd harness/agy test:real` 或 `apps/daemon` 下的 `test:real:agy`),token/凭据目录只给对应 agent 进程,不要从环境里继承,不要进 CI。
- `bun run build`(根目录):构建 daemon 的单文件可执行(约 40 秒,峰值内存约 0.25 GB,产出约 480 MB)和桌面端;`bun run start` 启动桌面端。真实模型的 `test:real` 在 `apps/daemon` 和 `apps/desktop` 下也有,要先 build。
- 目标机器是 2 核 4 GB:门禁在开发机上十几秒(测试用两个 worker 并行,2 核上会更慢;具体数字见 `docs/testing.md`)、各进程内存加起来峰值约 1.2 GB;不要把重的东西加进门禁,也不要并行跑集成套件。
- 测试里的等待要有上限:单个测试的超时是它该有的时间,不是"够长就行"。挂住的测试几十秒内必须失败。
- 不要用 `--no-verify`、`@ts-ignore`、`@ts-expect-error` 或 `biome-ignore` 绕过它;修复原因,或有意改规则。
- 测试放在各包的 `test/` 目录,与 `src/` 并列。
- `bun install` 会把 `core.hooksPath` 设为 `.githooks`。

## 埋点(每个用户可感知的功能都要有)

产品分析用 PostHog,在 Electron 主进程发送,代码在 `packages/analytics`,说明和事件字典在 [docs/analytics.md](docs/analytics.md),理由在 `.agents/notes/2026-11-19-product-analytics-posthog.md`。

- **新增或修改用户能感知的功能和操作(新的按钮、面板、命令、流程、连接和会话的动作、设置),必须同时加埋点,和功能在同一次提交里。** 没有埋点的功能不算完成。纯重构、内部修复、样式微调不需要。
- 流程:先想清楚要回答的产品问题;在 `packages/analytics/src/events.ts` 的 `EVENTS` 里加事件;在主进程知道的地方发(通常是 `ConnectionManager` 的各部分里,多数在 `apps/desktop/src/main/actions.ts`,动作成功之后),只有页面才知道的才加进 `UI_EVENTS` 并在页面里调 `store.track`;在 `docs/analytics.md` 的字典表里加一行(门禁检查两边一致);写测试,证明事件发出了,也证明内容没有跟着发出去。具体步骤见 docs/analytics.md 的"加新功能时怎么埋点"。
- **只报行为,不报内容。** 事件的属性只能是数字、布尔或一组固定的词。不得上报 prompt、agent 输出、路径、仓库名、标题、命令、报错信息、agent 的 id、配置值,以及任何用户或 agent 写的文字。不要在字典里用 `z.string()`;需要时把原始值变成词(像 `agentOf`、`settingOf`、`sizeOf`)。要上报自由文字,先问,再决定。
- 不要在页面或 daemon 里引入 PostHog 或其他 SDK,不要从页面直接联网;不要打开 autocapture、会话回放、异常自动收集。页面只能导入 `@cycle/analytics/events` 的类型。
- 测试和从源码运行不设 `CYCLE_POSTHOG_KEY`,永远不对真实的 PostHog 发送。统计默认开启,用户可在设置页(Settings → General)里关闭,首次启动有一条说明(见 `.agents/notes/2026-11-19-analytics-opt-out-restored.md`);这个开关、首次说明和环境变量 `DO_NOT_TRACK` / `CYCLE_ANALYTICS=off` 不要去掉或绕开。

## 红线(参考 old-cycle,以后违反前先问)

- 不让 agent 继承环境变量。`ANTHROPIC_API_KEY` 之类会覆盖账号登录并计费,环境变量只能走显式白名单。
- 测试永远不指向真实的 `~/.claude`、`~/.agents`、`~/.gemini` 和 Cycle 的真实数据目录。
- daemon 只绑 loopback 或 unix socket,因为 agent 能执行命令。不要放宽。
- 任何账号或 SSO 的 token 不得到达 agent。
- 埋点不上报内容(见"埋点"一节),PostHog 的 key 只在主进程,不给 agent。
- 删除 session 会永久移除记录,客户端必须先确认。

## 技术栈

Bun、TypeScript、Electron,均使用最新版本。包管理和脚本都用 Bun。

## 约定

- 文档用中文,代码标识符、协议字段和提交信息的类型前缀用英文。`AGENTS.md` 文件可以用英文(如 `packages/ui/AGENTS.md`),按所在目录已有的语言写,不为统一而翻译。
- 问题编号:项目改名后新编号用 `CYC-`(如 CYC-273),此前的 `CYCL-` 是同一个追踪器的旧编号,保留原样、不批量改写。
- 设计上的取舍记录成决定笔记,按 `agent-notes` 技能写(`.agents/skills/agent-notes`,`.claude/skills` 里有链接):什么情况才写、格式、怎么取代旧的。新笔记放 `.agents/notes/`,格式见它的 README。`docs/decisions/` 里已有的 0001–0014 是历史,保留原样、不改编号,新笔记不再往里加。
- 协议变更先改 `docs/protocol.md`,再改实现。
- 提交信息简短,说明做了什么和为什么。
- **发版只改第三位版本号**(`0.3.0` → `0.3.1`),不允许改前两位;改前两位是负责人自己的决定,不随发版做。发版流程会用 `scripts/release-guard.ts --step` 检查 tag。
