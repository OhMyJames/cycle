# Agent Note: CI 的每个测试类作业按 2 核 4 GB 规划,2 分钟内跑完

Status: accepted
Date: 2026-11-27
Supersedes: 2026-11-21-interface-tests-in-a-real-browser.md 里关于"CI 一个 browser 作业"的部分(把界面测试放在 CI、不放门禁的决定不变)
Basis: 负责人要求"每个 CI 节点不超过 2 分钟,按 2c4g 容量上线来预估";2 核 4 GB Docker 容器里的实测;最近 14 次 PR 的 CI 记录

## Problem

界面测试从约 200 个涨到约 580 个,CI 的 `browser` 作业到了 160~210 秒(测试步骤 125~166 秒),是 PR 要等的最长一段;`integration` 97~150 秒。那是 4 核 16 GB 的 runner(公开仓库的 `ubuntu-latest`)上量的,按 2 核 4 GB 只会更慢:2 核 4 GB 的容器里整套界面测试要 111 秒,加上安装已超 2 分钟。

## Decision

- 规则:CI 里每个测试类作业按 2 核 4 GB 规划,目标 2 分钟(含安装),`timeout-minutes` 5 分钟强制终止。超了就拆成并行的份,不加时间。`scripts/ci-budget.test.ts` 保证每个作业都设了不超过 5 的超时、分片不重不漏。
- 界面测试切三份(`BROWSER_SHARD=n/N`,`packages/ui/test/shard.ts`),按每个文件的测试数装箱:三份都在 38~42 秒。用 vitest 自带的 `--shard`(按文件名哈希)是 60/31/20 秒,按文件大小是 50/56/74 秒,都不均。
- integration 按需要什么分两个作业:`agents`(不要显示、Electron、Chromium)和 `shell`(都要),各自只装自己要的。`--group` 参数,每个套件有 `group`。
- 作业名不变:`browser`、`integration` 变成汇总作业(`if: always()`),ruleset 要求的名字不用改。
- 只改文档的 PR(`*.md`、`docs/`、`.agents/`)跳过 browser 和 integration;`check` 不跳,因为有测试读文档。用作业级的 `if:`,不用工作流级 `paths:`(后者会让 required check 一直 pending)。
- 本机 `maxWorkers` 取核数的一半、最多 6(15 核 92 秒到 35 秒),CI 固定 2。

## Alternatives considered

- **一个作业开更多 worker**:2 核上没用,测试吃满 CPU(CPU 时间约等于墙钟)。
- **删测试**:没有需要;切分后留有一半余量,没删。
- **按"内容没变就跳过 check"的缓存标记**:Actions 缓存按 ref 隔离,PR 上写的缓存 main、tag 和别的 PR 读不到,只对同一 PR 内重跑有用;为此引入的复杂度不值得。release 打 tag 时重复跑 check(串行多等约 1 分钟)的问题没处理:负责人说 release 低频,先不改。
- **缓存 Playwright 的浏览器(729 MB)**:恢复约 13 秒加保存,比直接下载还慢,去掉了。**未在 CI 上量过**,第一次跑后要看三份的总时长;若 `playwright install --with-deps` 超过约 25 秒,改回缓存。

## Consequences

- 作业数变多(`browser-part` 3 个、`integration-part` 2 个),runner 分钟约多 1 倍,墙钟更短。
- 新增一个界面测试文件会自动进某一份;三份的均衡靠"文件的测试数"这个近似,哪天某份超过 90 秒再调。
- 没有量的:integration 两份在 2 核 4 GB 上的耗时(只在 4 核上看到整个作业 97~150 秒、套件加起来约 75 秒);release 的 macOS 作业约 10 分钟(签名公证约 296 秒、上传产物约 170 秒),不满足 2 分钟,待办。
- 2 核容器里整套跑过一次 `turns` 的"对话上下沿淡出"测试失败,分片重跑通过;可能是负载下的时序,未查。
