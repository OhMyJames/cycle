# Agent Note: 会话的展示模式是客户端按会话保存的视图设置，不进 agent 的配置

Status: accepted
Date: 2026-11-22
Basis: 2026-11-22 用户要求：思考的显示不该是 Settings → Appearance 里的全局开关，应放进会话配置，叫"展示模式"（详细 / 普通）；普通完全不显示思考，详细直接显示思考内容

## Problem

原来的 "Expand thinking" 是整台机器一个开关，而且只决定思考行默认展开还是收起，思考行本身总在。用户要的是按会话选择看不看思考过程。会话设置对话框里现有的项都来自 agent 的 `configSchema`，经 daemon 用 `session/set_config_option` 发给 agent，所以要决定展示模式存在哪里。

## Decision

展示模式（`normal` / `detailed`，默认 `normal`）是页面自己的视图设置，按会话的 view key（`环境:会话`）存在页面的 localStorage（`cycle-display-mode`，只存非默认的会话），代码在 `packages/ui/src/display-mode.ts`。会话设置对话框在 agent 的设置之后单独画这一项，环境没连上也能改，改了立刻生效。普通模式下对话不画思考块，turn 末尾的 step 行说"思考中…"；详细模式下思考直接以 markdown 引用的样式、斜体、次要文字颜色显示。旧的 `cycle-show-thinking` 键不再读取。

## Alternatives considered

- 加进 Claude 的 `configSchema`：它会被当成 agent 的配置发给 agent，agent 不认识会拒绝，而这本来就与 agent 无关；协议也要求客户端不认识具体 agent。
- 作为 Cycle 自己的会话配置存在 daemon（新的 `_cycle/*` 字段）：能跨机器同步，但要改协议和 daemon 存储，只为一个显示偏好不值得；以后确实需要跨客户端同步再做。

## Consequences

换一台电脑打开同一个会话，展示模式回到普通。删除会话不会清掉它在 localStorage 里的项（很小，可接受）。埋点 `thought_expanded`、`thinking_expand_changed` 去掉，改为 `display_mode_changed {mode}`。
