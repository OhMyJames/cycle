# Agent Note: 一个子 agent 可以单独停下，走新的 L1 方法 `_cycle/session/stop_subagent`

Status: accepted
Date: 2026-11-23
Basis: CYCL-143。负责人 2026-11-23 同意按 L1 新方法的方案做("我同意按照 L1 的方案来走")。机制取自 `@anthropic-ai/claude-agent-sdk` 0.3.327 的 `Query.stopTask`(停下一个任务，随后发 `status: "stopped"` 的 `task_notification`)和 `@agentclientprotocol/sdk` 2.7.0 v2 的 `SubagentSessionCapabilities.cancel`。取代[子 agent 对话转发的笔记](2026-11-23-subagent-conversations-are-forwarded.md)里"不能单独取消"那一条，其余不变。

## Problem

子 agent 的对话能看了(CYCL-134),但要停下一个子 agent 只能取消整个 turn。后台子 agent 在 turn 结束后还在跑时，根本没有办法停它。要定的是：客户端怎么说"停这一个",daemon 和 agent 之间怎么说，以及老版本的 daemon 收到时会怎样。

## Decision

- **L1 用一个新方法**:`_cycle/session/stop_subagent {sessionId, childId}` → `{stopping}`。`sessionId` 是父 session。没有可停的(没在跑、agent 没说能停、进程不在)时回 `stopping: false`,不报错：界面上的按钮可能比子 agent 的结束晚一步。daemon 在 `cycle/capabilities.sessionOps` 里列出 `stopSubagent`,客户端只对这样的 daemon 提供停止。
- **L2 按 ACP v2 的子 session**:agent 在 `subagent_update` 里声明 `capabilities.cancel`;daemon 发 `session/cancel`,`sessionId` 是子的 id。daemon 只转给声明了 `cancel`、还在跑的子 agent。
- **结束照常报**:停下的结果是子 agent 自己的 `subagent_update`(`idle`、`cancelled`),daemon 不合成任何记录。没结束的调用由适配以 cancelled 结束(CYCL-134 已有)。
- **Claude**:`session/cancel` 的 `sessionId` 是一个还在跑的子 agent 时调 `stopTask(taskId)`,不碰 turn,不 `interrupt`。
- **界面**:子 agent 卡片下面有 "Stop sub-agent" 按钮，只在子 agent 声明了 `cancel`、还在跑、daemon 支持时出现;按下后写 "Stopping…" 并禁用，直到它的结束到达。埋点 `subagent_stopped {background}`,在主进程里 daemon 接受之后发。

## Alternatives considered

- **`session/cancel` 加 `_meta["cycle/subagentId"]`**(CYCL-143 原来写的):旧 daemon 不认识这个 `_meta`,会照常取消整个 turn,用户想停一个子 agent 却停掉了全部，而且是静默的。新方法在旧 daemon 上只会得到"方法不存在"。
- **L1 也用 ACP 的 `session/cancel`,`sessionId` 填子的 id**:子 agent 在 L1 上不是客户端能打开的 session(见 CYCL-134 的笔记),客户端发给一个不存在的 session,旧 daemon 会回 `-32002`,新 daemon 还得在每个 `session/*` 方法里区分父子。只开一个方法更窄。

## Consequences

- 只停子 agent 本身。它起的后台命令是否跟着停，由 SDK 的 `stopTask` 决定，没有验证过。
- 按钮按下后，若 agent 一直没有报结束(进程卡住),卡片会一直写 "Stopping…";整个 turn 的取消仍然可用。
- **没有用真实模型验证过**:`stopTask` 对前台子 agent 的效果(主 agent 是否收到一个被停下的工具结果并继续)只按 SDK 的说明写。验证用 `harness/claude` 的 `test:real`(需要 token)。
