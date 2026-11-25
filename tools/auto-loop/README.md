# auto-loop

自动化闭环（CYC-318 第一步）：从 itsaplan 的 Todo 列取一张带 `auto` 标签的工单，在 Cycle 里开 Dev 会话（独立 worktree），由代码跑验证，再开独立 QA 会话审查，通过后推分支、开 PR、把工单移到 In Review。

## 运行

```sh
export AUTO_LOOP_PLAN_KEY=...        # itsaplan 的 key，只给 Loop 本身，不会传给任何会话或命令
bun tools/auto-loop/src/cli.ts --dry-run   # 只挑单、预检、打印，不写任何东西
bun tools/auto-loop/src/cli.ts --once      # 处理一张
bun tools/auto-loop/src/cli.ts             # 常驻，空闲时每 60 秒看一次（--interval 改）
bun tools/auto-loop/src/cli.ts stats       # 自主完成率、介入率、返工率
```

前提：Cycle daemon 在运行（`$CYCLE_HOME/daemon.sock`），`agy` 与 `claude` 已登录，`gh` 已登录，能推 `origin`。

可选环境变量：`AUTO_LOOP_PLAN_URL`、`AUTO_LOOP_PROJECT`（默认 CYC）、`AUTO_LOOP_STATE`、`CYCLE_SOCKET`。

## 约定

- 工单必须有「验收标准」列表，每条带 `验证：\`命令\``，命令只能是白名单形式；否则退回并留言。
- 验收状态只由 Loop 跑命令后设置（`criteria.json`），会话说“完成”不算数。
- 卡住（Blocked）时保留 worktree 和会话；处理后把工单放回 Todo，会在原会话里继续（会话丢失则新开会话，凭 criteria + 进度 + git log 接手）。
- 无人值守的权限请求：基线白名单自动放行，其余留在会话里等你在桌面端批准。
- 状态在 `<stateDir>/runs/<KEY>/`（run.json、criteria.json、progress.md）和 `events.jsonl`，都在 worktree 之外。

## 尚未验证

- 对真实 itsaplan 的鉴权头（目前用 `Authorization: Bearer`）和返回结构。
- 对真实 daemon + agy/claude 的端到端一次完整运行。
