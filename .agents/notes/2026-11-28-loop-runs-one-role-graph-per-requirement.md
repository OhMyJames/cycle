# Agent Note: Loop 为每个需求跑一张多角色的流程图，由事件创建或唤醒

Status: accepted
Date: 2026-11-28
Basis: 2026-11-28 与用户的架构讨论(Codex 会话 `01a22076-bd19-78f0-8b6c-c3a736282dd2`,以及随后的对齐:用户确认"流程图取代工单内部那张只有 Dev 的图，一个需求跑一张图，图里节点可以是任何角色")。对照的现状代码:`cloud/loop/src/graph.ts`、`cloud/loop/src/flows/dev/index.ts`、`cloud/loop/src/flows/dev/review.ts`、`cloud/loop/src/flows/dev/ci.ts`、`cloud/loop/src/flows/research/`、`cloud/loop/src/engine/flow.ts`。

## Problem

[CYC-507 的决定](2026-11-26-loop-work-item-and-task-graph-boundary.md)把二级图限定为 Loop 自有的 Dev 执行节点：一个一级工单内，Dev 节点按拓扑顺序跑，之后由开发流程的固定阶段做整单验证、QA、推送、CI、PR 评审和返工。调研是另一条独立的流程。工作只由轮询 Todo 列启动。

由此产生几个问题:

- 每加一种角色或交接(QA、评审、调研)，都要在开发流程里再写死一个阶段。
- PR 评审和"评审拒绝后怎么办"绑在一起(`review()` 拿到 reject 后直接安排修复节点)，没法单独审一个不属于 Loop 工单的 PR。
- 等待外部结果(例如 CI)发生在步骤内部的轮询里，等待期间一直占着 worker。
- 外部变化(PR 打开、CI 完成)无法直接推动工作。

## Decision

**一个需求(一级工单)跑一张流程图，图里的节点可以是任何角色。** 这张图取代 CYC-507 中"二级节点只有 Dev、QA 与评审是固定阶段"的那部分。

1. **原子任务 = 一个 Agent session。** 图里每个节点是一个原子任务，声明目标、输入、预期产物、验收条件和所需角色(Dev、QA、Reviewer、Research……)。角色映射到配置好 skills 和 MCP 的 Agent。节点的一次执行开一个独立 session。
2. **session 内部归 skill,session 之间归图。** Agent 在同一 session 内反复查证、修改、自测，属于节点内部。Dev 的自测是开发节点的完成条件：由 Loop 运行验证命令、按退出码判断(沿用[无人值守边界](2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary.md))，失败时反馈给当前 Dev session 继续修，通过后才交付 commit。
3. **"完成"和"通过"分开记录。** QA 完整地测出缺陷、Reviewer 有依据地要求修改，都算节点已完成、结论为未通过。由图根据结论安排新的返工节点，不在原节点内重试。流程定义里每种步骤只定义一次(例如只有一个"QA 验收"),运行历史只追加：`开发① → QA① → 修复① → QA②`,每份结论绑定它验过的版本。
4. **调研有两种用法。** 调研可以是功能需求图里的一个节点，也可以是一个独立的业务需求：这时它的图只有一个调研节点。现有调研流程归入这种单节点图。
5. **事件创建或唤醒工作。** 工单变化、PR 变化、CI 结果、节点交付都是事件。流程声明哪些事件可以新建流程实例、哪些可以唤醒已在等待的实例，以及按什么业务标识找到同一个实例。唤醒只表示"可以重新检查"，动作前一律从源头重新读取状态。独立的 PR 审阅也是一个流程实例(只有一个 Reviewer 节点),不允许事件绕过流程直接产生任务。轮询保留，作为漏掉事件时的补查。
6. **Loop 只做确定性的事。** 收事件、保存状态、等待条件、开 PR、读 CI、派活都由 Loop 运行时完成，等待期间不占 Agent session,也不占 worker。需要判断时才调用某个角色。
7. **核心对象只有四个：流程定义、流程实例、任务节点、Agent session。** 事件挂在流程实例上(多对多),产物由 session 产出、被后续任务节点作为输入引用。

CYC-507 中以下部分**不变**:一级工单是业务单位，开发类需求对应一个分支和一个 PR;itsaplan 只保存一级工单;同一需求内写代码的节点在同一分支上串行;`loop.db` 是执行状态的唯一来源。

实现状态：只是决定，尚未实现。

## Alternatives considered

- **保留只有 Dev 的二级图和固定阶段，只给 PR 评审加一个 webhook 入口**:讨论中最先提出的方案。放弃原因：以后每加一种事件或角色，都要在开发流程里再写一个特例。
- **"开发"是一个节点，节点内部再有自己的 workflow 或子图，可以跨多个 session**:讨论中 Codex 提出过。用户否决：原子任务就是一个独立的 Agent session,多个 session 的协作应当画在图上。
- **事件直接创建任务，不经过流程实例**:用户的概念图中有 `Event → 任务` 这条线。决定把它当作简写：独立 PR 审阅是只有一个节点的流程，这样执行路径只有一条。

## Consequences

- 新增事件或角色时，改的是流程定义，不是 Loop 核心。同一个 PR 审阅任务可以服务 Loop 自己的工单和人开的 PR(权限见 [Loop 迁到独立主机、接 webhook、审阅并合并任意 PR](2026-11-28-loop-on-a-host-takes-webhooks-and-merges-any-pr.md))。
- 需要改造的地方:`loop.db` 的图结构要支持角色、输入、产物和结论;引擎要支持"登记等待、释放 worker、被事件唤醒"(目前等 CI 是在步骤内轮询，最长占住 worker `ciTimeoutMinutes`);`review()` 要拆成只交付"针对某个 SHA 的结论"的审阅任务;自测失败目前会开新的修复节点和新 session,要改为回到当前 session;调研流程要并入单节点图;`loop/*` API 和桌面端的图视图要跟着调整。
- 引擎边界不变(`scripts/boundaries.ts`):按仓库、PR、提交定位实例的规则放在各流程里，引擎只认不透明的 key。
- 以上均未实现、未验证。

## Related

- Partially supersedes [2026-11-26-loop-work-item-and-task-graph-boundary](2026-11-26-loop-work-item-and-task-graph-boundary.md):二级节点的角色范围和固定阶段被本决定替换;一级工单 = 业务单位 = 一个 PR、itsaplan 与 `loop.db` 的分工仍然有效。
- [2026-11-27-loop-is-three-layers-and-a-person](2026-11-27-loop-is-three-layers-and-a-person.md):确定性脚本管状态转移、LLM 只在受限步骤内工作，本决定沿用。
- [2026-11-28-loop-on-a-host-takes-webhooks-and-merges-any-pr](2026-11-28-loop-on-a-host-takes-webhooks-and-merges-any-pr.md):事件从哪里进来，以及对非 Loop 发起的 PR 的权限。
