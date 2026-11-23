# Agent Note: 终端的 PTY 在 daemon 里，经 L1 的 `_cycle/terminal/*` 传，跟着 session 走，只给人用

Status: accepted
Date: 2026-11-22
Basis: CYCL-96。负责人 2026-11-22 的回答：终端跟 session 走；v1 只给人用，agent 不碰；终端不拖住 daemon 的空闲退出。探针同日在 macOS arm64、Bun 1.4.4 上跑过（直接运行和 `bun build --compile` 后各一次）。参考 old-cycle 的笔记 `.agents/notes/2026-11-09-terminals-in-the-daemon.md`。

## Problem

[范围笔记](2026-11-19-desktop-terminal-scope.md)把用户操作的终端放进了 v1，但没定四件事：PTY 在哪一端、走哪条通道、断线后怎么办、环境和资源的边界。终端让能连上 daemon 的客户端直接在 daemon 所在的机器上执行命令，所以这几件事都和红线有关。

## Decision

- **PTY 在 daemon 里**：用 Bun 自带的 `Bun.spawn({ terminal })`，不用 node-pty 或额外的 helper 进程。探针确认了以下几点：
  - 拿到的是真 tty，shell 有自己的进程组；
  - `resize` 生效（`stty size` 从 30×100 变成 40×120）；
  - Ctrl-C 只打断前台命令，shell 本身不受影响；
  - 退出码能正确拿到；
  - 子进程的环境变量和传入的完全一致；
  - 编译成单文件后照样可用。
- **通道走 L1**：在现有连接上加 `_cycle/terminal/*`，能力开关是 `cycle/capabilities.terminal: true`。具体方法和字段由 CYCL-97 先写进 `docs/protocol.md` 再实现，大致是：建、列、附着（拿快照）、输入、改尺寸、关，以及输出和退出两种通知。本地和 ssh 走同一条路，不另开通道。
- **跟着 session 走**：
  - 一个终端属于一个 session，工作目录是 session 的 `cwd`，打开时这个目录必须存在；
  - session 被归档或删除时，它的终端关掉；
  - daemon 停止时，所有终端关掉：先给整个进程组发 SIGHUP，等一小段时间还没退出的再发 SIGKILL。
- **v1 只给人用**：
  - 不开 ACP 的 `terminal/*` 客户端能力，也不给 agent 提供终端的 MCP 工具；
  - agent 看不到终端的存在、输入和输出；
  - 以后要让 agent 用终端，另写一条笔记（old-cycle 的做法可以参考）。
- **环境变量不继承 daemon 的**：
  - 只从 daemon 自己的环境里取白名单上的变量：`HOME`、`USER`、`LOGNAME`、`SHELL`、`PATH`、`LANG`、`LC_*`、`TMPDIR`；
  - 固定设 `TERM=xterm-256color`、`COLORTERM=truecolor`；
  - 白名单写在 daemon 的配置里（`terminal.allowEnv`），和 `claude.allowEnv` 分开，不能通过协议改；
  - 不传的：`ANTHROPIC_*`、`CLAUDE_*`、`CYCLE_*`、PostHog 的 key、`claude.env` 里配的任何值，以及 `SSH_AUTH_SOCK`（它属于某一次 ssh 连接，而 daemon 活得比连接长）；
  - shell 取 `SHELL`：是绝对路径且可执行时用它，否则用 `/bin/sh`。以登录 shell（`-l`）启动，用户自己的 rc 文件照常生效，PATH 由它重建。
- **屏幕留在 daemon 里**：
  - 每个终端有一个 `@xterm/headless`（6.0.0），配 `@xterm/addon-serialize`（0.14.0），保留 5000 行回滚；
  - 客户端附着时先拿到序列化后的屏幕和当时的尺寸，再接着收之后的输出，保证不漏、不重；
  - 探针：编译成单文件后可用，输出 20 万行后快照约 40 KB，进程 RSS 约 40 MB。
