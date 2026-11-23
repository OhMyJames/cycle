# Agent Note: Overview 只显示有来源的状态，goal 和后台任务补成可回放的 L1 更新

Status: accepted
Date: 2026-11-22
Basis: 2026-11-22 负责人在 CYCL-85 盘点后选定：goal 首版补上；后台任务（shell、Monitor、workflow、MCP）补上，cron 和 wakeup 先不跟踪。CYCL-86 的版式按下面的来源表定。

## Problem

Overview（CYCL-58）是右侧面板的第一个标签，汇总会话的环境、上下文、后台任务、todo、goal 和常驻调用。这些信息有的已在 L1 里、能从日志回放，有的只在 daemon 内存里，有的 Claude 适配拿到了却丢掉，有的 SDK 根本不给。面板如果把拿不到的说成"没有"，或者靠工具名去猜，就会误导人。

## Decision

**来源表（CYCL-85，2026-11-22 的代码）。** "回放"指在日志里，附着时由 `applyUpdate` 重建。

| 区块                                      | 来源                                                                                             | 回放                               | 首版                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------ |
| 环境：主机、目录、agent                   | 客户端的环境配置；列表行的 `cwd`、`cycle/agent`                                                  | 列表/索引                          | 显示                                                   |
| 模型、权限模式、effort                    | `config_option_update` 的 `model`/`mode`/`effort`（§10）                                         | 是                                 | 显示当前选择；`default` 照实说"默认"，不猜解析后的模型 |
| 上下文                                    | `usage_update` 加 `cycle/context`；`compaction_update`（§8）                                     | 是                                 | 显示用量、窗口、压缩次数，压缩后未重测时说明           |
| todo                                      | `plan_update`（TodoWrite、TaskCreate/TaskUpdate）                                                | 是                                 | 显示                                                   |
| 子 agent                                  | `subagent_update` 加 `cycle/subagent`（§9）                                                      | 是                                 | 显示，含"未知"状态                                     |
| 后台任务（shell、Monitor、workflow、MCP） | SDK 的 `task_*` 和 `background_tasks_changed`，`task_type` 不是 `local_agent` 的；适配器原来丢掉 | 否 → **新增 `_cycle/task_update`** | 显示                                                   |
| goal                                      | SDK 的 `active_goal`（`/goal` 设的条件、轮数）；`query()` 会交出它，适配器原来丢掉               | 否 → **新增 `_cycle/goal_update`** | 显示                                                   |
| cron、ScheduleWakeup                      | 没有生命周期事件，只有工具调用                                                                   | —                                  | 不跟踪，面板写明                                       |
| `cycle/background` 计数                   | daemon 内存（§6）                                                                                | 否                                 | 不用：面板从回放的更新里自己数                         |

**两条新的 L1 更新**（协议见 docs/protocol.md §8"会话的 goal"和"后台任务"）：都是 agent 发、daemon 照常写日志的 `session/update`，客户端取最后一条为准，所以回放就能还原。没有它们的旧日志照旧显示，只是没有 goal 和非子 agent 的后台任务。`_cycle/task_update` 的 `title` 来自命令的描述，daemon 按工具调用的规则过滤凭证。子 agent 仍走 `subagent_update`，后台任务不并进去：它们不是 agent，客户端会把子 agent 的进度挂到工具行上。

**版式（CYCL-86）。** 一列区块，顺序由负责人在 2026-11-22 体验后定为：环境、Goal（有时才出现）、上下文、Todo、后台。先说会话在哪里、为了什么，再说它的用量和进度。区块之间用细分隔线，标题用正文色，区块都展开，内容少，不做折叠。

- **状态的三种说法**：运行中（强调色的点）、已结束（结束原因：完成、失败、停止）、未知（离开了清单却没有结束消息，沿用[后台清单笔记](2026-11-20-background-roster.md)，可以从会话菜单标记为结束）。已结束的后台任务默认收在"N 个已结束"里。
- **跳回对话**：todo、子 agent、后台任务带着来源的工具调用 id 时，点一下就把对话滚到那一行并闪一下；没有 id（旧日志）就不可点。
- **空状态**：每个区块没有数据时用一句灰字说明为什么，比如"还没有 todo"、"这个 agent 不报告 goal"。cron 和 wakeup 在后台区块底部固定写"定时调用（cron、wakeup）暂不跟踪"。
- **停止**：首版没有停止按钮，L1 还没有停一个后台任务的方法。会话的 ⌘. 仍停整个 turn。

## Alternatives considered

- **从"正在发生的"到"不变的"排**（Goal、Todo、后台、上下文、环境）：首版这样做；负责人体验后改成上面的顺序。

- **后台任务也用 `subagent_update`，加一个 `kind`**：改动少，但旧客户端会把 shell 当子 agent 挂到 Bash 行上，daemon 的后台计数也会跟着变，影响 CYCL-104 的回收判断。
- **用 `cycle/background` 的计数**：只在 daemon 内存里，重启就归零，回放不出来。
- **从 CronCreate、ScheduleWakeup 的调用推断还挂着哪些**：负责人选了先不做，推断不准，另开 issue。
- **goal 放进 `session_info_update` 的 `_meta`**：那条更新的语义是标题和更新时间，和 goal 的生命周期不同，客户端还要区分"没带"和"清掉"。

## Consequences

- 适配器的进程空闲回收（`scheduleIdle`）同时看后台子 agent 和还在跑的后台任务：后台命令或 Monitor 在跑时进程不回收，否则任务会被一起杀掉（代码审查时补上）。状态未知的任务不算，否则一个丢失的任务会让进程永远不回收。
- 新更新只对升级后的会话有效；升级前的日志里没有 goal 和后台 shell，面板对旧会话就显示空状态。
- goal 在进程重启后是否还在由 Claude Code 决定，面板显示最后一次听到的；没有真实模型验证过 `active_goal` 的时机，只读了 SDK 0.3.327 的代码。

## Related

- [一小时内有定时调用要触发时不回收进程](2026-11-23-keep-the-process-for-crons-due-within-the-hour.md):CYCL-119 查明 Stop hook 的 `session_crons` 能准确给出会话挂着的定时调用,上表"cron、ScheduleWakeup"一行的"没有生命周期事件"不再成立;显示仍未做(CYCL-146),进程回收先按它改了。

- [Claude 暂不支持 goal](2026-11-22-claude-goal-not-supported.md):CYCL-120 用真实模型验证后,goal 这部分的来源不成立(本地进程收不到 `active_goal`);协议和适配器的转换保留,其余决定不变。
