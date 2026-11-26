# auto-loop

自动化闭环（CYC-318 / CYC-331 / CYC-332）：从 itsaplan 的 Todo 列取一张带 `auto` 标签的 Feature/Bug 叶子工单（无子任务；开启后也取 Research 工单，见「调研工单」），在 Cycle 里开 Dev 会话（独立 worktree），由代码跑验证，再开独立 QA 会话审查，通过后推分支、开带 `Closes CYC-<num>` 的 PR，等待 `check`、`browser`、`integration` 三项 CI 跑完；任一 CI 为红则拉取失败日志打回 Dev 修复并重推同一分支（重试超限则 Blocked）；CI 全绿后启动独立只读评审会话按根目录 `REVIEW.md` 评审，必须给出三种结论之一并写成 PR 评论：合并（`merge`，且 CI 全绿时开启 GitHub 自动合并 squash）、拒绝（`reject`，带评审意见打回 Dev 修改并重跑 CI 与评审，超修复轮数上限则升级给人）、升级给人（`escalate`，不开自动合并并将工单移入 In Review）；若评审会话失败、超时、异常结束、输出无法解析或通过未写检查清单，先重试（有次数上限），重试用完仍无结论才升级给人并写明这是评审系统故障而非代码问题。

## 运行

```sh
# 配置文件（权限须为 0600，默认 ~/.cycle/auto-loop.json，或 --config <路径>）：
#   { "repoRoot": "/abs/repo", "projectKey": "CYC", "stateDir": "/abs/state", "planKey": "..." }
# 多个 Project：{ "projects": [ {上面的字段}, {…} ] }，一个进程各跑各的循环，一个卡住不影响另一个；
#   每个 Project 的 stateDir 必须不同（相同则启动报错），锁各在自己的 <stateDir>/loop.lock
# planKey 只给 Loop 本身，不会传给任何会话或命令
bun tools/auto-loop/src/cli.ts --dry-run   # 只挑单、预检、打印，不写任何东西
bun tools/auto-loop/src/cli.ts --once      # 处理一张
bun tools/auto-loop/src/cli.ts --workers 2 # 每个 Project 起 2 个 worker 并发（见下）
bun tools/auto-loop/src/cli.ts             # 常驻，空闲时每 60 秒看一次（`--interval` 或配置文件 `tuning.intervalSeconds` 改）
bun tools/auto-loop/src/cli.ts stats       # 自主完成率（只算 Loop 自己开启自动合并并确认合并、且没人介入的）、autoMerged、介入率、返工率；`firstPassRate`（零介入零返工自动合并占比）、`reworkByStage`（`round_failed` 按紧邻前一事件归到 verify/qa/ci/review/other，含次数与 run 数）、`durationMs`（已交付 run 从 claimed 到 delivered 的中位数与 P90，nearest-rank）；以上都只算开发 run（按每个 run 第一个 `claimed` 事件的 `runKind` 分，没有的算开发），调研 run 只计 `researched`（发布并移到 Done 的个数）；另有 `permissions`（含调研会话）：被留给人或被拒的权限请求，按「种类 + 命令前两个词」统计，列出被人允许最多的前 10 项及各自被允许、被拒绝的次数（事件 `permission_requested`、`permission_answered`，只记命令前两个词）
```

前提：Cycle daemon 在运行（`$CYCLE_HOME/daemon.sock`），`agy` 与 `claude` 已登录，`gh` 已登录，能推 `origin`。

配置文件可选字段：`planUrl`、`autoLabel`（默认 `auto`）、`featureType`、`bugType`（默认 `Feature`、`Bug`，按名字在 `get_project` 里找类型 id）、`devAgent`、`qaAgent`、`reviewAgent`（默认 `claude`）。`devModel`、`qaModel`、`reviewModel`、`devEffort`、`qaEffort`、`reviewEffort`（可选，非空字符串）：按角色指定会话的模型和思考强度，创建会话后通过 `setConfig` 设置；省略表示沿用 agent 默认配置，空白串校验失败。必填项缺失时启动报错并指出缺哪一项。不再读 `AUTO_LOOP_*` 环境变量；`CYCLE_HOME`、`CYCLE_SOCKET` 仍用于找 daemon。`workers`（正整数，可选）：该 Project 的 worker 数，命令行 `--workers N` 优先，都没有为 1；写错时启动报错并指出是哪个 Project。改配置后重启生效。

