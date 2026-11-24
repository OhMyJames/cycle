# Agent Note: agy plugins' stdio MCP servers are handed to agy by the adapter, and agy-fast's write and run tools are never "always allowed"

Status: accepted
Date: 2026-11-24
Basis: 用户 2026-11-24 要求调研 `INK-Q/agy-fast` 并在可行时接入 Cycle 的 agy,选定"最小方案 A"(通用代传、不做 diff)。下面的事实是同日在 agy 1.5.16、`~/.cycle/agy`(Cycle 的 agy HOME)、真实模型下实测的,见 [docs/adapters/agy.md](../../docs/adapters/agy.md)。

## Problem

agy-fast 是 Antigravity 的插件(MCP 加 `SessionStart` hook 加路由规则),声称把 LLM 轮数减少约三分之一。装进 Cycle 的 agy 后:hook 和规则照常加载,但 5 个 MCP 工具模型一个也看不到。agy 的 ACP worker 启动时记 `Not reloading plugin MCP servers: cannot get the signed-in user`,不启动 plugin 自己的 MCP 服务器。这影响所有 agy plugin,不只 agy-fast。

## Decision

- 适配进程在 `session/new`、`session/resume` 前读已启用 plugin 的 `mcp_config.json`,把 stdio 服务器作为会话 `mcpServers` 传给 agy。名字 `<plugin>_<server>`,与 agy 自己的命名一致,plugin 规则里的工具名(`mcp_agy-fast_fast_*`)才对得上。会话自己的、同名的优先。
- 读取失败(agy 不可用、超时 5 秒、JSON 坏)就不带,不影响开会话。
- 5 个工具全部给,不挑:规则文件默认它们都在,只给一部分会让模型去调不存在的工具。
- `mcp_agy-fast_fast_apply_edits`(写任意文件)和 `mcp_agy-fast_fast_run_checks`(跑任意命令)不提供"Always allow in this session":该选项按工具名记,点一次就等于放行之后的一切,绕过 `run_command` 按命令段判断的做法。三个只读工具照常提供。
- daemon 给 agy 的环境固定 `AGY_FAST_AUTO_UPDATE=off`:agy-fast 的 hook 会后台联网查 GitHub 并替换自己的文件,Cycle 不替用户开这个。`agy.env` 里设了就以用户为准。

## Rejected

- 只集成一个工具:见上。
- 把 `apply_edits` 的结果转成 diff 显示(方案 B):要解析 agy-fast 的返回文本,与它的输出格式耦合,它才出现五天、单作者,不值得。
- 只写文档不集成:代传是通用修复,成本小。
- 把 agy-fast 打进 Cycle:不打包,与 agy 的做法一致(见 [2026-11-23-agy-terms-distribution-and-telemetry.md](2026-11-23-agy-terms-distribution-and-telemetry.md)),用户从插件页装。

## Consequences

- 装了 agy-fast 的用户,agy 会话里多出 5 个 MCP 工具。`apply_edits` 没有 diff,不进会话改动列表,界面上只是一条普通工具调用。
- agy-fast 声称的收益(轮数 -34%、配额 -31%)是作者在 Antigravity 桌面端样本上测的,没有在 Cycle 里验证。
- 工具名写死在 `NEVER_REMEMBERED_TOOLS`:别的 plugin 的同类工具不受这条保护。agy 以后自己支持 plugin MCP 或 `permissions` 规则起作用时,这条要重新评估。
- 只代传 stdio;带 `command` 的才算。
