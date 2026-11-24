# cycle-v1

一个 ADE(agentic development environment)。cycle 的重写版:协议先行,更小、更容易维护和改造。

> 状态:v1 可用。桌面应用(macOS,Apple 芯片)加 Linux daemon,已接入 Claude、Codex、agy 三个 agent。应用会自动更新自己,也能在应用里升级远端的 Linux x64 或 ARM64 daemon,图标已有。从 0.3.16 起,发布的 macOS 包有 Developer ID 签名并经过公证。使用见 [docs/getting-started.md](docs/getting-started.md)。

## 目标(v1)

先把协议定下来,并以 Claude agent 作为最小接入单元,跑通三项核心能力:

1. 连接远程 daemon(通过 SSH 隧道)
2. 完整展示 session 的会话,并支持交互
3. 配置 Claude agent

## 技术栈

Bun、TypeScript、Electron,均使用最新版本。

## 架构概览

```
Desktop(Electron) ──L1: Cycle 协议──▶ Daemon ──L2: ACP──▶ Agent 适配进程(Claude)
```

- **L1** 客户端到 daemon:以 ACP v2 为蓝本加 `_cycle/*` 扩展,类型自己定义并固定,要稳定。
- **L2** daemon 到 agent:以 ACP v2(Agent Client Protocol)为标准。L1 的消息模型也以它为蓝本,类型由我们固定版本。
- **L3** agent 适配:每个 agent 自带适配进程和 manifest;Claude 的适配自己写,基于 Claude Agent SDK。

详见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
bun install      # 安装依赖,并启用 pre-commit 钩子
bun run check    # 边界、类型、lint、测试
```

`apps/daemon`(daemon,可编译成单文件)、`apps/desktop`(Electron 应用)、`harness/*`(agent 适配,当前为 Claude)、`packages/*`(协议、客户端与传输、埋点、界面)。门禁约 7 秒;集成测试(`bun run test:integration`)启动真实进程;`bun run build` 构建 daemon 和桌面端（macOS 需安装 Xcode Command Line Tools 来编译输入法粘贴处理模块）,`bun run start` 启动。详见 [docs/testing.md](docs/testing.md)。

## v1 桌面端规划

右侧面板、diff 视图、交互式终端、内置浏览器及 agent 操作浏览器（browser use）、插件（plugins）和设置页（settings）已纳入 v1 规划。已发布功能见[使用指南](docs/getting-started.md)。

git worktree 和独立 Web 端仍在 v1 范围外。多个 agent 已在范围内：Claude 之外，Codex、agy、pi 正在接入（调研见 `docs/adapters/`）。

## 文档

- [docs/getting-started.md](docs/getting-started.md):安装和使用(从这里开始)
- [docs/architecture.md](docs/architecture.md):架构与分层
- [docs/protocol.md](docs/protocol.md):协议规范(草稿)
- [docs/desktop.md](docs/desktop.md):桌面客户端:构建、结构、安全设置、已知缺口
- [docs/analytics.md](docs/analytics.md):产品埋点:规则、事件字典、怎么给新功能加埋点
- [docs/daemon.md](docs/daemon.md):daemon:做了什么、没做什么、验证结果
- [docs/adapters/claude.md](docs/adapters/claude.md):Claude 适配:做了什么、没做什么、验证结果
- [docs/decisions/](docs/decisions/):设计决策记录

## 致谢

Cycle v2 设计语言（字体排版、硬件微高光材质与安全橙点缀）及部分交互形态（实时状态行、展开选择器）的视觉设计受到 [Rare UI](https://www.rareui.com/) 的启发，上下文进度环的弹簧动效受到 [Fluid UI](https://fluidui.willradoux.com/) 的启发，组件代码均为 Cycle 独立实现。
