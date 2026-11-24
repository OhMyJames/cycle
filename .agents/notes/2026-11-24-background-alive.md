# Agent Note: 后台任务算进 `cycle/background`，轮与轮之间对话末尾写一条后台行

Status: accepted
Date: 2026-11-24
Basis: 负责人 2026-11-24 反馈"有后台任务、前台没任务时 status bar 不展示、status dot 也没有，跟死了一样"，并确认了方案：定时调用不算、后台行的圆点要慢呼吸、不写最早任务的时长。

## Problem

`cycle/background` 只数后台子 agent。Claude 的后台命令、Monitor、workflow（`_cycle/task_update`，CYCL-87）在跑时侧栏没有"后台"标记；对话末尾的状态行只在 turn 进行中出现。于是一个后台命令还在跑的会话，看上去和已经结束的一样。

## Decision

- daemon 在内存里按 `taskId` 记下最后一条为 `running` 的任务，算进 `backgroundCount()`，也就是 `cycle/background`。终态和 `unknown` 都移出（`unknown` 与子 agent 的未知记录一样，不算在跑）。agent 进程退出时清空。定时调用（cron、`/loop`、ScheduleWakeup）不算。
- 所以后台任务也挡住空闲回收（CYCL-104），`cycle stop --wait` 和桌面端升级也会等它。这是有意的：回收会结束 agent 进程，它起的后台命令跟着死，等于悄悄杀掉用户的任务。
- **过期 agent 的重启（信任、运行时、账号变了）不等任务**，只等后台子 agent：一个永远不结束的 Monitor 不能让权限或账号的变化一直不生效。
- 代价：一直不结束的任务（长期的 Monitor）会让 agent 一直不被回收，`--wait` 一直等，这时用 `--force`。
- 界面：轮与轮之间，对话末尾在状态行的位置写一条后台行（`turn.tsx` `BackgroundLine`）。名字和数量取自回放出来的 `backgroundOf(conversation)`，但只在 daemon 的 `cycle/background` 大于 0 时出现：agent 进程意外死掉时历史里没有终态，只看历史会永远写着"在运行"。旧 daemon 不报这个数，就不显示。点击另记一个事件 `background_shown_from_conversation`。用侧栏同款空心圆慢呼吸，不用 MorphLoader、不计时、不抢 loader，点开概览面板。

## Alternatives considered

- **任务只是通告、不算进计数**（CYCL-87 / [概览笔记](2026-11-22-overview-sources-and-layout.md)当时的做法）：侧栏看不出会话还在跑，回收还会杀掉还在跑的命令。被本条取代。
- **后台行复用 MorphLoader 和整轮计时**：会让人以为 agent 正在干活、不能输入，也和"对话里只有一个 loader"冲突。
- **定时调用也算"在跑"**：它们大部分时间在等，会让会话一直挂着标记。负责人否决。

## Consequences

- `cycle/background` 的含义变宽了：旧客户端看到的数字会包含后台任务，它们只把它当"后台有东西在跑"，不区分种类，所以不受影响。
- 若以后加"停止一个后台任务"的方法，计数和回收判断都不用再改。
