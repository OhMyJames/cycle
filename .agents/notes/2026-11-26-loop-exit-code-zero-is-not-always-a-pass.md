# Agent Note: 验收的裁判仍是退回码,但"一个测试都没通过"的退回码 0 判失败

Status: accepted
Date: 2026-11-26
Basis: CYC-425(守卫和 `UI_CRITERIA_GUIDE` 的实现)、CYC-452(本笔记所在工单);代码在 `cloud/loop/`(`src/preflight.ts`)。

## Problem

[Loop 的决定笔记](2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary.md)写了"边界由代码强制"和"验收看命令的退回码",没写"退回码 0 也可能是没跑"。界面现象的测试依赖 Chromium、打包产物或 token,环境里没有就会整个跳过,而 `bun test` 跳过全部测试时退回码仍是 0。一个什么都没验证的命令就这样让验收通过了。

## Decision

- 验收的裁判仍是命令的退回码,不让会话或工单作者的话改变它。在此之上加两条守卫:
  - `bun test <路径>`:Loop 读汇总行,通过数为 0(全部跳过)或读不出汇总行,判未通过;有通过也有跳过算通过。
  - `bun run test:integration <套件>`:Loop 运行时补 `--strict`,套件被跳过(没 build、没 Chromium)判失败。工单里不要自己写 `--strict`。
- 不新增验证命令。界面现象用现有的三种写法:整页流程 `bun run test:integration web`、组件 `bun run test:browser`、其他测试文件 `bun test ./路径`(可带 `./`,不能以 `/` 开头、不含 `..`、不带 `--` 选项)。措辞以 `UI_CRITERIA_GUIDE` 为准。
- 不放开 `test:real` 系列。没有 token 时它整个跳过、退回码是 0,不能当验收;放开它还要把 token 交给验证命令,违反"验证命令不带 token"的边界。

## Alternatives considered

- 新增一条专门的"界面验收"命令:拒绝。允许清单每多一种形式,就多一份要维护和审查的执行面;现有三种写法已覆盖。
- 放开 `test:real`:拒绝,理由见上。真实模型的运行只由人在合并后验收。
- 只在文档里要求写法正确、不加守卫:拒绝。写错时没有人在场,Loop 会把没跑的命令当成通过。

## Consequences

写工单的人和 agent 不读代码就能写出可用的界面验收。没 build 或没 Chromium 的机器上,界面验收会判失败而不是静默通过,需要先准备环境。守卫只认 `bun test` 和 `test:integration` 的汇总输出格式,格式变了要同步改。
