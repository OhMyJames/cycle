# Agent Note: 子 agent 的对话转发给客户端，存在父会话的日志里；这一轮不能单独取消

Status: accepted
Date: 2026-11-23
Basis: CYCL-134(负责人 2026-11-23 让做这个 epic)。来源是 CYCL-122 对照 old-cycle 的差距，CYCL-124 先做了不改协议的界面部分。机制取自 `@anthropic-ai/claude-agent-sdk` 0.3.327 的 `sdk.d.ts`(`forwardSubagentText`、`parent_tool_use_id`、`CanUseTool` 的 `agentID`、`Query.stopTask`)和 `@agentclientprotocol/sdk` 2.7.0 的 v2 `SubagentUpdate`。取代[决策 0014](../../docs/decisions/0014-warm-start-and-subagents.md)里"子 agent:只通告，不转发它的对话"那一段；0014 的提前起进程部分不变。

## Problem

0014 只通告子 agent(开始、进度、结束),它的文字、工具调用和结果都丢掉。用户在对话里看不到子 agent 做了什么，审批卡也看不出是哪个子 agent 要的。要转发，就得定四件事：在 L2、L1 上各是什么形状，存在哪，能不能取消，体积有没有上限。

## Decision

- **L2(agent → daemon)按 ACP v2 的子 session 来**:适配先用 `subagent_update` 通告子 agent(和以前一样，子的 id 是 SDK 的 `task_id`),之后子 agent 的更新是 `session/update`,`sessionId` 是子的 id。子 agent 要的审批是 `session/request_permission`,`sessionId` 同样是子的 id。这正是 ACP v2 说的"子 session 的事件自动送达，不用另外订阅"。
- **L1(daemon → 客户端)包在父 session 里**:daemon 把子 agent 的更新改写成父 session 的一条 `_cycle/child_update`,`childId` 是子的 id,`update` 是那条更新。审批仍是父 session 的请求，在 `_meta["cycle/subagentId"]` 里带上子的 id。daemon 只认 `subagent_update` 通告过的子 id;没通告过的 `sessionId` 照旧当作父 session 自己的。
- **只转发对话**:`update` 只允许 `agent_message(_chunk)`、`agent_thought(_chunk)`、`tool_call_update`、`tool_call_content_chunk`,其余(状态、计划、用量、命令等)daemon 丢掉。子 agent 的状态仍然只看 `subagent_update`。
- **存在父会话的 JSONL 里**:每条 `_cycle/child_update` 是父日志里的一条 `update` 记录，有父的 `seq`。回放、断线重连、附件拆分(决策 0013)、凭证过滤(§12,对 `update` 里的工具调用照样做)都沿用父 session 的那一套。不为子 agent 开单独的日志，也不在索引里登记它。
- **Claude 的取法**:打开 SDK 的 `forwardSubagentText`(否则只有工具调用，没有文字)。带 `parent_tool_use_id` 的 `assistant` 和 `user` 消息，按启动它的 Agent 调用找到子的 id,用子 agent 自己的翻译器翻译。审批用 `canUseTool` 的 `toolUseID` 找到调用所在的子 agent,找不到时再用 `agentID`。子 agent 结束(或进程退出)时，它还没结束的调用以 cancelled 结束。后台子 agent 在主 turn 结束后说的话照样转发，不要求有 turn。
- **不能单独取消**:这一轮不声明 ACP 的 `capabilities.cancel`,客户端只能取消整个 turn(和以前一样)。SDK 有 `stopTask(taskId)`,以后要做时在适配里接上，并在 `subagent_update` 里声明 `cancel`。
- **体积**:没有为子 agent 另设上限。子 agent 的文字只转发整条消息，不转发流式的增量(`stream_event`),所以一条回复是一条记录，不是几十条。工具结果的上限和主 agent 一样(比如补丁不超过 `MAX_PATCH`)。一个子 agent 做的事，和主 agent 自己做一样大。

## Alternatives considered

- **L1 也用 ACP 原生的子 `sessionId`**:客户端按 `sessionId` 分派，每个 session 自己记 `seq`。子 agent 的记录在父的日志里，用的是父的序号；要是以子的 id 发出，客户端的"每个 session 最大的 seq"就乱了，重连时要么补发不全，要么重复。旧客户端还会把它当成没附着的 session。包在父 session 里，序号、回放、重连都不用改。
- **不包装，直接在父 session 里发，用 `_meta` 标出来源**:旧客户端不认识这个 `_meta`,会把子 agent 的文字和工具调用画成主 agent 的。0014 丢掉这些消息正是为了避免这一点。新的变体名旧客户端会忽略(§4)。
- **单独的日志文件**:要多一套打开、截断、删除和回放的逻辑，删除会话时也得一起删。子 agent 的对话离开父 session 没有意义，没有理由拆开。
- **流式转发子 agent 的文字**:能一个字一个字地显示，但记录数会多几十倍。子 agent 的对话是展开才看的，整条到达就够了。
- **这一轮就做取消**:SDK 有 `stopTask`,但还要协议、daemon 的路由、界面上的按钮和埋点。先让人看得见，取消另开 issue。

## Consequences

- 旧客户端忽略 `_cycle/child_update`,显示和以前一样；旧日志里没有它，展开子 agent 时只有它的进度。
- 父会话的日志会变大，大致和子 agent 做的事成正比。daemon 的 2 核 4 GB 目标机上，回放一个有很多子 agent 的长会话会更慢；如果成了问题，先考虑只在展开时取子 agent 的记录，再考虑别的。
- 子 agent 的话不算"值得看的记录":它不会让会话变成未读，也不会改会话的状态。
- 嵌套的子 agent(子 agent 又起了子 agent)也会通告和转发；它的 `subagent_update` 带 `parentId`,客户端按它把孙子挂在子 agent 对话里的那个 Agent 调用下。
- **没有用真实模型验证过**:`agentID` 和 `task_id` 是否相同、`forwardSubagentText` 下子 agent 的文字是否只来整条，都是按 SDK 的说明写的。适配先按工具调用找子 agent,不依赖 `agentID`;但 SDK 的审批回调和消息流是两条路，审批可能在适配读到子 agent 发起这次调用的那条消息之前到达，这时只能靠 `agentID`,两者不同的话这张审批卡就说不出是哪个子 agent。要验证，跑 `harness/claude` 的 `test:real`(需要 token)。
