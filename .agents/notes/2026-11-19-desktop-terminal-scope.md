# Agent Note: v1 允许用户在桌面端操作交互式终端

Status: accepted
Date: 2026-11-19
Basis: 2026-11-19 的 CYCL-51 放开桌面终端；CYCL-96 负责通道、PTY 与安全边界的调研。

## Problem

旧范围排除了桌面交互式终端。放开后，需要明确由用户操作的 shell 与 agent 的命令执行权限之间的关系。

## Decision

用户操作的终端纳入 v1；这项范围决定不启用 ACP 的 `terminal/*` 客户端能力。终端设计须满足[仓库红线](../../AGENTS.md)：

- daemon 只监听 loopback 或 Unix socket。终端的远程访问须保留这一限制。
- 终端中的账号或 SSO token 不得通过输入、输出或启动参数转交给 agent。
- agent 环境仍按显式白名单构造，不能从 shell 或 daemon 继承。PTY 自身需要哪些变量由 CYCL-96 评估。
- 埋点只记录终端操作的行为，不采集命令、输入输出、工作目录或环境变量值。

## Alternatives considered

CYCL-96 将比较复用 L1 与另开 SSH 通道，并评估 Bun 或 helper 提供 PTY 的可行性。范围决定没有选定通道和 PTY 实现。

## Consequences

CYCL-96 的结论（PTY 所在端、通道、环境白名单、断线后是否保留终端及资源上限）记在 [2026-11-22-terminals-in-the-daemon-over-l1](2026-11-22-terminals-in-the-daemon-over-l1.md)。CYCL-97 按它实现。
