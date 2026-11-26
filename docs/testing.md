# 测试与 CI

目标机器:2 核 4 GB。门禁的时间在 2026-11-21 一台 Apple 芯片开发机上量的;集成测试的时间是 GitHub 的 2 核 runner 上的。

## 三层

|      | 命令                       | 时间     | 峰值内存        | 谁跑                              |
| ---- | -------------------------- | -------- | --------------- | --------------------------------- |
| 门禁 | `bun run check`            | 约 16 秒 | 约 1.2 GB       | 每次提交(pre-commit)、每个 PR(CI) |
| 界面 | `bun run test:browser`     | 约 23 秒 | 约 2.2 GB       | PR、手动(CI)                      |
| 集成 | `bun run test:integration` | 约 35 秒 | 约 1.5 GB(冒烟) | PR、手动(CI)                      |

门禁依次是:边界检查、Tailwind 生成 css、类型检查(约 1 秒)、lint、常规测试(约 1300 个,两个 worker 并行约 13 秒)。`check.ts` 在最后打印每一步的耗时。

迭代期可以用 `bun run check:changed`:按当前分支相对 main 的 merge-base 的改动加上未提交的改动,只跑受影响的包(含依赖它们的包)的测试;改了根 `package.json`、`bun.lock`、根 `tsconfig*.json`、`biome.json`、`bunfig.toml`、`.github/**`、`scripts/check*`、`scripts/boundaries.ts` 时跑全部测试,只改 `docs/` 之类不属于任何包的文件时什么都不跑。选包逻辑在 `scripts/changed.ts`。它不取代门禁,提交前仍跑 `bun run check`。

测试用 `bun test --parallel=2`:2026-11-23 量,一个进程跑约 24 秒、峰值约 0.63 GB,两个 worker 约 13 秒、各进程加起来约 1.2 GB。测试大多在等 I/O 和子进程,2 核上也能并起来;不要再往上加 worker,4 GB 的机器要留给编辑器和应用本身。

**界面测试在真实浏览器里跑**(`packages/ui/test/browser/*.browser.tsx`,约 200 个):Vitest 的浏览器模式,经 Playwright 启动无界面的 Chromium,不开窗口、不抢焦点。页面加载应用自己的样式表,窗口 1200×800(和桌面端一样),所以布局、可见性、焦点、选区都是真的。点击和按键用 `vitest/browser` 的 `userEvent`,是浏览器自己的输入事件:点击前等元素可见、可用、静止,和人一样点不到被盖住或已禁用的按钮;输入框(Lexical)是真的敲字和按键,不再走编辑器的命令。Motion 的动画跳过,CSS 的过渡照常跑。第一次运行时 `test:browser` 会自己下载 Chromium(约 100 MB,之后只检查一下,约半秒)。失败时 `packages/ui/.vitest/` 里有那一刻的截图,CI 会上传它。

它不在门禁里:两个文件并行约 23 秒、各进程内存加起来约 2.2 GB(一个一个跑 41 秒、1.6 GB),对 2 核 4 GB 的提交前检查太重。CI 里它是单独的 `browser` 作业,和 `check`、`integration` 并行;在 GitHub 的 2 核 runner 上测试本身约 33 秒,装 Chromium 要的系统库约 23 秒,整个作业约 1 分 20 秒,是三个作业里最长的。改了界面,提交前自己跑一次 `bun run test:browser`。

2026-11-21 从 happy-dom 换过来时,真实浏览器发现了 happy-dom 掩盖的几件事,都是测试写得不对,不是应用的错:ui-sdk 的快捷键提示在挂载后才换成本平台的按键;对话框关闭有退出动画,要等它离开;双击一个第一下就禁用的按钮只能真的双击;选项的输入框被 label 盖着,人点的是 label。

集成测试会启动真实进程(Claude、daemon、Electron、无界面的 Chromium),所以不在门禁里。8 个套件**串行**,每个有自己的时限:

**桌面测试不抢焦点。** 用户的流程(连接、建会话、打字和粘贴、聊天、权限、重载)在 `web` 套件里跑:构建出的页面在无界面的 Chromium 里,后面是真的 `ConnectionManager` 和 daemon(`apps/desktop/test/web/web-app.ts`),任何系统上都不开窗口。Electron 只剩打包测试,它证明的是只有 Electron 能证明的事:打包后的应用找到自带的 daemon,页面被锁住(CSP、没有 Node、桥接只有约定的方法)。Linux 上它在 xvfb 里跑;macOS 上窗口不显示,应用设成 `prohibited` 激活策略(不进 Dock、不能到前台)。打包后的应用读环境变量 `CYCLE_TEST_HIDDEN_WINDOW=1`,只有 macOS 上的测试会设它(Linux 的 xvfb 里没有谁的焦点可抢,窗口照常显示)。隐藏时应用也不发系统通知,页面不被后台节流。在开发机上跑 `bun run test:integration` 时,前台的应用一直是你自己的(2026-11-21 在 macOS 上按 0.1 秒采样验证过)。

