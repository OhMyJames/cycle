# auto-loop

自动化闭环（CYC-318 / CYC-331 / CYC-332）：从 itsaplan 的 Todo 列取一张带 `auto` 标签的 Feature/Bug 叶子工单（无子任务；开启后也取 Research 工单，见「调研工单」），在 Cycle 里开 Dev 会话（独立 worktree），由代码跑验证，再开独立 QA 会话审查，通过后推分支、开带 `Closes CYC-<num>` 的 PR，等待 `check`、`browser`、`integration` 三项 CI 跑完；任一 CI 为红则拉取失败日志打回 Dev 修复并重推同一分支（重试超限则 Blocked）；CI 全绿后启动独立只读评审会话按根目录 `REVIEW.md` 评审，必须给出三种结论之一并写成 PR 评论：合并（`merge`，且 CI 全绿时开启 GitHub 自动合并 squash）、拒绝（`reject`，带评审意见打回 Dev 修改并重跑 CI 与评审，超修复轮数上限则升级给人）、升级给人（`escalate`，不开自动合并并将工单移入 In Review）；若评审会话失败、超时、异常结束、输出无法解析或通过未写检查清单，先重试（有次数上限），重试用完仍无结论才升级给人并写明这是评审系统故障而非代码问题。

## 运行

```sh
# 配置只有一个文件 loop.json（权限须为 0600，默认 ~/.cycle/loop.json，或 --config <路径>），server 和本 CLI 读同一份；
#   Project 条目 = server 的字段（name、projectKey、repo、token）+ 流水线字段：
#   { "projects": [ { "name": "Cycle", "projectKey": "CYC", "repo": {…}, "token": "...",
#       "repoRoot": "/abs/repo", "stateDir": "/abs/state", "planKey": "..." }, {…} ] }
#   缺 repoRoot、stateDir、planKey 之一则启动失败并说明缺什么；不再读 auto-loop.json
# 多个 Project 即 projects 里多个条目，一个进程各跑各的循环，一个卡住不影响另一个；
#   每个 Project 的 stateDir 必须不同（相同则启动报错），锁各在自己的 <stateDir>/loop.lock
# planKey 只给 Loop 本身，不会传给任何会话或命令
bun cloud/loop/src/pipeline-cli.ts --dry-run   # 只挑单、预检、打印，不写任何东西
bun cloud/loop/src/pipeline-cli.ts --once      # 处理一张
bun cloud/loop/src/pipeline-cli.ts --workers 2 # 每个 Project 起 2 个 worker 并发（见下）
bun cloud/loop/src/pipeline-cli.ts             # 常驻，空闲时每 60 秒看一次（`--interval` 或配置文件 `tuning.intervalSeconds` 改）
bun cloud/loop/src/pipeline-cli.ts stats       # 自主完成率（只算 Loop 自己开启自动合并并确认合并、且没人介入的）、autoMerged、介入率、返工率；`firstPassRate`（零介入零返工自动合并占比）、`reworkByStage`（`round_failed` 按紧邻前一事件归到 verify/qa/ci/review/other，含次数与 run 数）、`durationMs`（已交付 run 从 claimed 到 delivered 的中位数与 P90，nearest-rank）；以上都只算开发 run（按每个 run 第一个 `claimed` 事件的 `runKind` 分，没有的算开发），调研 run 只计 `researched`（发布并移到 Done 的个数）；另有 `permissions`（含调研会话）：被留给人或被拒的权限请求，按「种类 + 命令前两个词」统计，列出被人允许最多的前 10 项及各自被允许、被拒绝的次数（事件 `permission_requested`、`permission_answered`，只记命令前两个词）
```

前提：Cycle daemon 在运行（`$CYCLE_HOME/daemon.sock`），`agy` 与 `claude` 已登录，`gh` 已登录，能推 `origin`。

配置文件可选字段：`planUrl`、`autoLabel`（默认 `auto`）、`featureType`、`bugType`（默认 `Feature`、`Bug`，按名字在 `get_project` 里找类型 id）、`devAgent`、`qaAgent`、`reviewAgent`（默认 `claude`）。`devModel`、`qaModel`、`reviewModel`、`devEffort`、`qaEffort`、`reviewEffort`（可选，非空字符串）：按角色指定会话的模型和思考强度，创建会话后通过 `setConfig` 设置；省略表示沿用 agent 默认配置，空白串校验失败。必填项缺失时启动报错并指出缺哪一项。不再读 `AUTO_LOOP_*` 环境变量；`CYCLE_HOME`、`CYCLE_SOCKET` 仍用于找 daemon。`workers`（正整数，可选）：该 Project 的 worker 数，命令行 `--workers N` 优先，都没有为 1；写错时启动报错并指出是哪个 Project。改配置后重启生效。