## 冲突处理（CYC-411）

PR 与 main 冲突时，Loop 自己处理，每个工单最多处理 1 次：

- 触发点：等 CI 时读到冲突；开启自动合并后等合并时读到冲突。两处都先把 main 合并进分支（不 rebase、不强推）；干净就继续验证、QA、推送；真有冲突就交给原 Dev 会话解决，按仓库状态判定是否解决。
- 处理任何冲突之前，先读 PR 是否开着自动合并（`gh pr view --json autoMergeRequest`），开着就关（`gh pr merge <pr> --disable-auto`）。原因：GitHub 文档说，有写权限的人往开了自动合并的 PR 推送，自动合并不会被关掉；Loop 的 token 有写权限，不先关，解决冲突的提交会在 CI 变绿后绕过重新评审直接合并。因 `merge_timeout` 转 Blocked 后被人放回的工单自动合并可能仍开着，所以每个触发点都检查。
- 之后重新等 CI、重新评审；评审再次为 merge 才重新开启自动合并，确认合并后才记 `delivered`。
- 转 Blocked 的条件：读不到或关不掉自动合并（不推送）；已处理过 1 次又冲突（原因写明冲突文件和次数）；合并、解决失败。
- PR 描述的提交列表不列合并提交（`git log --no-merges`）。

## 调参（tuning，CYC-441）

每个 Project 可选写一个 `tuning` 对象，字段都可不写，不写就用默认值；单位写在字段名里。

| 字段                                                     | 默认       | 范围   |
| -------------------------------------------------------- | ---------- | ------ |
| `intervalSeconds`（空闲时查 Todo 的间隔）                | 60         | 1–3600 |
| `maxCriteria`                                            | 8          | 1–20   |
| `maxFixRounds`                                           | 3          | 1–10   |
| `maxCiRetries`                                           | 2          | 0–10   |
| `maxReviewRetries`                                       | 2          | 0–10   |
| `maxInterruptRetries`                                    | 3          | 0–10   |
| `maxQaRetries`                                           | 2          | 0–10   |
| `maxNetworkRetries`                                      | 3          | 0–10   |
| `networkRetryDelaysSeconds`（数组，1–10 项，每项 1–600） | 10, 30, 60 | —      |
| `ciPollIntervalSeconds`                                  | 30         | 5–600  |
| `ciTimeoutMinutes`                                       | 30         | 1–240  |
| `mergePollIntervalSeconds`                               | 30         | 5–600  |
| `mergeTimeoutMinutes`                                    | 10         | 1–240  |
| `turnTimeoutMinutes`                                     | 30         | 1–240  |
| `commandTimeoutMinutes`                                  | 20         | 1–240  |

除 `networkRetryDelaysSeconds`（整数数组）外全部是整数。超出范围、类型不对、或写了表里没有的字段（如 `ciChecks`，不开放），整份 `tuning` 都不用，错误里写明字段名。

- 启动时 `tuning` 不合法：报错并以退出码 2 退出。
- 运行中：每次 `step()` 开始、领单之前重新读一次配置文件里本 Project 的 `tuning`，不用重启。合法就用新值；不合法或读不到，沿用上次的值，打一行日志（同一个问题只打一次），Loop 不停。
- 一张单从领到交付用领单那一步的值，中途改文件不影响正在做的单；改动从下一次 `step()`（下一张单）起生效。多个 worker 时各自按自己那一步的值。
- 空闲间隔：`--interval` 优先，其次 `intervalSeconds`，再其次 60 秒；每次空闲等待前取当前值。
- `repoRoot`、`projectKey`、`stateDir`、`planKey`、各 agent、`workers` 运行中不重读，改了要重启。

启动时按 projectKey 调 `get_project` 解析列、标签和类型 id：列按 stateType 选，同一 stateType 有多列时按看板顺序（`unstarted` 第一列为 Todo；`started` 的第一、二、三列依次为 In Progress、In Review、Blocked）。一个 stateDir 对应一个 Project，锁在 `<stateDir>/loop.lock`。

## 约定

