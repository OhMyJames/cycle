# Agent Note: Claude 新会话默认 Sonnet medium，并默认开着 Opus advisor

Status: accepted
Date: 2026-11-24
Basis: 负责人 2026-11-24 的决定："放全局 harness 里面。默认开启，默认模型是 Sonnet 5.5 medium，advisor 的模型是 Opus 5.5"；当天用 SDK 0.3.331 抓的真实回合（见 docs/adapters/claude.md "Advisor"）。

## Problem

Claude 的 advisor（API 的服务端工具）在 SDK 会话里可用，但 Cycle 既没有开关，也不显示它：适配器丢掉了 `server_tool_use` 和 `advisor_tool_result`，请教 advisor 的十几秒里对话看上去停住了。负责人要它默认开着，主模型默认用 Sonnet。

## Decision

- Claude 多一个配置项 `advisor`：`off` / `opus` / `sonnet` / `fable`。进程启动时放进 `settings.advisorModel`，运行中用 `applyFlagSettings` 换。advisor 没有 effort，所以负责人说的"Opus 5.5 medium"只能落到 Opus。
- 新会话的默认值由 daemon 给（`AgentDefinition.newSession`，Claude 的是 `CLAUDE_NEW_SESSION`：`sonnet`、`medium`、`opus`），排在用户保存的默认值和这个会话自己的选择之下。只作用于新会话：已有会话恢复时用它记下的配置，不会被打开 advisor。适配器自己的默认仍是"不设"，所以没经过 daemon 的会话不会被开启。
- 模型列表把 `sonnet` 折进 "Sonnet 5.5 (default)" 那一行时，daemon 的模型缓存仍保留静态的 `sonnet` 一项，让默认值一直是可选的一项。
- advisor 只在 Harness 设置的默认值和会话设置里，不进输入框旁的选项：新的 schema 标记 `_meta["cycle/composer"]: false`（protocol.md §10）。
- 调用画成一行（`Asking the advisor` + 计时 → `Asked the advisor` / `The advisor could not answer`），展开看明文建议、"已加密"或错误码。加密内容不转发：新模型的建议只有 Claude 能读。

## Alternatives considered

- **只放会话设置、默认关闭**：我最初的建议。负责人选了全局、默认开启。
- **改适配器的内置默认为开**：会让旧会话恢复时也被打开（它们的配置里没有 `advisor`），违背"已建会话不变"。
- **在对话里写出 advisor 的模型名**：会话中途可以换 advisor，旧的调用会被写成新的名字，所以不写。

## Consequences

- 每次请教都读整段对话，按 advisor 的价格计（订阅用户计入额度）。一次全新会话的请教约 $0.09；长会话会贵得多。调用次数由 Claude 决定，Cycle 不限。设置项的说明里写了这一点。
- Fable 会话用不上 Opus advisor（Claude Code 不挂上，也不说），说明里写了。
- 用户在会话里用 `/advisor` 改的是 Cycle 托管目录里的 settings.json；Cycle 选了"关闭"时撤掉的只是自己的那一层，那份文件里的仍然生效。