## 把旧状态导入 SQLite（CYC-476）

stateDir 里有 `loop.db` 就读写 SQLite，没有就读写文件（`runs/`、`events.jsonl`、`plans/`）。切换方式：合并后**重启一次 Loop**，不用停机等 run 做完。**切换前先备份整个 stateDir**。

启动时先拿 `<stateDir>/loop.lock`，再选存储；`loop.db` 不存在而 `runs/` 或 `events.jsonl` 存在时导入（`--dry-run` 不导入）：

1. 用文件算一份 `stats`；
2. 在 `loop.db.importing` 里建表，把 `runs/*/run.json`（按现有 schema 和旧默认值）、`criteria.json`、`progress.md`、`events.jsonl`（丢掉末尾半行）、`plans/` 在一个事务里写入；
3. 用 SQLite 算 `stats`，逐字段比较，并把 run、进度、验收标准、规划记录读回来和文件比；
4. 全部一致：`loop.db.importing` 改名为 `loop.db`，`runs`、`events.jsonl`、`plans` 改名为 `*.imported-<日期>`（不删），写一条 `storage_imported` 事件，照常启动；规划轮次的 `bodies/` 会复制回新的 `plans/`；
5. 不一致或任何一步出错：删掉 `loop.db.importing`，旧文件不动，进程以非零退出码退出，日志写明哪一项不同。修好原因（或把坏文件挪走）后再启动即可。

进行中的 run 也能导入：拿到锁之后、第一个 step 之前没有 step 在处理 run，导入后从 SQLite 读出并续跑。`pipeline-cli.ts stats` 同样是有 `loop.db` 读 SQLite，否则读文件。

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
| `trackerTimeoutSeconds`（itsaplan 每个请求的超时）       | 30         | 5–120  |
| `releaseNodeModules`（布尔，见下）                       | false      | —      |
| `blockedReminderDays`（Blocked 多少天后提醒，0 为关闭）  | 7          | 0–365  |

除 `networkRetryDelaysSeconds`（整数数组）和 `releaseNodeModules`（布尔）外全部是整数。超出范围、类型不对、或写了表里没有的字段（如 `ciChecks`，不开放），整份 `tuning` 都不用，错误里写明字段名。

**`releaseNodeModules`（CYC-450）**：默认关。打开后，进入等 CI 时删除该 worktree 里被 git 忽略、名为 `node_modules` 的目录（约 1.4G），写事件 `node_modules_released`。只有 worktree 没有未提交改动时才删，否则写 `node_modules_kept`（带原因，每个 run、每轮 CI、每种原因只写一次）并保留；删除只用 `rm -rf` 删这些目录，不碰其他文件；`rm` 失败写 `node_modules_release_failed`，run 照常继续，但已记为「已释放」，下次进入 Dev 或 verify 前会重装。只在等 CI 时释放，不在开启自动合并后的等合并阶段再释放：CI 前已经释放过，那一步只在上次没释放成功时才有用，不值得让已开启自动合并的 review 步骤冒失败的风险。回到 Dev 或进入 verify 前先 `bun install`（写 `node_modules_restored`），安装失败走现有 Blocked 路径。例外：Dev 处理合并冲突那一轮不先装（冲突中的 `package.json` 或 `bun.lock` 会让安装失败或改写锁文件），冲突简报会告诉 Dev 依赖未安装，解决清单文件后自己 `bun install`；之后进 verify 时仍会按记录重装。等 CI 的阶段不跑依赖本地 `node_modules` 的命令；独立评审会话只读，`REVIEW.md` 不要求它跑 `bun`。

- 启动时 `tuning` 不合法：报错并以退出码 2 退出。
- 运行中：每次 `step()` 开始、领单之前重新读一次配置文件里本 Project 的 `tuning`，不用重启。合法就用新值；不合法或读不到，沿用上次的值，打一行日志（同一个问题只打一次），Loop 不停。
- 一张单从领到交付用领单那一步的值，中途改文件不影响正在做的单；改动从下一次 `step()`（下一张单）起生效。多个 worker 时各自按自己那一步的值。
- 空闲间隔：`--interval` 优先，其次 `intervalSeconds`，再其次 60 秒；每次空闲等待前取当前值。
- `repoRoot`、`projectKey`、`stateDir`、`planKey`、各 agent、`workers` 运行中不重读，改了要重启。

