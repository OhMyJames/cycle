# auto-loop

自动化闭环（CYC-318 / CYC-331 / CYC-332）：从 itsaplan 的 Todo 列取一张带 `auto` 标签的 Feature/Bug 叶子工单（无子任务），在 Cycle 里开 Dev 会话（独立 worktree），由代码跑验证，再开独立 QA 会话审查，通过后推分支、开带 `Closes CYC-<num>` 的 PR，等待 `check`、`browser`、`integration` 三项 CI 跑完；任一 CI 为红则拉取失败日志打回 Dev 修复并重推同一分支（重试超限则 Blocked）；CI 全绿后启动独立只读评审会话按根目录 `REVIEW.md` 评审，必须给出三种结论之一并写成 PR 评论：合并（`merge`，且 CI 全绿时开启 GitHub 自动合并 squash）、拒绝（`reject`，带评审意见打回 Dev 修改并重跑 CI 与评审，超修复轮数上限则升级给人）、升级给人（`escalate`，不开自动合并并将工单移入 In Review）；若评审会话失败、超时、异常结束、输出无法解析或通过未写检查清单，先重试（有次数上限），重试用完仍无结论才升级给人并写明这是评审系统故障而非代码问题。

## 运行

```sh
export AUTO_LOOP_PLAN_KEY=...        # itsaplan 的 key，只给 Loop 本身，不会传给任何会话或命令
bun tools/auto-loop/src/cli.ts --dry-run   # 只挑单、预检、打印，不写任何东西
bun tools/auto-loop/src/cli.ts --once      # 处理一张
bun tools/auto-loop/src/cli.ts             # 常驻，空闲时每 60 秒看一次（--interval 改）
bun tools/auto-loop/src/cli.ts stats       # 自主完成率（只算 Loop 自己开启自动合并并确认合并、且没人介入的）、autoMerged、介入率、返工率
```

前提：Cycle daemon 在运行（`$CYCLE_HOME/daemon.sock`），`agy` 与 `claude` 已登录，`gh` 已登录，能推 `origin`。

可选环境变量：`AUTO_LOOP_PLAN_URL`、`AUTO_LOOP_PROJECT`（默认 CYC）、`AUTO_LOOP_TYPE_IDS`（逗号分隔的类型 id，默认 `20,25` 即 Feature/Bug）、`AUTO_LOOP_STATE`、`CYCLE_SOCKET`。三类会话用的 agent 默认都是 `claude`，可用 `AUTO_LOOP_DEV_AGENT`、`AUTO_LOOP_QA_AGENT`、`AUTO_LOOP_REVIEW_AGENT` 单独改（填 agent id，如 `agy`）。

## 约定

- 工单必须有「验收标准」列表，每条带 `验证：\`命令\``，命令只能是白名单形式；否则留言写明原因，并把工单移到 Blocked。
- 验收状态只由 Loop 跑命令后设置（`criteria.json`），会话说“完成”不算数。
- 卡住（Blocked）时保留 worktree 和会话；处理后把工单放回 Todo，会在原会话里继续（会话丢失则新开会话，凭 criteria + 进度 + git log 接手）。
- 无人值守的权限请求：基线白名单自动放行，其余留在会话里等你在桌面端批准。
- 清理（CYC-379）：每轮选单前检查已结束的 run；工单为 Done 且 PR 已合并时，删除它自己的 worktree 和本地分支。不强删：有未提交改动则只记 `cleanup_skipped_dirty` 事件留给人；不动会话和远端分支。
- 状态在 `<stateDir>/runs/<KEY>/`（run.json、criteria.json、progress.md）和 `events.jsonl`，都在 worktree 之外。
