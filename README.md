# cycle-v1

一个 ADE(agentic development environment)。cycle 的重写版:协议先行,更小、更容易维护和改造。

> 状态:v1 可用。桌面应用(macOS,Apple 芯片)加 Linux daemon,已接入 Claude、Codex、agy 三个 agent。应用会自动更新自己,也能在应用里升级远端的 Linux x64 或 ARM64 daemon,图标已有。从 0.3.16 起,发布的 macOS 包有 Developer ID 签名并经过公证。使用见 [docs/getting-started.md](docs/getting-started.md)。

## 目标(v1)

先把协议定下来,跑通三项核心能力:

1. 连接远程 daemon(通过 SSH 隧道)
2. 完整展示 session 的会话,并支持交互
3. 配置 agent(Claude、Codex、agy)

## 技术栈

Bun、TypeScript、Electron,均使用最新版本。

## 架构概览

```
Desktop(Electron) ──L1: Cycle 协议──▶ Daemon ──L2: ACP──▶ Agent 适配进程(Claude、Codex、agy)
```

三层:L1 客户端到 daemon 是 Cycle 自己的稳定协议(以 ACP v2 为蓝本加 `_cycle/*`),L2 daemon 到 agent 用 ACP v2,L3 是每个 agent 的适配。分层的理由和约束见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
bun install      # 安装依赖,并启用 pre-commit 钩子
bun run check    # 边界、类型、lint、测试
```

`apps/daemon`(daemon,可编译成单文件)、`apps/desktop`(Electron 应用)、`harness/*`(agent 适配:Claude、Codex、agy)、`packages/*`(协议、客户端与传输、埋点、界面等)、`cloud/loop`(自动化闭环服务)。门禁约 16 秒;集成测试(`bun run test:integration`)启动真实进程;`bun run build` 构建 daemon 和桌面端（macOS 需安装 Xcode Command Line Tools 来编译输入法粘贴处理模块）,`bun run start` 启动。详见 [docs/testing.md](docs/testing.md)。

## v1 桌面端规划

右侧面板、diff 视图、交互式终端、内置浏览器及 agent 操作浏览器（browser use）、插件（plugins）和设置页（settings）已纳入 v1 规划。已发布功能见[使用指南](docs/getting-started.md)。

独立 Web 端仍在 v1 范围外;git worktree 由 daemon 管(CYC-273)。多个 agent 已在范围内：Claude、Codex、agy 已接入,pi 在接入中(CYCL-154,调研见 `docs/adapters/pi.md`)。

## 文档

- [docs/getting-started.md](docs/getting-started.md):安装和使用(从这里开始)
- [docs/architecture.md](docs/architecture.md):架构与分层
- [docs/protocol.md](docs/protocol.md):协议规范(草稿)
- [docs/desktop.md](docs/desktop.md):桌面客户端:构建、结构、安全设置、已知缺口
- [docs/analytics.md](docs/analytics.md):产品埋点:规则、事件字典、怎么给新功能加埋点
- [docs/daemon.md](docs/daemon.md):daemon:做了什么、没做什么、验证结果
- [docs/testing.md](docs/testing.md):门禁、集成测试、真实模型的运行
- [docs/conversation-content.md](docs/conversation-content.md):对话内容怎么展示
- [docs/harness-settings.md](docs/harness-settings.md):agent 设置页
- [docs/adapters/](docs/adapters/):各 agent 适配([Claude](docs/adapters/claude.md)、[Codex](docs/adapters/codex.md)、[agy](docs/adapters/agy.md)、[pi](docs/adapters/pi.md) 调研)
- [docs/decisions/](docs/decisions/):设计决策记录

## 致谢

Cycle v2 设计语言（字体排版、硬件微高光材质与安全橙点缀）及部分交互形态（实时状态行、展开选择器）的视觉设计受到 [Rare UI](https://www.rareui.com/) 的启发，上下文进度环的弹簧动效受到 [Fluid UI](https://fluidui.willradoux.com/) 的启发，组件代码均为 Cycle 独立实现。