启动时按 projectKey 调 `get_project` 解析列、标签和类型 id：列按 stateType 选，同一 stateType 有多列时按看板顺序（`unstarted` 第一列为 Todo；`started` 的第一、二、三列依次为 In Progress、In Review、Blocked）。一个 stateDir 对应一个 Project，锁在 `<stateDir>/loop.lock`。

## 约定

- 工单必须有「验收标准」列表，每条带 `验证：\`命令\``，命令只能是白名单形式；否则留言写明原因，并把工单移到 Blocked。
- 大档（CYC-328）：带 `完整流程` 标签的工单不看描述，看它关联的四份文档，标题须为 `[CYC-<num>] Intent`、`Spec`、`Design`、`Plan`，每份恰好一份、未归档、已锁定（锁定即已采纳）；验收标准取自 Spec 的「验收标准」列表（规则同描述）。缺一份、未锁定、标题前缀不符或 Spec 的标准不合格：不领单，留言以 `[Blocked:需规格]` 开头，工单转 Blocked。领单时把四份文档的 version 记进 run.json（`fullFlowDocs`）；运行中每个阶段开始前重读，version 变了、被取消锁定或不再关联，转 Blocked（同样标 `[Blocked:需规格]`）。人确认后把文档重新锁定并放回 Todo，Loop 以当时的版本为新基线（事件 `docs_rebaselined`）继续。大档的 PR 正文有「依据文档」一节，列四份文档的标题和链接 `<planUrl 的 origin>/<团队>/<项目>/docs/<documentId>`（团队和项目取自 `projectKey`，如 `infra.CYC`）；`projectKey` 不带团队前缀时只列标题，不编造地址（CYC-454）。不带标签的工单行为不变。
- 验收状态只由 Loop 跑命令后设置（`criteria.json`），会话说“完成”不算数。
- 卡住（Blocked）时保留 worktree 和会话；处理后把工单放回 Todo，会在原会话里继续（会话丢失则新开会话，凭 criteria + 进度 + git log 接手）。
- verify 防抖（CYC-438）：检查命令（测试层或验收命令）非超时失败时，先原地重跑该命令，最多 `maxVerifyRetries` 次（默认 1，0 为关闭），每次重跑记 `verify_retried` 事件（`round`、`command`、`attempt`、`passed`）。重跑通过则按通过处理，不记 `round_failed`、不扣修复轮数、不唤醒 Dev；重试用完仍失败才按原流程回 Dev。超时的命令不重跑。
- 无人值守的权限请求：基线白名单自动放行，其余留在会话里等你在桌面端批准。
- 清理（CYC-379、CYC-449）：每轮选单前检查 Done 和 Blocked 的 run（正在被某个 step 处理的不动）。工单为 Done 且 PR 已合并（调研 run 没有 PR，只看工单在 Done），或工单在 Canceled 时，删除它自己的 worktree 和本地分支。不强删：有未提交改动则只记一次 `cleanup_skipped_dirty` 事件留给人；不动会话和远端分支，不动人手工开的 worktree。Done 但 PR 被关闭未合并：记一次 `cleanup_skipped_unmerged`，不删。Blocked 超过 `blockedReminderDays`（按最后一次写 run 的时间算）：记一次 `blocked_stale` 事件，只提醒不删；放回 Todo 后重新计时。
- 状态在 `<stateDir>/runs/<KEY>/`（run.json、criteria.json、progress.md）和 `events.jsonl`，都在 worktree 之外。

## 并发（--workers）

- 每个 Project 起 N 个 worker 循环，共用一个 `Pipeline`；名字带 `#1`、`#2`（N 为 1 时不带）。`--once`、`--dry-run` 固定 1 个 worker。`--workers` 不是正整数时以退出码 2 退出。不设硬上限，N 大于 4 时打一行警告。
- 内存：每个 worker 各占一个会话和 worktree，N 越大内存越高，目标机器是 2 核 4 GB，从 2 开始试。
- Ctrl-C：第一次表示「每个 worker 做完当前这步就退出」，不再领新单；第二次立刻退出（释放锁，进行中的 run 重启后接着走）。
- 领单互斥只在进程内；一个 stateDir 只允许一个进程（锁在 `<stateDir>/loop.lock`），不要对同一个 stateDir 起第二个进程。

