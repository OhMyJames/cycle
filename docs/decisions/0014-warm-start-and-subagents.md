# 0014 新 session 提前起进程;子 agent 只做通告

状态:已接受(2026-11-18)

## 背景

两处缺口都来自同一个事实:Claude 的进程要到第一个 prompt 才起(决策 0007)。

1. 斜杠命令列表由进程回答(`supportedCommands()`),所以新 session 在第一条消息之前没有命令可补全。
2. 模型用 Agent 工具起的子 agent,SDK 以 `system/task_*` 消息报告;ACP v2 有 `subagent_update` 对应,但它描述的是一个有自己 session id 的子 session。

## 决定

### 提前起进程

- 适配的配置里加 `warmStart`(默认关,桌面端的 daemon 开)。开了以后,`session/new` 立即起进程,命令列表随即以 `available_commands_update` 发出;这个进程就是第一个 prompt 用的那个。
- 代价:每个新 session 在 `idleMs`(默认 5 分钟)内占一个进程(约 230 MB)。没人发 prompt 的话,到时间就和任何空闲进程一样被释放,下一个 prompt 再起(并多一次启动,约 1.5 秒)。在 2 核 4 GB 的机器上这是有意的取舍;同时新建很多 session 的用法不在 v1 的预期里。
- 进程起来时 SDK 的 `init` 消息不再被当作"session 已存在于磁盘"的证据,除非有 turn 在跑;一个成功结束的 turn 才一定算数:没有 prompt 的进程没有写下 transcript,恢复它会失败。
- 同时"提前起、还没有 prompt"的进程最多 `maxWarm`(默认 3)个:再多一个,最老的被释放。桌面端 daemon 的 `config.json` 里 `claude.warmStart`(默认开)可以关掉。
- 恢复已有的 session 不提前起:命令列表在日志里,重放时就到了。

### 子 agent:只通告,不转发它的对话

- `task_started`、`task_progress`、`task_notification`、`task_updated` 转成 `subagent_update`。子的 `sessionId` 是 SDK 的 `task_id`;`title` 是任务描述,`description` 是子 agent 的类型,`state` 是 `running`,结束时是 `idle` 加 `stopReason`(`end_turn`、`cancelled`,失败为 `error` 带原因)。
- `_meta["cycle/subagent"]`:`toolCallId`(起它的 tool call,界面可据此挂在那一行下)、`background`、`parentId`、`summary`(模型生成的一行进度:SDK 每条要一次模型调用,所以由适配的 `progressSummaries` 开关控制,桌面端 daemon 的 `config.json` 里 `claude.progressSummaries` 默认开)、`lastTool`、`usage`(`tokens`、`toolUses`、`durationMs`)。
- **不转发子 agent 的对话**:没有 `capabilities`,客户端不能把它当 session 打开(daemon 只管理自己创建的 session,决策 0006)。
- 不是子 agent 的任务不通告:后台 shell、监视器、`ambient` 或 `skip_transcript` 的任务。没通告过的任务的进度也不发。
- 进程被释放或退出时,还在跑的子 agent 以 `cancelled` 结束,界面不会一直显示"进行中"。

### 空白页的待命进程(CYC-294)

空白页要到第一条消息才建 session,按 session 提前起的做法帮不上。适配进程的启动与 `initialize`(agy 前端约 126 MB)和 cwd、MCP、环境无关的 agent,在定义里声明 `standby`:客户端在空白页选中它时发 `_cycle/agent_setup/prewarm`,daemon 起好并初始化一个待命的(每个 agent 一个),下一个 session 接手,接手后的 `session/new` 照常走。5 分钟没人接手、账号或运行时设置变了、daemon 停止时释放。目前只有 agy 声明。

## 为什么不是别的

- 一律提前起(不做开关):测试和没有命令补全需求的用法要为此付进程;做成开关,代价由用的人决定。
- 用一份固定的命令列表代替进程的回答:内置命令、技能、MCP 的命令随项目不同,固定列表会错。
- 把子 agent 做成真的子 session:要转发它的事件、让客户端能打开和取消它,是另一个量级的工作,放到有界面需要时再做;通告已经能让界面画出"有 3 个子 agent 在跑,各自在做什么"。