- 工单必须有「验收标准」列表，每条带 `验证：\`命令\``，命令只能是白名单形式；否则留言写明原因，并把工单移到 Blocked。
- 验收状态只由 Loop 跑命令后设置（`criteria.json`），会话说“完成”不算数。
- 卡住（Blocked）时保留 worktree 和会话；处理后把工单放回 Todo，会在原会话里继续（会话丢失则新开会话，凭 criteria + 进度 + git log 接手）。
- verify 防抖（CYC-438）：检查命令（测试层或验收命令）非超时失败时，先原地重跑该命令，最多 `maxVerifyRetries` 次（默认 1，0 为关闭），每次重跑记 `verify_retried` 事件（`round`、`command`、`attempt`、`passed`）。重跑通过则按通过处理，不记 `round_failed`、不扣修复轮数、不唤醒 Dev；重试用完仍失败才按原流程回 Dev。超时的命令不重跑。
- 无人值守的权限请求：基线白名单自动放行，其余留在会话里等你在桌面端批准。
- 清理（CYC-379）：每轮选单前检查已结束的 run；工单为 Done 且 PR 已合并时（调研 run 没有 PR，只看工单在 Done），删除它自己的 worktree 和本地分支。不强删：有未提交改动则只记 `cleanup_skipped_dirty` 事件留给人；不动会话和远端分支。
- 状态在 `<stateDir>/runs/<KEY>/`（run.json、criteria.json、progress.md）和 `events.jsonl`，都在 worktree 之外。

## 并发（--workers）

- 每个 Project 起 N 个 worker 循环，共用一个 `Pipeline`；名字带 `#1`、`#2`（N 为 1 时不带）。`--once`、`--dry-run` 固定 1 个 worker。`--workers` 不是正整数时以退出码 2 退出。不设硬上限，N 大于 4 时打一行警告。
- 内存：每个 worker 各占一个会话和 worktree，N 越大内存越高，目标机器是 2 核 4 GB，从 2 开始试。
- Ctrl-C：第一次表示「每个 worker 做完当前这步就退出」，不再领新单；第二次立刻退出（释放锁，进行中的 run 重启后接着走）。
- 领单互斥只在进程内；一个 stateDir 只允许一个进程（锁在 `<stateDir>/loop.lock`），不要对同一个 stateDir 起第二个进程。

## 工单上的 Loop 阶段字段

Loop 推进一张工单时，把当前阶段和进入时间写进工单的两个自定义字段，让看板上能看出 In Progress 的工单走到了哪一步。字段由人在 itsaplan 里建（Loop 不自动建），启动时按名字解析字段 id 和选项 id（`list_custom_fields`），不写死：

- 「Loop 阶段」：单选，选项 开发、验证、QA、等 CI、评审、等合并；可选再加 调研、调研 QA（没有这两个选项时，调研的阶段不写）。
- 「Loop 阶段开始于」：日期时间。

阶段对应：`claimed`、`dev` → 开发；`verify` → 验证；`qa` → QA；`delivering`、`ci` → 等 CI；`review`（独立评审）→ 评审；评审结论为合并、开启自动合并后等合并 → 等合并；调研 run 的 `claimed`、`research` → 调研，`research_qa`、`publishing` → 调研 QA；`done`、转 Blocked → 两个字段都清空。阶段没变时不重复写。

**字段是尽力而为的镜像，真实状态以 run 记录为准，字段偶尔过时是接受的**（看板上看写入时间就知道新不新）：

- 同一张工单的写入排成一个队列，一个写完才写下一个，所以不会乱序；推进不等队列，只有交付和转 Blocked 时等清空最多 10 秒，超时就接着走。
- 写失败不重试，同一次运行里每种失败只记一条日志和一条 `phase_field_failed` 事件，下一次阶段变化再写。每个请求限时 10 秒。
- 「阶段开始于」写的是写入那一刻的时间；进程重启后续跑，是续跑时的时间。「等合并」没有对应的 run 阶段，在等合并期间重启，续跑后字段会显示「评审」。
- 启动时 `list_custom_fields` 失败，或字段有问题（缺字段、缺选项、类型不对、限定了工单类型、同名多个），打一行警告说明原因，整个运行期间不写字段，Loop 照常工作。

## 调研工单（Research，CYC-447）