## 工单上的 Loop 阶段字段

Loop 推进一张工单时，把当前阶段和进入时间写进工单的两个自定义字段，让看板上能看出 In Progress 的工单走到了哪一步。字段由人在 itsaplan 里建（Loop 不自动建），启动时按名字解析字段 id 和选项 id（`list_custom_fields`），不写死：

- 「Loop 阶段」：单选，选项 开发、验证、QA、等 CI、评审、等合并；可选再加 调研、调研 QA（没有这两个选项时，调研的阶段不写），以及 规划、规划 QA（没有时，规划节点加工中的工单不写）。
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

## 规划节点（CYC-322）

默认关闭，关闭时 Loop 的行为和以前完全一样（不读 Backlog、不碰 `plans/`）。Todo 里没有能领的单时，规划节点把 Backlog 里的 Feature、Bug 整理成人能直接批准的样子，留在 Backlog 打上「待批准」，等人在 Loop 页面批准。它**不移列、不打 `auto`、不进 Blocked**，只通过 `PlanningTracker`（类型上没有移列和任意标签）写 tracker。

**开启**：在配置文件的 Project 里写 `"planning": { "enabled": true }`。可选字段：`pending`、`awaitingAnswer`、`skip`、`fullProcess`（四个标签名，默认 `待批准`、`待回答`、`Loop 跳过`、`完整流程`）、`maxPending`（默认 5）、`intervalMinutes`（默认 30）、`maxSplit`（默认 4）、`checkMinutes`（多久看一次 Backlog 有没有变，1 到 60，默认 5）。启动时解析标签、Backlog 列、Epic 类型和 Feature、Bug 的模板，缺了就拒绝启动。

**什么时候开一轮**：worker 空闲、Todo 那边没有能领的（Todo 先问，人已批准的活优先）、Backlog 里带「待批准」的少于 `maxPending`、没有别的一轮在跑（一次一轮），并且距上一轮结束满 `intervalMinutes`，或者 Backlog 从上一轮结束后变了。

看 Backlog 的开销是有上限的：

- 同一个 Project 的所有 worker 加起来，最多每 `checkMinutes` 看一次；上次看的时间记在 `<stateDir>/plans/index.json`，不是每个 worker 各记各的。没到时间的空闲 step 不读 tracker。
- 看一次是**一个** `list_issues` 调用（`listBacklogRows`），用它返回的每行的标题、标签、类型、列和 `updatedAt`，不逐张读全文。改标题、正文、标签、优先级、列都会改 `updatedAt`；**评论不会**（2026-11-26 在 infra.CYC 上核对过：CYC-320 的评论晚于它的 `updatedAt`）。所以只有每一行都和上次一样时，才逐张读「可能成为候选」的那些工单的评论（`watchedRows`），读到第一张有新评论就停。
- 比较的基准（每行的签名、各工单的最新评论时间，`takeSnapshot`）在一轮**自己的写入之后**才取，所以规划节点自己发的评论、打的标签不会让下一轮马上又开。
- 要开一轮时才逐张读全文选候选。一张候选都没有时**不建这一轮**（不留 `plans/<id>` 目录），只在索引里记下结束时间和基准，下一次照样按间隔来。
- 空闲 step 不读任何过去的一轮：没结束的一轮的 id、上一轮的结束时间和基准、没删掉的 worktree 都在 `plans/index.json` 里。

**一轮**是一个 `plan` 种类的 run，不属于某张工单：记录在 `<stateDir>/plans/<开始时间>/run.json`，事件的 `run` 是 `plan-<开始时间>`，涉及某张工单的事件另带 `issue: "CYC-n"`。阶段 `triage → shaping(i) → shape_qa(i) → writing(i) → … → finished`：