| 套件    | 证明什么                                                                                                                                                                                                 | 时限   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| node    | 客户端和传输在真正的 Node(Electron 自带的)下能用                                                                                                                                                         | 60 秒  |
| adapter | 真实 SDK 上:不带 replayFrom 恢复后上下文完整;权限的允许和拒绝真的决定工具是否运行;模型输出到一半时取消                                                                                                   | 90 秒  |
| codex   | 固定版 app-server 与本地模拟 Responses API 通过 ACP stdio 对话、执行受限命令、取消回合；设置 CYCLE_DAEMON_BIN 可测安装包                                                                                 | 60 秒  |
| agy     | 真实 `cycle adapter agy` 子进程经 ACP v1↔v2 stdio 完整回合与环境隔离；本机装有 `agy >= 1.5.10` 时追加未登录 `-32000`、`cycle login agy` OAuth 链接及隔离 HOME 下的 `AgyPlugins` 生命周期验证             | 90 秒  |
| ssh     | **真实的 ssh**:一个私有的 sshd(非特权、回环端口、测试自己生成的主机密钥和用户密钥,不读不改 `~/.ssh`)加系统的 `ssh` 客户端;一个回合,断开,新连接拿到历史。设了 `CYCLE_DAEMON_BIN` 就用构建出的可执行文件跑 | 60 秒  |
| backend | `proxy` 自动启动 daemon、daemon 脱离、断线后新客户端拿到历史并继续、daemon 的环境变量不会到 Claude                                                                                                       | 120 秒 |
| package | 打包后的应用在干净的环境里(没有 bun、node、仓库)找到自带的 daemon 和 Claude,启动 daemon,窗口显示已连接;页面被锁住(CSP、没有 Node、桥接只有约定的方法)                                                    | 90 秒  |
| web     | 构建出的页面在无界面的 Chromium 里,浏览器自己的鼠标键盘:连接、建会话、打字和粘贴 Markdown、聊天、回答权限(工具真的运行)、重载;后面是真的 daemon、Claude 适配、SDK 和模拟 API                             | 150 秒 |

## macOS 签名包更新验收

用已登录图形桌面的 Apple 芯片测试账号串行执行。安装和替换都发生在临时目录。重启走 Launch Services，会使用该账号的 Electron 偏好设置。测试临时给登录会话设置 `CYCLE_HOME`、`CYCLE_UPDATE_URL` 和 `CYCLE_ANALYTICS=off`，退出时恢复原值。

1. **准备前后两个版本。** 取上一次发布和目标版本各自的 macOS CI 产物，每份都应包含原始 zip 和 `latest-darwin-arm64.json`。需要重新构建时，在两个发布提交上分别建测试分支，手动运行 `release.yml`，选 `sign=true` 和 `runner=self-hosted`。从**分支**运行只上传 artifact。从标签运行会进入发布流程。每次核对 Sign、Gatekeeper 和上传三个步骤都成功。0.3.6 和 0.3.7 的旧工作流给 macOS artifact 一律加了 `-unsigned` 后缀，下载这两个版本时按实际名称取包，下面的测试会检查包内签名。
2. **同团队安装。** 在仓库根目录执行下面的命令，替换两个 run ID。测试从回环地址提供原始清单和 zip，验证包大小、SHA-256、Developer ID、Gatekeeper、公证票据和 Team ID，驱动旧应用发现并安装更新。通过条件包括旧应用和 daemon 均退出、新应用重启、安装后的签名仍有效，以及临时套接字上的 daemon 在更新前后分别报出两个发布版本。
3. **异团队拒绝。** 另取一份由不同 Apple 团队签名并公证的较新 Cycle 构建，沿用旧版本，把 `CYCLE_SIGNED_TO` 指向该产物，另设 `CYCLE_EXPECT_DIFFERENT_TEAM=1` 再跑一次。应出现签名团队不匹配的错误，旧应用和原 daemon 继续运行，安装目录保留原版本，暂存目录清理完成。两张同团队证书具有相同 Team ID，只能用于同团队用例。
4. **远端旧 daemon 横幅。** 在更新后的版本中用「Add location」连接专用 SSH 测试机器，选择该工作位置的会话。使用能完成协议握手、版本低于目标版本 `MIN_DAEMON_VERSION` 的已编译 daemon（0.3.7 的下限是 0.2.1）。核对横幅中的工作位置名称、实际 daemon 版本，以及按钮的目标版本。换用达到下限的 daemon 后重连，横幅应消失。记录两次观察；远端协议主版本不兼容时会显示另一条提示。
5. **记录结果。** 保留两个构建链接、版本、Team ID、清单 SHA-256、正反例的测试输出及远端横幅截图。缺少异团队产物或测试环境的用例记为待验。