默认关闭，关闭时 Loop 的行为和以前完全一样。

**开启**：在配置文件的 Project 里写

```json
"research": { "enabled": true }
```

可选字段：`type`（类型名，默认 `Research`）、`folder`（放报告的文档目录标题，按标题精确匹配，默认 `调研`）、`readRoots`（会话除自己的 worktree 外还能读的目录，绝对路径或 `~` 开头，默认 `[repoRoot]`）、`maxFollowups`（后续工单上限，默认 5）。多写字段报错。开启后启动时解析 Research 类型、第一个 `stateType: backlog` 的列和「调研」目录，缺任何一样就拒绝启动并说明是哪个 Project 缺了什么。改了要重启。

开启后，Todo 里打了 `auto` 的 Research 叶子工单和 Feature、Bug 一起排队（先优先级，再创建时间）。预检要求：「要回答的问题」是编号列表（1 到 `maxCriteria` 条）、「方法与范围」「产出形式」有内容、「结论」还没写（不存在、空、或只有「（做完后回填）」这类占位）。

**流程**（run 的阶段 `claimed` → `research` → `research_qa` → `publishing` → `done`）：

1. 领单：`git fetch`，让 daemon 建 worktree（`auto/cyc-<n>`，基于 `origin/main`）和调研会话「[CYC-n] Research」。不跑 `bun install`。
2. 调研：会话最后一条回复必须带 `<summary>`、`<report>`（每个问题一节「## 问题 N」）和 0 到 `maxFollowups` 个 `<followup type="Feature|Bug" title="...">`。Loop 按规则检查（块齐全、摘要不超过 600 字、每个问题有一节、后续工单按自己的类型过预检……），不合格的作为 findings 退回同一个会话，占一个修复轮次。
3. QA：独立的只读会话「[CYC-n] Research QA」，拿到工单、报告和后续工单草稿（拿不到调研过程），核对每个问题有回答、每条回答有依据、没证实的标了「未验证」、没超出「方法与范围」，至少亲自复查 3 条依据，先写「What I checked」再给 `<verdict>`。不通过退回调研会话，占一个修复轮次；超过 `maxFixRounds` 转 Blocked。给不出可用结论时按 `maxQaRetries` 换新会话重试。
4. 发布（Loop 自己做，会话不碰 tracker）：
   0. 扫一遍摘要、报告和后续工单，有凭据形状（私钥、各家 token、Bearer、URL 里的密码、`NAME_KEY=value`）就转 Blocked，评论里只写种类，什么都不发布；
   1. 在「调研」目录下建文档「CYC-n 工单标题」，内容是报告，挂到工单上；
   2. 重读工单：「结论」还空着就换成摘要加报告标题（文档没有网页地址，报告挂在工单上），其余各节一字不动；已经有人写过就不覆盖，把摘要发成评论；
   3. 在 Backlog 一张一张建后续工单：Feature 或 Bug，有父级时挂在调研工单的父级下，不打标签、不设优先级，和调研工单建 `relates` 链接；
   4. 在调研工单上评论列出报告和后续工单，清空阶段字段，移到 Done，记 `researched` 事件。

   每一步做完马上写进 run 记录（`research` 子对象：文档 id、是否已挂、「结论」是否已处理、每张后续工单的 id 和是否已链接、是否已评论），重启后从没做完的那一步接着做，不重复建文档或工单。唯一的窗口：建好一张工单、还没存下它的 id 时进程被杀，重启后这张会再建一次。

**Blocked 和放回 Todo**：和开发工单一样，评论里指向调研会话。放回后在原会话里接着做：卡在调研或 QA 修复轮次用完的，带着最后的 findings 回到调研；会话改了工作区的，从卡住的那一步接着做；卡在发布（凭据）的，回到调研会话，让它去掉凭据后重写（原样再发布只会再卡住）。放回时修复轮次重新计数。关掉 `research.enabled` 时，进行中的调研 run 留在 stateDir 里不动，打开后接着做。

**权限边界**：两个会话（角色 `research`、`research_qa`）只读，Loop 对越界请求一律直接拒绝（deny），不停下来等人：

