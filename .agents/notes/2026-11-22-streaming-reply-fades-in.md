# Agent Note: 流式回复的新字逐字淡入，只对从开头看着写的回复

Status: accepted
Date: 2026-11-22
Basis: CYCL-126(CYCL-122 对照 old-cycle 的体验差距),2026-11-22 会话；old-cycle `packages/ui/src/content/markdown.tsx` 的 `animated` 与 `FIRST_BATCH`。

## Problem

流式回复每来一批文字就整块出现在页面上，读起来是跳的。[Markdown 规则笔记](2026-11-22-conversation-markdown-rules.md)当时把 old-cycle 的淡入列为"不适用"，理由是它为重放历史而设；但跳动本身与重放无关。

## Decision

- 用 Streamdown 的 `animated`:按字符淡入(中文没有空格，按词会整句一块),160ms,相邻 6ms,积压不超过 200ms,快模型不被拖慢。
- 只对从开头看着写的回复生效：挂载时正在写且不超过 200 字。会话重开、滚回时重新挂载的回复直接显示，否则已有的全部文字会被当作新字再淡入一次。这个判断在挂载时做一次，回复的一生里 `animated` 不变，结束时不重画块。
- 回复结束后 `isAnimating` 再保持 400ms,让最后一批字淡完。
- 样式用 Streamdown 自带的(`app.css` 已导入 `streamdown/styles.css`),不另写；减少动态效果时由全局规则关掉。
- 详细模式下正在写的思考走同一个组件，也淡入。

## Alternatives considered

- **按词淡入**:中文整句是一个"词",等于没有淡入。
- **由会话视图判断"是否在挂载后才出现"并传下来**:比 200 字的估计准(短回复重开也不会淡入),但要在会话视图里记住首屏已有的条目；先用估计，误判的代价只是一次多余的淡入或少一次淡入。

## Consequences

- 流式期间正文的每个字符是一个带内联样式的 span,很长的回复会多出上万个节点，结束时整块重画一次去掉它们。
- Streamdown 按码点而不是字素切分：组合字符、ZWJ 表情在流式时可能分开淡入，结束后正常。
- 不适用于工具输出、子 agent 预览等非流式内容。

## Related

- 部分取代 [会话里 agent 的 Markdown](2026-11-22-conversation-markdown-rules.md) 的 Consequences 中"不适用"一条里的淡入；该笔记其余内容不变。
