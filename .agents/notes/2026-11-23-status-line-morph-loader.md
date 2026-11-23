# Agent Note: 对话末尾的状态行用移植来的 MorphLoader，工具在跑时让位给工具行

Status: accepted
Date: 2026-11-23
Basis: CYCL-215。负责人决定这一项整个移植 Cycle v2 的 `packages/ui/src/loader/`（MorphLoader），不做简化版；计时改为整轮一个总数，单个工具的用时只在工具行上。

## Problem

StepLine 原来是普通转圈加脉动图标，文字另有 2.2 秒的呼吸动画；工具在跑时它也显示，和工具行各有一个"在跑"和一个计时；计时按步骤记（`startedAt(session:stepKey)`），每换一步从 0 开始；行高是最小高度，内容一换就跳。

## Decision

- 移植 v2 的整个 loader 目录到 `packages/ui/src/react/loader/`，从 `./loader/index.ts` 导出 `MorphLoader`（`state`: `thinking` / `searching` / `executing` / `responding` / `waiting` / `done`）、`loaderStateOfKind`、`HOLD_MS`。这是 AGENTS.md"不拷贝旧 cycle 的代码"的一个例外，由负责人明确决定：loader 是品牌的动画，场景数据原样保留。每个文件头注明出处。
- 和 v2 不同的一处：减少动效时 loader 完全静止（每个状态画它的静止姿态，换状态直接切换），v2 是继续动。理由是 DESIGN.md §2.3 规定减少动效下全部静止。
- 工具在跑时状态行安静：保持 28px 行高，不画 loader、不画计时，只给读屏留一句文字。对话里同时只有一个"在跑"的信号和一个计时（工具行或工作卡那一行）。合起来的工作卡这一行也写正在跑的那次调用的用时。
- 状态行的计时是整轮的，按 `session:turn:N` 记，审批、工具、重新挂载都不重新开始。
- 状态行在整轮里都在（包括 agent 正在写回复时，写 `Writing…`），行高固定 28px，轮结束才消失。
- 进入和换字都用同一拍淡入（`--cycle-motion-enter`），离开立即；去掉文字的呼吸动画和图标的交叉淡化。

## Alternatives considered

- **按 v1 自己的规则重画一个简化 loader**：负责人否决，要求整个移植。
- **工具在跑时状态行继续写工具名和计时**：会和工具行重复，两个"在跑"、两个计时，且计时不一致。
- **减少动效时照 v2 继续动**：与本项目的动效规则冲突。

## Consequences

- loader 的代码是移植来的，改动时以 v2 的行为为参照；CYCL-217 的子 agent 卡片会复用它。
- 写回复时状态行不再消失，DESIGN.md 4.4 里"未开始输出文本时"的说法已改。
- 浏览器里无法同时运行 v1 和 v2 对照，行为对齐靠读代码。