- 能读 worktree 和 `readRoots` 里的文件，但不管在哪都不能读 `.env*`、`*.pem`、`*.key`、`id_*`、`.netrc`、`.npmrc`、`auto-loop.json`、`loop.json`、`credentials*`、`*.secret*` 和任何 `.git` 下的 `config`；
- 命令只有原有只读命令、git 读命令，加 `du`、`find`（不带 `-exec`、`-delete`、`-fprint*` 等）、`stat`、`file`；递归 `grep`、让 `rg` 读被忽略或隐藏文件的参数、不带引号的通配符都会被拒；
- 写、删、移动、联网、MCP 工具，一律拒绝。会话拿不到 planKey，文档和工单都由 Loop 写。
- 调研 run 不提交、不 push、不开 PR、不跑 CI；Done 后清理时不查 PR，只删 worktree 和本地分支。
- 已知的缺口：Claude Code 在工作目录内的读取可能不发权限请求；文件黑名单只认字面路径。所以发布前的凭据扫描是最后一道。

## 网络错误（CYC-444）

访问 GitHub 的命令（`git fetch`、`git push`、`gh pr create` / `edit` / `view` / `comment` / `merge`、`gh run rerun`，包括读 PR 状态、读 CI 状态和等 CI 时的每一次轮询）失败时，先按输出判断是不是网络类错误（`src/network.ts`）：`Could not resolve host`、`Connection reset` / `refused` / `timed out`、`TLS handshake timeout`、`unable to access`、`i/o timeout`、`unexpected EOF`、HTTP 502/503/504，以及命令本身超时。权限、认证（401/403/404）、HTTP 400/422/429、SSL 证书、代理错误、找不到分支、合并冲突、推送被拒绝**不算**网络错误，照旧转 Blocked。

- 网络类错误：原地重试，最多 3 次（`maxNetworkRetries`），间隔 10、30、60 秒（`networkRetryDelaysSeconds`），都可在 `tuning` 里调。每次重试记一条 `network_retry` 事件（命令名、第几次、这次是否不再是网络错误），不记命令输出。等 CI 时只重试那一次轮询，不重置 CI 超时。`gh run rerun` 不原地重试（怕重复触发），遇网络错误直接等待，下一步重新读 CI 状态后再决定。
- 重试用完仍是网络错误：不转 Blocked、不评论、不移列，这次 `step()` 返回 `network_wait`，记一条 `network_down` 事件。run 留在原阶段，Loop 等一个间隔（`--interval`）后再 `step()`；续跑规则会先接着做这张单。网络一直不通时每个间隔都会记一条 `network_down`，没有上限。
- 已知的取舍：交付阶段（`delivering`）等待后按续跑规则回到 verify 再走 QA；评审阶段等待后评审会重来；`--workers N` 时等待期间别的 worker 仍可领新单；`--once` 遇到 `network_wait` 就以该结果结束。
- itsaplan 调用和 agent 会话的断连不在这里处理。

## 安装依赖的真实磁盘占用（CYC-448）

`du` 量出每个 worktree 的 `node_modules` 约 1.4G，但 macOS APFS 上 bun 可能用 clonefile，`du` 会把共享块重复计算；inode 不同且 links=1 既符合克隆也符合真复制，只读手段分不出来。所以改成测卷：

- 方法：`bun install` 前后各跑一次 `df -k <worktree>`，取"可用块数"（1 KiB 为单位），差值写进一条 `install_measured` 事件：`measured`、`freeKbBefore`、`freeKbAfter`、`usedKb`。事件里只有数字，没有路径和命令输出。
- 测量失败（`df` 不可用、输出读不出）只记 `{ measured: false }`，不阻断 `bun install` 和后续流程。
- 局限：差值是整个卷的变化，同卷上有别的写入时会有噪声；看多次的 `usedKb` 取低值。
- 结论：测量结果要在 Loop 实际跑过几张单之后，从 `events.jsonl` 里读 `usedKb`。`usedKb` 明显小于 `du` 的 1.4G，说明已经在克隆；接近 1.4G，才把 `bunfig.toml` 的 `[install] backend` 固定为 `clonefile`（bun 在 macOS 上默认就是 clonefile，固定只在默认被改动或回退到复制时才有意义）。在拿到数据前不改 `bunfig.toml`，也不做 worktree 共享 `node_modules`。
