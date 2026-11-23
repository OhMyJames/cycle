# Agent Note: 审批卡留在输入框上方，一次一个，先给人看要批的内容

Status: accepted
Date: 2026-11-22
Basis: CYCL-123(CYCL-122 对照 old-cycle 的体验差距),2026-11-22 会话；对照 old-cycle(本地 `cycle_v2`)的 `packages/ui/src/content/approval-card.tsx`、`tail.tsx`。

## Problem

审批卡只显示 `工具名: 命令或路径`。批 Edit/Write 时看不到会改成什么，等于盲批。多个请求同时叠在输入框上方。请求在工具运行之前到达，此时还没有结果里的 diff,ACP 请求里只有工具的输入。

## Decision

- 卡片显示要批的内容：Edit/MultiEdit/Write 的改动按行画成 diff(`model/proposal.ts` 从 `old_string`/`new_string`/`edits`/`content` 自己算，行级 LCS,前后各留 3 行，过大时退化为"全删再全加");Bash 原样显示命令，agent 写的用途只作旁注；其他工具显示精简后的输入。
- 一次只显示一个请求(按到达顺序),标题行写"还有 N 个在等"。
- 答完后焦点交给下一张卡的第一个按钮，没有下一张就交给输入框。
- **位置不变：仍在输入框上方，不搬进对话末尾。**

## Alternatives considered

- **按 old-cycle 放到对话末尾、状态行的位置**:读者往上翻的时候卡片不在视野里，而这里是 agent 停下来等人的唯一入口。输入框上方始终可见，⌘↩ 允许的快捷键也围绕它。所以没有跟进。
- **等工具结果里的 diff**:请求时还没有结果，做不到。
- **在 daemon 或适配器里先算好 diff 放进请求**:要改 L1/L2 协议，而 UI 手里已经有输入，没有必要。

## Consequences

- diff 没有文件行号，因为 Edit 只给出文本，不给出位置。
- 只认 Claude 文件工具的字段名；别的 agent 的编辑工具显示输入 JSON。
- 子 agent 发起的请求还标不出来源：适配器的请求里没有子 agent 的标识，留给 CYCL-124。
