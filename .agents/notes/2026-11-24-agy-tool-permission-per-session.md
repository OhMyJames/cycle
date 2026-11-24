# Agent Note: agy's tool permission is a session option, written to settings.json, not a process flag

Status: accepted (supersedes [2026-11-24-agy-skip-permissions.md](2026-11-24-agy-skip-permissions.md))
Date: 2026-11-24
Basis: CYC-285、CYC-286。实测 132 次权限确认全部被手动点了允许；2026-11-24 在 agy 1.5.16、真实账号、临时 HOME 下的实测(记录在 `docs/adapters/agy.md`)。

## Problem

上一条决定把"跳过全部权限确认"做成进程级的 `--dangerously-skip-permissions` 运行设置，并明确不去写 agy 自己的 settings。之后实测发现：

- agy settings.json 的顶层 `toolPermission` 有 `request-review`、`proceed-in-sandbox`、`strict`、`always-proceed` 四档，只在会话的 worker 创建时读取一次。
- 进程参数压过文件，而且整个进程只能一个值，Cycle 每个会话一个适配进程时没问题，但切换档位要重启进程，会话的选择也进不了会话配置项。

## Decision

- 做成会话配置项 `toolPermission`(界面叫"权限")，四档都给，`always-proceed` 带 `cycle/danger`。和 Claude 的 bypassPermissions、Codex 的 full-access 一样按危险项展示，没有额外二次确认。
- 推翻"不写 agy 的 settings"：这个键是 agy 文档里写明的用户配置，不是私有内部格式。适配进程只改 `toolPermission` 这一个键，原子写、0600，别的键原样保留；文件不合法时拒绝启动会话，不覆盖。
- settings.json 是所有会话共享的一个文件，而 agy 只在 worker 创建时读，所以"写自己的档位、启动 worker"在跨进程锁里做，每次都显式写，不继承别的会话留下的值。
- 切档位 = `session/close` 加 `session/resume` 重建 worker，会话 id 和对话不变，`mode`/`model`/`effort` 重设。回合进行中切，等到下一回合开始前再重建。
- `--dangerously-skip-permissions` 不再传。运行设置 `skipPermissions` 保留，含义改成"新会话从 `always-proceed` 开始"。

## Why the default stays request-review

推翻原决定的原因是实测 132 次确认全部被手动点了允许，说明弹窗对这位使用者没有筛选作用，所以提供完全放行；但默认仍是 `request-review`，是 agy 自己的默认，新用户不应在没看到危险标记时就失去确认。

## Rejected

- 写 `permissions.allow` 白名单(CYC-285 原方案)：实测 agy 1.5.16 的 ACP 不执行 `command(...)` 的 allow 和 deny 规则，写了也无效。等 agy 修了再做；到时重新实测。
- 每个会话一个 settings 目录：对话和登录令牌都在同一个目录里，拆开会破坏 resume。

## Consequences

`always-proceed` 下 agy 能动到 daemon 所在用户能访问的一切，风险同 Claude 的 `bypassPermissions`。设置页的 `skipPermissions` 和会话里的"权限"是两个入口，前者只决定新会话的起点。适配进程崩溃时残留的锁 30 秒后被接管。
