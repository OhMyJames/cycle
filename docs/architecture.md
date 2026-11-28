# 架构

状态:草稿

## 分层

```
Desktop(Electron) ──L1──▶ Daemon ──L2(ACP)──▶ Agent 适配进程
   renderer ⇄ main   (SSH 隧道)   会话 / 事件日志     stdio 子进程
```

### L1:客户端到 daemon

- 基于 JSON-RPC 2.0,与传输分离。消息模型以 ACP v2 为蓝本,字段和语义保持一致。ACP 的类型来自固定版本的 `@agentclientprotocol/sdk/experimental/v2`(精确版本固定在根 `package.json` 的 `workspaces.catalog`,门禁禁止导入 `unstable` 或其他入口,见 [决定笔记](../.agents/notes/2026-11-19-workspace-layout-and-direct-acp-sdk.md) 与历史 [决策 0005](decisions/0005-acp-v2.md)),Cycle 的扩展用 zod 定义在 `@cycle/protocol`。daemon 转发 agent 的消息并补充 Cycle 自己的能力,Cycle 的扩展放在 `_cycle/*` 方法和 `_meta` 里,不重复定义 ACP 已有的概念。
- daemon 长驻,支持多个客户端观察同一个 session;客户端断线后 session 继续运行。
- **daemon 自己保存会话历史**(见 [决策 0002](decisions/0002-session-persistence.md)):JSONL,每个 session 一个文件,只追加,每条事件带单调递增的 `seq`。历史不依赖 agent 重放,因为云端 sandbox 销毁后 agent 侧的历史会丢。重连时按 `since=seq` 补发,或先取快照再接增量。
- 会话内容沿用 ACP v2 的 item 模型:消息、tool call 等按稳定 id 打补丁。
- daemon 只管理 Cycle 自己创建的 session(见 [决策 0006](decisions/0006-own-sessions.md))。
- 管理类方法(`_cycle/*`):session 列表和创建、归档与删除、agent 配置的读写、能力与版本协商。
- **MCP 是 daemon 的公共能力,不是某个 agent 的**(protocol.md §14):connector 的清单、凭证和 OAuth 都在 daemon,并且各自放在接口后面,以后可以换成 cloud 的实现;agent 只在 L2 的 `mcpServers` 里看到 daemon 网关的 loopback 地址,拿不到上游的 token。理由见决定笔记 [2026-11-19-connectors-behind-a-daemon-gateway](../.agents/notes/2026-11-19-connectors-behind-a-daemon-gateway.md)。

### L2:daemon 到 agent

- 以 **ACP v2** 为主要参考(见 [决策 0005](decisions/0005-acp-v2.md))。daemon 充当 ACP client。
- v2 的关键特性正好是我们需要的:`session/update` 可在会话任意时刻到达,消息、tool call 按稳定 id 打补丁,agent 可报告空闲,支持多个客户端观察同一个 session。
- v2 仍是草案(alpha),所以 `@agentclientprotocol/sdk` 在根 `package.json` 的 `workspaces.catalog` 一处固定精确版本,并由 `scripts/check.ts` 限制只用 `experimental/v2` 入口。
- **传输不绑定 stdio。** L2 抽象为一个双向消息通道:v1 实现 stdio 子进程,后续可加 WebSocket 等,用于云端 sandbox。
- v1 不使用 `fs/*`、`terminal/*` 等 client 能力。以后这些能力必须在 agent 所在的环境里执行,而不是在 daemon 的机器上。

### L3:agent 适配

- 不使用官方 `claude-agent-acp`,自己写 Claude 适配(见 [决策 0001](decisions/0001-claude-acp-adapter.md)),基于 Claude Agent SDK,对外说 ACP v2。
- 每个 agent = 一个说 ACP 的适配进程 + `apps/daemon/src/harnesses.ts` 里 `HARNESSES` 清单的一项(`Harness`:id、名字、启动适配的方式、随 daemon 发的二进制、命令行和环境)。加一个 agent 的步骤见 [daemon.md](daemon.md)。
- agent 的可配置项以 schema 的形式经协议(`_cycle/agent_setup/*`)给到客户端。
- 客户端按 schema 渲染配置界面,不需要认识具体 agent。
- 适配进程是**自包含**的:所有配置(模型、权限模式、MCP、环境变量、凭证)都通过协议或显式参数传入,不隐式读取宿主机的用户目录。适配进程运行在 workspace 所在的位置,本机、远程机器或云端 sandbox 都是同一种形态。

## 远程连接

- 用系统 `ssh`,复用 `~/.ssh/config`、密钥和 known_hosts。
- daemon 在远端长驻,只监听 unix socket 或 loopback。
- 方式:`ssh host cycle proxy`,把 stdio 桥接到 daemon 的 unix socket(不用 `ssh -L` 转发)。
- 本地模式是同一个 daemon 加本地 socket,只有一条代码路径。

## 仓库结构

```
packages/protocol          Cycle 对 ACP 的扩展:_cycle/* 方法、_meta 键、错误码(zod)
packages/client            纯 Node 客户端 CycleClient + 客户端传输(unix socket、stdio、ssh)
packages/analytics         产品分析事件字典(zod)与 PostHog 客户端
packages/ui                前端纯会话模型、Store、React UI、Gallery
packages/command-permissions  Codex 和 agy 的会话命令审批前缀规则（纯函数）
packages/line-rpc          按行的 JSON-RPC 子进程通道,Codex 的 app-server 和 agy 的 ACP 都走它
packages/model-gateway     模型 provider 网关(基于 pi-ai),让 agent 用其他 provider 的模型
packages/oidc              桌面端账号登录(OIDC)
packages/clawdot-plugins   随 daemon 发的内置插件
harness/claude             Claude 适配进程(基于 Claude Agent SDK)
harness/codex              Codex 适配(驱动 Codex CLI 的 app-server)
harness/agy                agy 适配
apps/daemon                完整 daemon:会话管理、事件日志(JSONL)、服务端传输、serve 和 proxy
apps/desktop               Electron(main:ssh 与 daemon 连接;renderer:UI)
cloud/loop                 自动化闭环服务(从工单到合并的 PR),桌面端经它的 unix socket 读取(protocol.md §17)
docs/
```

## v1 桌面端范围

范围以 [README 的桌面端规划](../README.md#v1-桌面端规划)为准。桌面交互式终端供用户操作，与 L2 中 agent 请求的 ACP `terminal/*` 能力分开设计。