```bash
fixtures=$(mktemp -d)
gh run download OLD_RUN_ID -n app-darwin-arm64 -D "$fixtures/old"
gh run download NEW_RUN_ID -n app-darwin-arm64 -D "$fixtures/new"
CYCLE_SIGNED_FROM="$fixtures/old" CYCLE_SIGNED_TO="$fixtures/new" \
  bun test ./apps/desktop/test/integration/update.integration.ts
```

常规发布中签名前的更新测试仍走 `CYCLE_PACKAGED_APP`，会调高临时副本的版本并用 ad hoc 重签。该测试验证差分下载与重启，真实签名验收单独记录。

### CYCL-105 实测记录

mac-mini 上用同一 Developer ID 团队 `AGKXLGRXJ7` 对发布提交 0.3.6、0.3.7 分别签名并公证。原始清单和 zip 的 SHA-256 均保存在[验收日志](https://github.com/OhMyJames/Cycle-V1/actions/runs/44703626920)中。

| 用例                                           | 观察结果                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原版 0.3.6 → 0.3.7                             | 应用下载更新、通过团队检查并重启。旧 daemon 的 PID 已退出，五秒后临时套接字仍应答 0.3.6，已安装的二进制报告 0.3.7。旧桌面在退出前有机会自动重连，重新启动旧二进制。[复现记录](https://github.com/OhMyJames/Cycle-V1/actions/runs/44705021238)                       |
| 带重连修复的签名 0.3.6 测试副本 → 原签名 0.3.7 | 通过。旧应用和旧 daemon 均退出；新应用重启，本地套接字应答 0.3.7，运行中的 daemon 映射到新安装包内的可执行文件。此轮读取 589,845 字节的 Range 响应后下载了一次整包。[签名回归记录](https://github.com/OhMyJames/Cycle-V1/actions/runs/44705469363/job/136187410159) |
| 签名版 0.3.6 收到公开的 ad hoc 0.3.7           | 窗口提示签名团队不匹配；旧应用和 daemon 继续运行，暂存目录清理完成。[拒绝安装记录](https://github.com/OhMyJames/Cycle-V1/actions/runs/44705021238)                                                                                                                  |
| 签名版 0.3.7 连接远端旧 daemon                 | 通过隔离的真实 SSH 连接 0.2.0，窗口显示工作位置名称、0.2.0 和「Update to 0.3.7」。切换远端二进制并重连 0.3.7 后横幅消失。[运行和截图](https://github.com/OhMyJames/Cycle-V1/actions/runs/44704590908)                                                               |
| 两个不同 Developer ID 团队的 Cycle 包          | 待验。目前只有一个团队的 Cycle 产物。                                                                                                                                                                                                                               |

## 每次全跑

七个套件每次都全跑,不按改动挑选,也不记录历史耗时:全跑一遍约 35 秒,挑选省下的比维护挑选规则的代价小。理由和被否掉的做法见 [决定笔记](../.agents/notes/2026-11-21-integration-runs-every-suite.md)。`bun run test:integration web` 只跑名字里有 web 的。

## 固定等待

2026-11-18 看过一遍现有的等待(`Bun.sleep`、`setTimeout`)。CI 上一次全选(2026-11-18,PR #35 的运行)六个套件合计约 34 秒:adapter 17.4、package 4.3、smoke 5.3、node 2.3、ssh 2.3、backend 2.5;这台开发机上同样跑一遍 adapter 要 42.7 秒。大头是适配器套件(真实 SDK 起进程)。

- **换掉了一个:** 冒烟里按下 Enter 后无条件 `sleep(1500)` 再看一眼页面写日志,现在等"输入框被清空"(消息已发出)这个可观察的事件。同一台机器上交替跑 4 次:原来 7.4~7.8 秒(平均 7.6),现在 5.6~7.0 秒(平均 6.1),约省 1.5 秒。
- **有意留着的:** 适配器取消用例里取消之后放行模型再等 1 秒,是在证明"取消之后什么也不会再到客户端"这个没有事件可等的负面观察窗口;它前面的 8 秒是上限不是等待;其余的 `until`、`waitFor`、50~250 ms 的轮询都有上限,是有界轮询。
- **看到了、没动的:** 客户端的 Node 套件里首个 chunk 之后的 200 ms(给后续更新留的余量),冒烟里点击之后的 80 ms 等页面落定。它们加起来不到半秒,也没有证据说明去掉后稳定,所以没改。

## 为什么不并行

2 核 4 GB 上同时跑两套 Electron 加 Claude 不会更快,还可能因内存被杀。每个套件的时限是为了让挂住的测试在一分钟内失败,而不是等 Bun 默认的几分钟。

## 删测试的原则

一个测试留下,要么它抓到过或会抓到真实的错误,要么它是别处没有的唯一证明。删的是:

- **只是在重述库或常量**:ACP SDK 的方法名常量、zod 的正则、一个只是把字符串放进状态的赋值。
- **在更低一层已经证明、而更高一层只是重复**:例如界面的"空消息不发"(store 的测试已经证明)、daemon 的 e2e 集成(取消和重启恢复已分别由适配器的集成测试和 daemon 的单元测试证明,`backend` 套件又走了一遍整条路径)。
- 在每个集成测试里都会发生的东西:"一个回合能流式输出"。

这次删了 17 个单元测试、1 个集成文件、1 个集成用例(142 个测试到 125 个)。**这不会让门禁变快**(它本来就只有几秒),减少的是要维护的东西。留下的测试里,抓到过真实问题的有:resume 的状态快照被当成历史、`replay_complete` 被去重丢掉、Streamdown 的颜色名没定义、turn 在 prompt 返回前不存在导致取消落空。

## 真实模型

`bun run test:integration` 全程用模拟的 API,不花额度。真实模型的测试要显式开启,凭证显式给:

```bash
CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run --cwd harness/claude test:real          # 适配器层,18 项
CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run --cwd apps/daemon test:real:daemon      # 经过 daemon,中间重启它
```

- token 只放进 Claude 进程的环境,不进适配器自己的环境、不进日志(跑完检查过日志里没有它)。没设 `CYCLE_REAL_MODEL_TOKEN` 时这些测试是跳过的。
- 默认用最小的模型(`CYCLE_REAL_MODEL`,默认 haiku)。断言是松的,因为真实模型不确定;这些测试的价值在它打印的报告,结果记在 [adapters/claude.md](adapters/claude.md)。
- 还有两个只在构建之后才有意义的:`apps/daemon` 下 `test:real`(只用构建出的可执行文件、空环境)和 `apps/desktop` 下 `test:real`(真实窗口加真实模型加构建出的 daemon)。先在根目录 `bun run build`。
- 四个套件加起来约一分钟,花几个很短的回合。**不在 CI 里**:CI 不应该持有账号的 token。

Codex 的两份用一个 Codex 登录文件(`auth.json`),不用 token:

```bash
CYCLE_CODEX_AUTH=<auth.json 的路径> bun run --cwd harness/codex test:real          # 适配器层,6 项,约 2 分钟
CYCLE_CODEX_AUTH=<auth.json 的路径> bun run --cwd apps/daemon test:real:codex      # 经过 daemon,中间重启它
```

- 每条测试把这个文件拷进自己的临时 `CODEX_HOME`(daemon 那份拷进临时数据目录的 `codex/`),只有 Codex 进程读它,给的那份不被写。测试不指向真实的 `~/.codex`。
- ChatGPT 登录的 token 由持有它的 Codex 刷新,刷新会换掉 refresh token:给一份此刻没有别的 Codex 在用的登录,比如 `cycle login codex` 之后的 `<数据目录>/codex/auth.json`。从 `~/.codex` 拷一份临时用可以,只要两边不会同时刷新。
- 用账号的默认模型、`low` 档(`CYCLE_REAL_MODEL` 可换模型)。结果记在 [adapters/codex.md](adapters/codex.md)。

## CI

`.github/workflows/ci.yml`:

- `check`:每个 PR。`bun install --frozen-lockfile --ignore-scripts`,然后 `bun run check`。同一个分支的新提交会取消上一次还在跑的。10 分钟上限。
- `integration`:每个 PR 和手动触发,全部七个套件。装 xvfb 和 Electron 需要的库,下载 Electron 二进制(bun 不跑它的 postinstall),`bun run test:integration --strict --summary`,结果表写进步骤摘要。20 分钟上限。不需要任何密钥:模型是模拟的。

CI 不在 push 到 main 时再跑:main 受 ruleset 保护,只接受 PR 合并,合并前 `check`、`browser`、`integration` 必须通过,合并后再跑一遍是重复。

PR 上两个作业并行:`check` 约 35 秒,`integration` 连安装约 55 秒,其中测试本身约 35 秒(大头是 Claude 适配器套件)。

## 还没做的

- 门禁里的步骤是串行的。类型检查和 lint 加起来约 1 秒,并行没意义;常规测试和界面测试(12 秒、8 秒)并行能省几秒,但 2 核上两个 bun 进程会互相抢,没量过之前不做。
- 集成测试里最慢的仍然是 Claude 的首次启动(每个 session 一次,约 1.5 秒);后续回合在同一个进程里(决策 0007)。
