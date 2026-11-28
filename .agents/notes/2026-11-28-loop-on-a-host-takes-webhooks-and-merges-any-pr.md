# Agent Note: Loop 迁到独立主机(webhook 可选),并能审阅和合并非 Loop 发起的 PR

Status: accepted
Date: 2026-11-28
Basis: 2026-11-28 与用户对齐架构时的选择:"需要对外暴露入口来接 webhook""loop 接下来可以考虑开始迁移到一台指定的机器或者云上""(对非 Loop 发起的 PR)审阅评论 + 有合并权限"。对照的现状:`cloud/loop/src/server.ts`(仅本机 unix socket)、`cloud/loop/src/guard/floor.ts`、`cloud/loop/src/flows/dev/review.ts`。

## Problem

Loop 目前和用户的 daemon 跑在同一台机器上，只通过本机 unix socket 提供 `loop/*` API,靠轮询发现工作，只处理带 `auto` 标签的自家工单、只合并自己开的 PR。[每个需求一张流程图、由事件推进](2026-11-28-loop-runs-one-role-graph-per-requirement.md)之后，用户希望:

- 外部变化(GitHub、itsaplan)能实时推动 Loop;
- Loop 迁到一台指定的机器或云上运行;
- 人开的 PR 也由 Loop 审阅，并可以由 Loop 合并。

现有决定把远程访问列为范围外([loop/ API 是唯一入口](2026-11-26-loop-api-is-the-only-way-in.md)),信任边界也假设"人给工单打 `auto`"是唯一的放行闸门。

## Decision

1. **Loop 跑在一台常开的独立机器上**,用单独的系统用户运行，同机运行它自己的 daemon。首选一台独立的机器(例如 Mac mini),不先上云。迁移(CYC-543)暂缓，和运营 agent(CYC-486–488)一起启动。桌面端和 operator 仍只通过 `loop/*` API 访问 Loop,远程时走 SSH 隧道(与仓库"远程连接走 SSH 隧道"的约定一致)。`loop/*` API 不对公网暴露。
2. **webhook 入口是可选的，排在迁主机之后，现在不做。** 迁主机的理由是不和人抢 daemon、全天候在线、与个人环境隔离，不是 webhook:工单耗时以十分钟计，轮询的延迟可以接受。真要做时，它是对公网的入口，和 `loop/*` API 分开(也可以先用转发隧道把事件送到 Loop 所在机器)。它只接受已配置的来源(GitHub、itsaplan),校验签名，持久化后确认收到，此外不执行任何动作。签名不对或来源未配置的请求直接丢弃。事件只是"去重新检查"的提示，Loop 动作前从源头重新读取状态。轮询继续保留，用来补回漏掉的事件，主机停机期间的变化也靠它补齐。
3. **已配置仓库里的 PR,不论是谁开的，都走同一个 PR 审阅任务。** Loop 可以发评审意见，也可以合并。合并条件与 Loop 自己的 PR 完全相同：评审结论为合并、必需的 CI 全绿、改动不触及 [path floor](2026-11-27-loop-path-floor.md)。触及 floor 或读不到改动路径时，一律交给人。
4. **非 Loop 发起的 PR 的放行闸门，从"人打 `auto` 标签"换成"PR 作者可信"。** 第一版只处理同仓库分支、作者对仓库有写权限的 PR;fork 来的 PR 不审也不合并;草稿 PR 等转为可审后再处理。这一条是 agent 按用户"细节自己把握"选定的保守范围，以后可以单独放宽。

实现状态：第 3、4 条已实现(CYC-540、CYC-546,按项目由 `prReview` 开关启用);第 1 条暂缓，第 2 条可选、未排期。主机最终选型、部署方式不在本决定内。

## Alternatives considered

- **第一版不对外暴露，只用轮询产生事件，webhook 以后再加**:agent 提出过，用户起初选择现在就接 webhook;2026-11-28 复盘后改为采纳这一条，webhook 降为可选。
- **迁到云主机**:要维护公网入口，环境也和开发机差得更远;先用一台常开的独立机器。
- **对非 Loop 发起的 PR 只发评审意见，永不合并**:agent 提出过，用户选择给 Loop 合并权限。

## Consequences

- 如果以后接 webhook,会多一个要运维的公网入口和一个新密钥(webhook 签名密钥),要和其他 Loop 凭据一样只由 Loop 读取、不进入任何 session 或命令。
- **有写权限的协作者开的 PR,只经过 LLM 评审和 CI 就可能被合并，不再需要人看**(floor 路径除外)。这是用户接受的取舍;Loop 在这些 PR 上的评论和合并都以 Loop 的身份出现。
- 审阅任务会读到人写的、未经 Loop 管控的代码和 PR 描述，存在提示注入的可能。Reviewer 仍是只读角色，合并门禁由代码判断，不由评审文字直接触发。
- 每次推送都会重新审阅，成本随 PR 活跃度增长，需要按项目可配置的开关或预算。
- 迁到独立机器并用单独的系统用户运行后，Loop 读不到人的个人文件;Loop 自己的会话仍能读同一用户的 0600 文件([delivery repo 与干净环境](2026-11-27-loop-delivery-repo-and-clean-env.md)),要靠容器隔离(CYC-490)解决。
- `actor` 仍是自报的署名而非认证;多人经 SSH 访问同一个 Loop 时如何认证，不在本决定内。
- 第 1、2 条相关的后果均未实现、未验证。

## Related

- Partially supersedes [2026-11-26-loop-api-is-the-only-way-in](2026-11-26-loop-api-is-the-only-way-in.md):"远程访问不在范围内"被本决定替换为"经 SSH 隧道访问独立主机上的 Loop";`loop/*` 仍是桌面端和 operator 的唯一入口，认证仍不在范围内。
- Partially supersedes [2026-11-25-loop-server-is-its-own-process](2026-11-25-loop-server-is-its-own-process.md):"没有通过 SSH 的远程 Loop server"被替换;Loop server 与 daemon 同机这一点不变，只是这台机器换成独立主机。
- [2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary](2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary.md):对非 Loop 发起的 PR,放行闸门由 `auto` 标签换成作者权限;其余边界不变。
- [2026-11-27-loop-path-floor](2026-11-27-loop-path-floor.md):合并任何 PR 前都要过这道 floor。
- [2026-11-28-loop-runs-one-role-graph-per-requirement](2026-11-28-loop-runs-one-role-graph-per-requirement.md)