1. 筛候选（`candidates`）：Backlog 里的 Feature、Bug 叶子，去掉带 `auto`、待批准、待回答、Loop 跳过、完整流程的，去掉上一轮归为「不适合」或加工停下、之后没改过也没新评论的。一张都没有就不开这一轮（见上）。
2. `git fetch`（和其他 run 共用仓库锁），`git worktree add --detach <repoRoot>/.agents/worktree/plan-<开始时间> origin/main`：不建分支、不跑 `bun install`。每张候选的全文写到 `plans/<id>/bodies/CYC-n.md`，这个目录加进三个会话的 `readRoots`（另加 `research.readRoots`，有的话）。
3. 盘点会话（角色 `triage`，只读）：候选摘要表（编号、标题、类型、优先级、父级、链接、首段、长度）和看板全局（Todo、In Progress、待批准的标题，Epic 的标题和首段）。回复按 `checkTriage` 检查，不合格退回同一会话，最多 `maxFixRounds` 轮；用完、会话出错或改了 worktree，这一轮结束（`plan_stopped`），什么都不写。
4. 写回盘点：优先级变了的，先发评论写原值、新值和理由，再改优先级；「要问」的发评论列出问题，打「待回答」；「不适合」只记进 `plans/memory.json`，不写工单。
5. 加工队列：盘点给的顺序，取前（`maxPending` − 现有待批准数）张，一张一张做：
   - 加工会话（`shape`）拿到工单全文和评论、父级、链接和同级、该类型的模板、工单规范里「标题」「正文」「拆分一张工单」三节（从这一轮 worktree 的 `.claude/skills/cycle-workflow/SKILL.md` 读）、允许的命令和界面现象的写法、盘点理由；CYC 项目里还附上 CYC-443 作为写法范例（读不到就不附；范例里 `bun test <路径>` 补成 `./` 开头）。回复是改写、拆分或问题之一；问题按「要问」处理，不进 QA。
   - `checkShape`（预检、`bun test ./路径` 在这一轮 worktree 里存在、集成套件存在、标题、长度、拆分份数）不过就退回同一会话，占一个修复轮次。
   - QA 会话（`shape_qa`）只拿原文、评论和结果，先写「What I checked」再给 `<verdict>`；不通过退回加工会话，占一个修复轮次；给不出可用结论时按 `maxQaRetries` 换新会话。
   - 超过 `maxFixRounds`、会话出错、会话改了 worktree、发现凭据：这张**停下**，发一条评论说原因（有凭据时只写种类），记进 memory，之后标题、正文、评论都没变就不再加工；接着做下一张。
6. 写回（每步做完马上存进这一轮的记录，重启后从没做完的一步接着做）：0）扫一遍要写的全部文字，有凭据形状就停下；1）重读，标题或正文和开始加工时的哈希不同、已不在 Backlog、或已有「Loop 跳过」，就放弃这张（`plan_abandoned`），什么都不写；2）评论「加工前的工单」保存原标题和原正文；3）改写：换标题和正文。拆分：有父级时原工单换成第一份，其余各份建成同一父级下的兄弟；没有父级时原工单改成 Epic（类型、标题、正文），所有份都建成它的子工单；新建的在 Backlog、优先级继承原工单，按顺序用 `blocks` 连起来；4）评论，第一行固定是「Loop 规划」，下面是说明、盘点理由，拆分时列出各张；5）给要等批准的每张打「待批准」（改写的那张，或拆出的每一份，Epic 不打）。
7. 结束：memory 里记下每张候选的归类、标题和正文的哈希、最新评论时间、是否停下（都在这一轮写完之后读），在索引里存下 Backlog 的基准，删掉 worktree（`--force`：它是这一轮自己的、只读的，没有人的改动）。删不掉的记进索引，之后 `#cleanup` 再删。

加工中的工单写阶段字段「规划」「规划 QA」（项目里有这两个选项才写），写回、放弃或停下时清空；盘点不写字段。

**续跑**：重启后没结束的一轮总是接着做（在 Todo 之后问到时），工单级的检查在写回第 1 步。评论只在工单上还没有同样文字时才发；拆分建第 k 份前先在记录里写下「准备建第 k 份」，重启后先在 Backlog 里按「父级 + 标题」找，找到就补记，找不到才建。

**规划和开发不撞位置**：一轮的记录在 `plans/`，开发和调研在 `runs/`；worktree 是 `plan-<开始时间>`，开发是 `auto/cyc-n`。人批准（移到 Todo、打 `auto`）后，开发 run 照常领单。

**事件**（不记正文）：`plan_started`（候选数）、`plan_triaged`（候选数，`can`、`ask`、`split`、`unfit` 各几张，`queued`）、`plan_priority_changed`（`from`、`to`）、`plan_asked`（问题数）、`plan_shaped`（`form`：rewrite 或 split，`parts`、`rounds`，`keys`：等批准的各张）、`plan_shape_stopped`、`plan_abandoned`（`why`：edited、moved、skip、pending、gone）、`plan_finished`（`outcome`，各状态张数）；另有 `triage_turn`、`shape_turn`、`shape_qa_turn`、`qa_retry`、`secrets_found`、`recovered`。

