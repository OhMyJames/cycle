# Agent Note: 子 agent 的进度摘要默认开启，可以在配置里关掉

Status: accepted
Date: 2026-11-23
Basis: CYCL-49(来自 0.2.8 代码审查的 P2,原附在 CYCL-14)。负责人 2026-11-23 的回答："子 agent 进度摘要默认开启吧"。机制取自 `@anthropic-ai/claude-agent-sdk` 0.3.327 的 `sdk.d.ts` 中 `agentProgressSummaries` 的说明。

## Problem

daemon 让 Claude 为子 agent 生成进度摘要(SDK 的 `agentProgressSummaries`,配置 `claude.progressSummaries`),每条摘要都是一次模型调用，会计入账号用量。桌面端子 agent 的工具行上已经有工具数、用量和最后一个工具，摘要值不值这份成本没有定过。

## Decision

- **默认开启**:`config.json` 的 `claude.progressSummaries` 默认 `true`,代码原本就是这样，这次只是把它定下来。界面在子 agent 那一行显示摘要(`subagent_update` 的 `_meta["cycle/subagent"].summary`)。负责人认为一行"它在做什么"比工具数和最后一个工具更好懂。
- **可以关**:设成 `false` 就不向 SDK 要摘要，其余进度信息不受影响。环境变量 `CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1` 也会关掉，但 daemon 自己环境里的这个变量不会传给 Claude(Claude 的环境只由 `allowEnv` 和 `env` 构造),所以要关就用配置项。
- 这是 daemon 的配置，不是协议的一部分：客户端不能通过协议开关它。

## Alternatives considered

- **默认关闭，客户端按需打开**(CYCL-49 列出的另一种做法):省掉这份用量，但桌面端是唯一的客户端，并且要显示摘要。默认关的话，等于让每个用户自己去配置文件里打开。负责人选了默认开启。

## Consequences

- **成本的样子**(按 SDK 的说明，没有实测):子 agent 在跑、对话有变化时，大约每 30 秒从它的对话分叉出一次调用，用同一个模型和它的 prompt cache,输出一行。对话没变化时不生成；prompt cache 可能已经冷了的时候，最多推迟 5 分钟；子 agent 先结束，那次就不发了。所以额外用量大致与子 agent 的运行时长成正比：每次主要是缓存读取，加一行输出，长任务累计起来不可忽略。
- **没有实测**:CYCL-49 要的"一次长子 agent 任务的额外用量"还没取。取的话要用真实账号跑一个几分钟的子任务，开关各跑一次，对比账号用量(Cycle 的日志里摘要调用不单独记)。拿到数据后补进这条笔记；如果明显偏高，就另写一条笔记改默认值。
- 用户想省用量时，改 `claude.progressSummaries` 后重启 daemon(`cycle stop`)即可。已经在跑的 Claude 进程用的还是启动时的配置。
