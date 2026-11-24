# Agent Note: Offer agy's --dangerously-skip-permissions as a runtime setting

Status: superseded by [2026-11-24-agy-tool-permission-per-session.md](2026-11-24-agy-tool-permission-per-session.md)
Date: 2026-11-24
Basis: 用户 2026-11-24 的要求:agy 会话"一直跳弹层",问有没有更高的权限，确认后要求"两个一起修复"(新会话回到 default 的 bug,以及开放更高权限)。此前 `docs/adapters/agy.md` 把 `--dangerously-skip-permissions` 列在"未做",没有写原因。

## Problem

agy 的 ACP 只给四个模式(`default`、`accept-edits`、`auto`、`plan`),最宽的 `auto` 仍会在它认为不可逆的操作前询问。agy 自己 TUI 里的 `always-proceed`(界面写作 "turbo")是它 settings 里的工具执行策略，不在 ACP 的模式里，实测 `session/new` 的 `modes` 与 `configOptions` 都不含它。要完全不问，只有 `agy acp --dangerously-skip-permissions` 这个进程参数。

## Decision

- 作为 agy 的运行设置 `skipPermissions` 提供(`agent-settings.json` 或 `config.json` 的 `agy.skipPermissions`),默认关，标 `META.danger`,`next_idle_restart`:改了以后空闲的进程重启才生效。
- 不做成第五个 `mode`:它是进程参数，不是会话设置，会话中切换做不到;做成模式会让下拉框里的选项和 agy 实际行为对不上。
- 不去写 agy 自己的 settings 来打开 `always-proceed`:那是 agy 的私有文件格式，没有机器可读的接口。

## Alternatives considered

- 继续不提供：用户明确要求，之前也没有记录不提供的理由。
- 写 agy 的 settings.json 打开 `always-proceed`:依赖私有格式，升级会坏，而且和 Cycle 隔离 HOME 的做法冲突。

## Consequences

打开后 agy 编辑文件、执行命令、调用工具都不再询问，能动到 daemon 所在用户能访问的一切，与 Claude 的 `bypassPermissions`([2026-11-19-offer-every-claude-permission-mode.md](2026-11-19-offer-every-claude-permission-mode.md))同等风险。界面除了危险标记没有额外确认，要不要加没有决定。打开后会话的模式菜单照旧列出 `default`、`accept-edits` 等，选了也不会再问，菜单不会提示它们被这个开关压过。保存运行设置时埋点 `agent_runtime_settings_saved` 带 `skip_permissions`(保存后是否开着),不记别的配置项。没有在真实 agy 上验证该参数下的模式列表和 `session/request_permission` 行为，只核对了 `agy acp --help`(1.5.x)里有这个参数。