**stats** 的 `planning` 一节单独计：轮数、盘点停下的轮数、各归类张数、改优先级和提问的次数、加工、停下、放弃的张数、平均修复轮次，以及批准率：加工后等批准的各张里，后来被开发 run 领走（有 `claimed` 事件）的比例。只看事件：已批准但还没被领走的算作还没批准。

## 网络错误（CYC-444）

访问 GitHub 的命令（`git fetch`、`git push`、`gh pr create` / `edit` / `view` / `comment` / `merge`、`gh run rerun`，包括读 PR 状态、读 CI 状态和等 CI 时的每一次轮询）失败时，先按输出判断是不是网络类错误（`src/network.ts`）：`Could not resolve host`、`Connection reset` / `refused` / `timed out`、`TLS handshake timeout`、`unable to access`、`i/o timeout`、`unexpected EOF`、HTTP 502/503/504，以及命令本身超时。权限、认证（401/403/404）、HTTP 400/422/429、SSL 证书、代理错误、找不到分支、合并冲突、推送被拒绝**不算**网络错误，照旧转 Blocked。

- 网络类错误：原地重试，最多 3 次（`maxNetworkRetries`），间隔 10、30、60 秒（`networkRetryDelaysSeconds`），都可在 `tuning` 里调。每次重试记一条 `network_retry` 事件（命令名、第几次、这次是否不再是网络错误），不记命令输出。等 CI 时只重试那一次轮询，不重置 CI 超时。`gh run rerun` 不原地重试（怕重复触发），遇网络错误直接等待，下一步重新读 CI 状态后再决定。
- 重试用完仍是网络错误：不转 Blocked、不评论、不移列，这次 `step()` 返回 `network_wait`，记一条 `network_down` 事件。run 留在原阶段，Loop 等一个间隔（`--interval`）后再 `step()`；续跑规则会先接着做这张单。网络一直不通时每个间隔都会记一条 `network_down`，没有上限。
- 已知的取舍：交付阶段（`delivering`）等待后按续跑规则回到 verify 再走 QA；评审阶段等待后评审会重来；`--workers N` 时等待期间别的 worker 仍可领新单；`--once` 遇到 `network_wait` 就以该结果结束。
- itsaplan 调用和 agent 会话的断连不在这里处理。

## 安装依赖的真实磁盘占用（CYC-448）

`du` 量出每个 worktree 的 `node_modules` 约 1.4G，但 macOS APFS 上 bun 可能用 clonefile，`du` 会把共享块重复计算；inode 不同且 links=1 既符合克隆也符合真复制，只读手段分不出来。所以改成测卷：

- 方法：新建 worktree 之后、`bun install` 前后各跑一次 `df -kP <worktree>`，取 Available 列（1 KiB 为单位），差值写进一条 `install_measured` 事件：`measured`（布尔）、`freeKbBefore`、`freeKbAfter`、`usedKb`（数字）。事件里没有路径和命令输出。
- 只在新建 worktree 时测。续跑（run 已有 worktree）时 `bun install` 几乎什么都不做，量出来接近 0，所以不测、不记。
- 测量失败（`df` 不可用、非零退出、输出读不出、只读到一次）、或可用块数反而变多（别的 worker 或会话在同卷释放了空间）：只记 `{ measured: false }`，不阻断 `bun install` 和后续流程。分析时丢掉 `measured: false` 的行。
- 局限：差值是整个卷的变化，同卷上别的写入（`--workers N` 的其他 worker、会话写文件）会让 `usedKb` 偏大；取多个样本里的低值，并丢掉明显偏离的。
- 结论：测量结果要在 Loop 实际跑过几张单之后，从 `events.jsonl` 里读 `usedKb`。`usedKb` 明显小于 `du` 的 1.4G，说明已经在克隆；接近 1.4G，才把 `bunfig.toml` 的 `[install] backend` 固定为 `clonefile`（bun 在 macOS 上默认就是 clonefile，固定只在默认被改动或回退到复制时才有意义）。在拿到数据前不改 `bunfig.toml`，也不做 worktree 共享 `node_modules`。
