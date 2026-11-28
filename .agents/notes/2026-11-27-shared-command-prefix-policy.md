# Agent Note: Codex 与 agy 共用命令前缀规则

Status: accepted
Date: 2026-11-27
Basis: 本次架构治理；基线 95bb58db 的 harness/codex/src/prefixes.ts 明确要求复制 agy 的规则并同步维护，两组规则测试相同。

## Problem

适配器之间需要保持独立，但两个适配器把同一个用户选择解释为会话内可记住的命令前缀。单独修改其中一份，会使同一操作的审批范围随适配器而变。

## Decision

共享的纯函数由无运行时依赖的 `@cycle/command-permissions` 持有。每个适配器自己处理原生审批请求，决定何时调用这个函数，并在自己的会话里保存用户的选择。

## Alternatives considered

保留两份代码需要贡献者记得跨包同步。让一个适配器依赖另一个，会把后者的发布和测试边界引入前者。将规则放进 line-rpc 或 protocol 会给传输或数据契约增加审批策略职责。

## Consequences

规则修改有一个位置和一套规则测试。两个适配器保留独立集成测试，以覆盖允许一次、会话内记住、拒绝以及各自的请求类型。此决定沿用原有匹配语义，审批范围的产品变更需要单独审查。
