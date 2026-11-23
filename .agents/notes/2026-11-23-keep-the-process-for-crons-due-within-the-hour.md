# Agent Note: 一小时内有定时调用要触发时不回收 Claude 进程

Status: accepted
Date: 2026-11-23
Basis: CYCL-119 调研与当天两轮真实模型探针(SDK 0.3.327、haiku);负责人 2026-11-23 选定方案 C;实现与回归测试在 CYCL-145。

## Problem

适配器空闲 `idleMs`(默认 5 分钟)就回收会话的 Claude 进程(决定 0007)。CronCreate 默认、ScheduleWakeup 和 /loop 的定时调用只存在这个进程的内存里。实测:进程关掉期间到点的 cron 和 wakeup,resume 后不补触发,也没有任何通知;还没到点的会话 cron 会被 CLI 从会话记录重建并按时触发。所以 agent 说"20 分钟后再看",在 Cycle 里到点不会醒。

## Decision

- 适配器给 Claude 进程注册一个只读的 Stop hook,记下它每个回合结束时给出的 `session_crons`(会话内存里全部定时调用的快照,含 wakeup;不含 durable 任务)。hook 返回空对象,不改变回合。
- 两份快照之间,ScheduleWakeup 的 `scheduledFor` 和会话 CronCreate 的 `nextFireAt` 也记下,下一份快照到来时以快照为准。被取消或出错的回合可能没有 Stop hook,这样它设的 wakeup 也不会丢。
- 回收前判断:按 cron 表达式(本机本地时间)算,有一条在 1 小时内触发,就不回收,到时再判断一次。重复任务的分钟过去 30 分钟内仍算"要触发":CLI 2.1.327 给重复任务加最多半个周期、至多 30 分钟的偏移(按 id 算),这里不复刻它的算法,只按上限放宽。读不懂的表达式在快照一小时内按"要触发"算。任何一条在它的分钟过去 2 分钟内也算"要触发":触发后到新回合说出第一个字之前,会话看起来是空闲的;实测曾在触发后一秒因"已过分钟"回收,那次 wakeup 就没人接。
- 更远的照常回收,下次 prompt 引起的 resume 由 CLI 重建它们;回收期间到点的那几次会丢,界面说明留给 CYCL-146。
- 快照在进程换代时保留,新进程第一个回合结束时会给出新的。

## Alternatives considered

- **A. 只要有定时调用就不回收**:最简单。否决:重复任务最长 7 到 30 天(随 CLI 版本),会让一个每天一次的 cron 把约 230 MB 的进程常驻一个月。
- **B. 回收,到点前用 resume 叫醒进程**:常驻最短。否决:多一个跨进程的定时器,依赖 CLI 重建任务的细节和启动耗时,且 wakeup 和 /loop 这些最常见的用法都在一小时内,C 已经覆盖。
- **只从工具结果推断**(CronCreate 的 `nextFireAt`、ScheduleWakeup 的 `scheduledFor`):ScheduleWakeup 的结果没有 id,删不掉触发过的;一次性任务触发后自动删除也没有结果可看。Stop hook 的快照才是准的。
- **UserPromptSubmit 的 `source` 或流里的 `command_lifecycle`**:前者 0.3.327 实测没有这个字段;后者不在公开类型里。都只能说"触发了",说不出"还挂着哪些"。

## Consequences

- wakeup 和间隔不超过一小时的 /loop、cron 会按时触发;真实模型测试(`idleMs` 1 秒、60 秒后的 wakeup)在修复前失败、修复后通过。
- 一个间隔不超过一小时的重复 cron 会让进程常驻到它被删或过期。
- 一个重复任务触发后,进程最多再多留半小时(偏移的上限),然后照常回收。
- 被取消或出错的回合里删掉的定时调用,要到下一份快照才知道,期间进程可能多留。
- durable 任务不在快照里,不受这条规则保护。
- 偏移的上限读自 CLI 2.1.327 的代码,CLI 改了它,判断就会偏;真实模型测试只覆盖 wakeup。