- **流量控制**：
  - 输出按终端合并后再发，大约每 16 ms 或攒满 64 KiB 发一次；
  - 某个连接上一个终端没发出去的数据超过上限（初定 1 MiB）时，这个连接暂停接收它的输出；等写缓冲排空，补发一份快照让它追上；
  - 无界面屏幕始终在解析输出，解析跟不上时丢弃并标出缺口，不让内存涨上去。
- **多个客户端**：都能看到输出，都能输入；尺寸以最近一次 `resize` 为准，客户端在附着和获得焦点时发一次。
- **上限**：每个 session 8 个终端，每个 daemon 32 个，单次输入不超过 64 KiB。数值放在配置里，CYCL-97 实测内存后再定默认值（目标机器是 2 核 4 GB）。
- **不拖住空闲退出**：终端不计入 `Daemon.activity()` 和 `idleSince()`。没有客户端、也没有工作满 `idle.exitMinutes` 后 daemon 退出，终端随之关闭，界面要说明终端是因为 daemon 停了而结束的。
- **不需要信任文件夹**：终端由用户主动打开，跑的是用户自己的 shell 和配置，不像 hooks 那样执行项目里的命令。
- **埋点**：只报打开、关闭、关闭原因（一组固定的词）和个数（分档）。不报命令、输入输出、路径、shell 名或环境变量的值。

## Alternatives considered

- **另开一条 ssh 通道给终端**：没采用。本地连接还得另做一套；终端会脱离 session 和 daemon 的生命周期，重连也要单独处理；而且把终端绑死在 ssh 上，违背"协议与传输分离"，也给以后的云端 sandbox 堵了路。走 L1 不新增权限：能连上 daemon 的人本来就能让 agent 执行命令。
- **PTY 放在桌面应用里**：没采用。终端要跑在 session 所在的机器上，远程时还是得过 ssh；应用一关终端就没了，别的客户端也附着不上。
- **node-pty**：不需要。Bun 自带的 PTY 够用，原生模块会让单文件打包变复杂。
- **附着时重放原始输出**：没采用。old-cycle 试过，截断后的缓冲会丢掉全屏模式这类状态，导致屏幕画错。
- **tmux 后端，让终端比 daemon 活得长**：没采用。要额外装一个外部程序，而且和空闲退出冲突，承诺不了终端长期保留。
- **按文件夹共享终端**：负责人选了跟 session 走（2026-11-22）。
- **agent 也能用终端**（old-cycle 的 MCP 工具，能敲进用户的终端）：负责人选了 v1 只给人用（2026-11-22）。
- **终端拖住空闲退出**，不论只在有前台任务时还是只要终端开着：负责人选了不拖住（2026-11-22）。

## Consequences

- 没有客户端连着 30 分钟后，终端里的 dev server 或长任务会随 daemon 一起结束。需要跑得更久的，用户自己用 `nohup` 或 tmux。
- Linux：`test/terminal-method.test.ts` 用真实的 `/bin/sh` 和 PTY，在门禁里跑，所以 CI 的 Ubuntu 上每次都会跑（CYCL-97）。
- 每个终端的内存，CYCL-97 实测（2026-11-22，macOS arm64，10 个终端各输出 3000 行）：daemon 这边每个约 7 MB，shell 进程（zsh 或 bash）每个 2–3 MB。默认上限 32 个，最坏情况约 320 MB，比一个 Claude 进程（约 230 MB）多一些，默认值不改。
- 在 Bun 里，PTY 的读取没法暂停，所以流量控制只能靠"无界面屏幕持续解析、连接落后就改发快照"，而不是对 shell 施加反压。

## Related

- [范围笔记](2026-11-19-desktop-terminal-scope.md)里说要由 CYCL-96 补充的内容（PTY 所在端、环境白名单、断线后是否保留、资源上限）都在本笔记里，范围笔记本身仍然有效。
- 实现：CYCL-97（协议和 daemon）、CYCL-98（桌面端面板）。
