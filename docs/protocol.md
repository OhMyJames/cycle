# 协议规范

状态:草稿 v0.1(L1 客户端到 daemon),待评审

本文定义 **L1**:Cycle 客户端和 daemon 之间的协议。L2(daemon 到 agent)直接使用 ACP v2,不在这里重述;L3 见 `docs/architecture.md`。

依据:

- 决策 [0005](decisions/0005-acp-v2.md):L1 以 ACP v2 为蓝本,字段和语义保持一致,类型由我们固定版本;Cycle 的扩展用 `_cycle/*` 和 `_meta`。
- 决策 [0002](decisions/0002-session-persistence.md):daemon 自己保存历史,JSONL 是唯一来源。
- 决策 [0006](decisions/0006-own-sessions.md):只管理 Cycle 自己的 session。
- 决策 [0004](decisions/0004-auth.md):v1 不在协议里做鉴权。

ACP 方法和类型已对照 `@agentclientprotocol/sdk` 2.7.0 的 v2 稳定版 JSON schema 核对。凡标注"待验证"的地方,还没有在真实 agent 上跑过。已验证的项标注日期和版本,验证只用了本地模拟的 Anthropic API,没有用真实模型。

## 1. 原则

1. **不重复 ACP。** ACP v2 已有的方法、通知和类型,L1 原样使用,本文只写差异。
2. **daemon 是 session 的所有者。** 客户端把 daemon 当成一个 ACP agent 来用,daemon 再去驱动真正的 agent。
3. **历史在 daemon。** 客户端看到的会话历史来自 daemon 的日志,不来自 agent 重放。
4. **协议与传输分离。** 本文只规定 JSON-RPC 消息,不规定怎么送达。

## 2. 传输与帧

- 消息格式是 JSON-RPC 2.0,UTF-8。
- 一条消息对应一个传输帧。流式传输(unix socket、stdio)上用换行分隔的 JSON,每条消息单行,不含未转义的换行。
- v1 的实现:
  - 本地:unix socket。
  - 远程:SSH 通道(`ssh host cycle proxy`,把 stdio 桥接到远端 daemon 的 socket)。
  - 以后可以换成别的远程传输(如 WebSocket):协议不依赖它,客户端用哪种传输连上 daemon,是客户端自己的配置(见 `docs/desktop.md` 的"环境")。daemon 不知道也不关心自己被当作本地还是远程。
- 一个连接对应一个客户端。daemon 同时服务多个连接。
- 连接断开不影响 session 的运行。

## 3. 版本与能力协商

连接建立后,客户端必须先发 `initialize`(ACP v2 的方法),在响应之前不得发其他请求。

- `protocolVersion`:ACP 的协议版本,整数,仅在不兼容变更时递增。
- Cycle 自己的版本放在 `_meta["cycle/protocolVersion"]`,格式 `"主.次"`,本文描述的是 `"0.2"`(`0.1` 到 `0.2` 只加了字段和 `markRead`,见 §6)。主版本不同则 daemon 以 `-32022`(ACP 的 Unsupported protocol version)拒绝,并在 `data` 里列出自己支持的版本(`supported`)和收到的(`requested`)。客户端据此知道哪一边更旧、该升级哪一边,不要只当作普通的连接错误。次版本差异通过能力协商处理。
- daemon 在 `initialize` 响应的 `_meta["cycle/capabilities"]` 中声明能力:

```json
{
  "replay": ["start", "seq"],
  "agents": ["claude"],
  "sessionOps": ["archive", "rename", "delete", "markRead", "stopSubagent"],
  "queue": true,
  "steer": true,
  "files": true,
  "folders": true,
  "filesInFolder": true,
  "fs": true,
  "diff": true,
  "trust": true,
  "connectors": true,
  "plugins": ["claude"],
  "agentSetup": true,
  "storage": true,
  "agentPrewarm": true,
  "sessionMentions": true,
  "search": true,
  "terminal": true
}
```

- **旧 daemon 的降级**:远程 daemon 可能比客户端旧。`sessionOps` 里没有 `markRead` 的 daemon,客户端不发 `_cycle/session/mark_read`;它的列表里没有 `updatedAt`、`cycle/unread`、`cycle/background`,客户端按"缺失"处理,不得报错,也不得把缺失当成 `false` 或 0 以外的意思(规则见 §6)。

- 桌面端在 `initialize` 的 `_meta["cycle/appVersion"]` 里报自己的版本(alpha 报它基于的发行版 `baseVersion`),格式 `x.y.z`,其他格式不记。daemon 把最近一次报来的写进数据目录的 `app-version`,`cycle update` 默认装这个版本。别的客户端不发。
- 客户端在 `initialize` 的 `capabilities.elicitation.form` 里声明自己能回答表单式的提问(见 §9)。不声明就不会收到 `elicitation/create`。
- 每个 agent 能收什么样的 prompt 内容、能不能带 MCP 服务器等,不在这里:daemon 的 `initialize` 不依赖具体 agent,放在 `_cycle/agents/list`(§10)。
- 客户端不认识的能力忽略。daemon 不认识的客户端能力同样忽略。
- ACP 的 `fs/*` 和 `terminal/*` 能力 v1 不支持(v2 稳定版里本来也没有 `fs/*`)。`initialize` 的客户端能力里相应字段缺省即视为不支持。

### 桌面端规划中的扩展

右侧面板、diff 视图、交互式终端、内置浏览器及 browser use、plugins 和 settings 页如需新增 L1 方法，沿用 `_cycle/*` 命名空间，在各功能工单中定义方法、参数及对应的能力声明。纯客户端交互无需增加 L1 方法。客户端只在 daemon 声明相应能力后调用新方法，旧 daemon 缺少声明时跳过调用。

此处仅预留扩展位置。终端已定义，见 §8"终端"；browser use 的权限和回传通道由 CYCL-100 决定。上面的握手示例只列已定义的能力。

## 4. ACP v2 方法在 L1 的使用

下表中"客户端 → daemon"的方法,daemon 按 `sessionId` 路由到对应 agent 并转发,除非标注"daemon 处理"。

| 方法                         | 方向            | 在 L1 的行为                                                                                                  |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `initialize`                 | 客户端 → daemon | daemon 处理,见 §3                                                                                             |
| `session/new`                | 客户端 → daemon | daemon 创建 session 并启动 agent,见 §6                                                                        |
| `session/list`               | 客户端 → daemon | daemon 处理,只返回 Cycle 自己的 session,见 §6                                                                 |
| `session/resume`             | 客户端 → daemon | daemon 处理,表示"附着并按需补发历史",见 §7                                                                    |
| `session/prompt`             | 客户端 → daemon | 转发。session 忙时入队或插入当前 turn,见 §8                                                                   |
| `_cycle/prompt/dequeue`      | 客户端 → daemon | daemon 处理:把排队的 prompt 撤回,见 §8                                                                        |
| `_cycle/files/search`        | 客户端 → daemon | daemon 处理:在 session 的 `cwd` 里找文件,见 §8                                                                |
| `_cycle/folders/list`        | 客户端 → daemon | daemon 处理:列出一个目录下的文件夹(选 `cwd` 用),见 §8                                                         |
| `_cycle/search`              | 客户端 → daemon | daemon 处理:在本机存的会话对话内容里全文搜索,返回带片段的命中,见 §8 "搜索对话内容"                            |
| `_cycle/fs/list`             | 客户端 → daemon | daemon 处理:列出 session 的 `cwd` 里一个文件夹,见 §8                                                          |
| `_cycle/fs/read`             | 客户端 → daemon | daemon 处理:读 session 的 `cwd` 里一个文件,见 §8                                                              |
| `_cycle/diff/status`         | 客户端 → daemon | daemon 处理:工作区相对 HEAD 改了哪些文件,见 §8                                                                |
| `_cycle/diff/file`           | 客户端 → daemon | daemon 处理:一个文件相对 HEAD 的补丁,见 §8                                                                    |
| `_cycle/trust/read`          | 客户端 → daemon | daemon 处理:一个文件夹是否信任,见 §8                                                                          |
| `_cycle/trust/set`           | 客户端 → daemon | daemon 处理:记下对一个文件夹的信任决定,见 §8                                                                  |
| `_cycle/providers/list`      | 客户端 → daemon | daemon 处理:主人的模型服务商和可选的服务种类,见 §10 "自带模型"                                                |
| `_cycle/providers/catalog`   | 客户端 → daemon | daemon 处理:一种已知服务已知的模型                                                                            |
| `_cycle/providers/save`      | 客户端 → daemon | daemon 处理:新增或修改一个服务商。key 只进不出                                                                |
| `_cycle/providers/remove`    | 客户端 → daemon | daemon 处理:删除一个服务商                                                                                    |
| `_cycle/plan_usage/read`     | 客户端 → daemon | daemon 处理:各 agent 账号的套餐用量,见 §8 "套餐用量"                                                          |
| `_cycle/connectors/*`        | 客户端 → daemon | daemon 处理:管理 connector 和授权,见 §14                                                                      |
| `_cycle/plugins/*`           | 客户端 → daemon | daemon 处理:浏览、安装、启停各 agent 的 plugin,见 §15                                                         |
| `_cycle/storage/*`           | 客户端 → daemon | daemon 处理:各 agent 的 HOME 里占了多少、清掉其中的缓存,见 §16 "本地存储"                                     |
| `_cycle/agent_setup/*`       | 客户端 → daemon | daemon 处理:读取 agent 状态/宿主诊断与热改运行项,见 §16                                                       |
| `_cycle/agent_auth/*`        | 客户端 → daemon | daemon 处理:发起、提交、取消订阅登录与登出,见 §16                                                             |
| `session/cancel`             | 客户端 → daemon | 转发(通知)                                                                                                    |
| `session/close`              | 客户端 → daemon | daemon 处理:停止 agent 进程,保留历史                                                                          |
| `session/delete`             | 客户端 → daemon | daemon 处理:删除日志和索引,客户端必须先向用户确认                                                             |
| `session/set_config_option`  | 客户端 → daemon | 转发,并把结果写入 session 的配置记录                                                                          |
| `tool_call/cancel`           | 客户端 → daemon | 转发                                                                                                          |
| `session/update`             | daemon → 客户端 | 转发 agent 的更新,并加上 `seq`,见 §5                                                                          |
| `session/request_permission` | daemon → 客户端 | 转发 agent 的请求,见 §9                                                                                       |
| `elicitation/create`         | daemon → 客户端 | 转发,处理方式同 §9                                                                                            |
| `auth/*`                     | —               | v1 不用 ACP 原生 `auth/*`;多 agent 订阅登录走 Cycle 自有扩展 `_cycle/agent_auth/*`(§16),不改变 ACP 会话层约定 |

`session/update` 的变体沿用 ACP v2:`user_message(_chunk)`、`agent_message(_chunk)`、`agent_thought(_chunk)`、`state_update`、`tool_call_update`、`tool_call_content_chunk`、`terminal_update`、`terminal_output_chunk`、`plan_update`、`available_commands_update`、`config_option_update`、`session_info_update`、`usage_update`、`notice`、`compaction_update`、`compaction_summary_chunk`、`replay_complete`、`subagent_update`、`session_message(_chunk)`,以及 Cycle 自己的 `_cycle/queue_update`(§8)、`_cycle/prompt_suggestion`(下一轮输入建议,§8)和 `_cycle/child_update`(子 agent 的对话,§9)。客户端遇到不认识的变体应忽略,不得报错。

v1 的 Claude 适配只需产生其中的子集,见 L3 文档(待写)。

## 5. 事件序号 `seq`

daemon 为每个 session 维护一个单调递增的整数序号,从 1 开始,**每条写入该 session 日志的记录占一个序号**。

- daemon 转发给客户端的每条 `session/update` 通知,在 `_meta["cycle/seq"]` 里带上它的序号。
- 同一条通知在 `_meta["cycle/ts"]` 里带上这条记录写进日志的时间:就是日志里那条记录的 `ts`(§12),原样照抄,ISO 8601、UTC、毫秒精度(`"2026-11-18T04:00:00.000Z"`),与 `session/list` 的 `updatedAt` 同一种写法、同一个来源。实时推送和补发带的是同一个值,所以重放看到的时间就是当时的时间。没有日志记录的合成更新(附着时的状态快照、`replay_complete`、写入失败时的 `state_update`)不带它。客户端用它显示消息何时发出、思考用了多久;没有 `cycle/ts`(旧 daemon,或合成更新)就是时间未知,客户端不得拿收到的时刻或 0 代替。
- agent 发来的请求(如权限请求)和它的响应同样占序号,见 §9。
- 序号只由 daemon 分配,agent 和客户端不得设置。
- 序号等于该记录在 JSONL 日志里的行号(从 1 开始),所以日志本身就是序号的事实来源。
- 序号不跨 session。
- 客户端看到的序号会有空洞:`meta`、`response`、`aborted` 记录不作为 `session/update` 发出。客户端不得要求序号连续,只需记住收到的最大值。

## 6. session 生命周期

### 创建

`session/new` 的参数是 ACP v2 的 `cwd`、`additionalDirectories`、`mcpServers`、`systemPrompt`,加上 Cycle 扩展:

```json
{
  "cwd": "/abs/path",
  "_meta": {
    "cycle/agent": "claude",
    "cycle/config": { "model": "...", "mode": "..." }
  }
}
```

- `additionalDirectories`、`mcpServers`、`systemPrompt` 由 daemon 校验并**保存在索引里**,agent 每次启动(新建,以及停止后的恢复)都带着它们,所以 agent 进程被释放或重启后它们仍然有效。`session/resume` 发给 agent 时 daemon 重新带上;客户端不需要重发。
  - `systemPrompt`:只支持 `mode: "append"`,内容只能是 `text` 块。`override` 以 `-32602` 拒绝:它会换掉 agent 自带的指令,包括工具的用法。
  - `mcpServers`:支持 `stdio` 和 `http`。条目里可能有密钥(`env`、`headers`),所以**只存在索引里**(目录 0700,文件 0600);不进 JSONL 日志(日志会补发给每个客户端),`session/list` 也不返回它们,`_cycle/agents/list` 不提它们。Claude 适配用 `mcpServersDelivery: "initialize"` 交给 Claude 进程,密钥不出现在命令行上。
  - `additionalDirectories`:绝对路径,在 daemon 所在的机器上;和 `cwd` 一样要求存在。
- `cycle/agent`:agent 的 id,必须在 daemon 声明的 `agents` 里。缺省时使用 daemon 的默认 agent。
- `cycle/config`:创建时的初始配置,键由该 agent 的配置 schema 决定(见 §10)。daemon 在创建日志和启动 agent 前校验显式配置。配置必须是键值均为字符串的对象；有 properties 时只接受其中的键，封闭的 enum / oneOf 只接受列出的值，带 cycle/open 的模型允许自定义字符串。失败返回 invalid_config，字段错误的 data.configId 指向该项。
- 响应是 ACP 的 `NewSessionResponse`。`sessionId` 由 daemon 分配,格式是 UUID。

**sessionId 与 agent 侧 id:能复用就复用,不能就关联。**

1. daemon 生成 `sessionId`,创建 agent 侧 session 时把它作为建议传给 agent:`session/new` 的 `_meta["cycle/sessionId"]`。
2. 如果 agent 支持采用这个 id(Claude Agent SDK 支持:`query` 的 `sessionId` 选项,要求是合法 UUID,已在 0.3.327 的类型定义里确认),它在 `NewSessionResponse` 里返回同一个 id。两者相等,daemon 不需要额外的对应关系。
3. 如果 agent 不支持,它返回自己的 id。daemon 在索引里记录 `sessionId` 到 `agentSessionId` 的对应,对客户端仍只暴露 `sessionId`。
4. 判断方式只看响应:返回的 id 等于建议的 id 就是复用,否则是关联。daemon 不需要事先知道 agent 属于哪一种。
5. 索引里始终保存 `agentSessionId`,复用时它等于 `sessionId`。daemon 对 agent 说话时一律用 `agentSessionId`。客户端不得假设两者相等。

恢复一个没有已回答回合的会话时，agent 可在 L2 应答的 `_meta["cycle/agentSessionId"]` 返回替代 ID。daemon 验证并持久化映射后才恢复设置或接受新 prompt；L1 ID 不变。已有已回答回合时禁止更换 ID。

采用 id 的好处:agent 自己的 transcript 和 Cycle 的历史用同一个 id,排查问题和以后导入导出都更直接。注意 Claude SDK 的限制:`sessionId` 不能和 `resume` 或 `continue` 同时使用,除非同时 fork。所以只在新建时传,恢复时用 `agentSessionId` 走 resume。

### 列表

`session/list` 只返回 Cycle 自己创建的 session(决策 0006)。请求的 `_meta["cycle/onlyPrompted"]` 为 `true` 时,只返回**已经收到过用户消息**的:新建 session 在客户端是一个空白对话,首条消息发出时才 `session/new` 加 `session/prompt`(`.agents/notes/2026-11-19-session-starts-at-first-message.md`),所以一个 session 从 daemon **接下**它的第一条 prompt 起才出现在这样的列表里(通过了内容检查,不论之后是直接发给 agent、排队,还是 agent 起不来而失败),此时 daemon 发 `_cycle/session_list_changed`。不带这个标记的请求(旧客户端:它们靠在列表里找到刚建的 session 来打开它)照旧列出全部。还没有用户消息的 session 仍然存在:可以 `session/resume`、`session/prompt`、删除。daemon 不会自动删除它们。历史不可用的 session(`cycle/historyFailed`,写不进去或读不了)照旧列出,好让人能删除它。

daemon 在索引里记 `prompted`;在这个规则之前写的索引条目没有它,daemon 在列表时读一次该 session 的日志(按存储的样子,不读回图片),有 `user_message` 就算,补上之后不再读。

握手能力 `cycle/capabilities.sessionListPages: true` 表示支持分页。客户端用 ACP 的 `cwd` 精确筛选工作目录，用 `_meta["cycle/page"]` 请求分页。该对象支持 `limit`（默认 50，1–200）、`agent`、`createdFrom`（含）、`createdBefore`（不含），时间使用 UTC ISO 8601，最多三位小数，与索引的毫秒精度一致。按创建时间降序，同一时间按 sessionId 升序扫描；显示仍按活动时间排序。每页最多检查 limit 个通过目录、agent 和时间过滤的索引项，隐藏空会话后可能是空页。只要应答有 ACP 的 `nextCursor` 就用相同条件在 `cursor` 里续读。游标按创建时间和 id 定位，删除上一页末项仍能续读；翻页期间新建的会话由下一次刷新取得。非法选项或游标返回 -32602。

旧客户端不发 `cycle/page`，仍一次取得完整列表。新客户端连旧 daemon 时按原方式读取全表。桌面端首次连接先显示第一页，再补全供侧栏和 ⌘K 使用；后续刷新在收齐页面后替换列表，通知按完整列表比较。

列表里每一项带 ACP 的 `SessionInfo` 字段,其中 `updatedAt`(ISO 8601)是 session 最后一条非 `meta` 记录的 `ts`;还没有这类记录时是创建时间。列表按它排序和按日分组。再在 `_meta` 里加:

- `cycle/archived`:布尔。
- `cycle/agent`:agent id。
- `cycle/state`:`"running"`、`"idle"`、`"requires_action"` 或 `"stopped"`(agent 进程不在)。
- `cycle/lastSeq`:该 session 的最新序号。**只用于补发**(§7):它是每个 session 自己数的记录条数,不是时间,不能在 session 之间比较,客户端不得用它排序。
- `cycle/unread`:布尔。有值得看的新记录晚于客户端上次标记已读的位置,见"已读"。
- `cycle/historyFailed`:布尔,为 `true` 时这个 session 的历史不可用:写不进去了(§12“写入失败”),或读不了(日志里有损坏的整行,§12)。没有时省略。读不了的 session 照样出现在列表里,行里没有 `cycle/lastSeq` 和 `cycle/unread`(它们来自日志),`updatedAt` 是创建时间,`cycle/state` 是 `stopped`;打开它(`session/resume`)以 `-32015` 失败。一个 session 的日志读不了,不影响列表里的其他 session。
- `cycle/background`:整数,仍在后台运行的东西的数:后台子 agent(`subagent_update` 里 `_meta["cycle/subagent"].background` 为 true 且 `state` 还不是终态,见 §9),加上不是子 agent 的后台任务(`_cycle/task_update` 最后一条为 `running` 的,见 §9"后台任务")。定时调用不算。清单里已消失、但收不到具体结束原因的任务 ID 列入 `cycle/backgroundUnknown`（字符串数组）。计数为零或数组为空时分别省略。Claude 按 SDK 的全量后台任务清单核对，不按静默时长或主 turn 的结束推断。它只记在内存里:daemon 重启后 agent 进程不在了,归 0,不写进索引。
- Claude 的全量清单不再列出一个曾在后台运行的任务时，以 `cycle/subagent.status = "unknown"` 更新；只知道它已不在后台清单，结束原因仍未知。后续进度可重新确认运行，终态可补全结果。用户可通过 `_cycle/session/dismiss_background {sessionId, taskIds}` 将指定的未知记录标记为已结束；只清理仍未知的项。`taskIds` 也接受 `_cycle/task_update` 里最后状态为 `unknown` 的后台任务 id(列在 `cycle/backgroundUnknown`):daemon 为它写一条 `state: "stopped"` 的 `_cycle/task_update`(不新增终态),推送给客户端、回放仍是已结束;仍在运行或已有终态的任务不受影响。`cycle/background` 仍只数子 agent 之外的运行中任务和后台子 agent,不因此改变。已确认在运行的任务阻止空闲回收，已从清单消失的未知记录不单独阻止回收（CYCL-104）。
- `cycle/usage`:最近一次 `usage_update`,`{used, size, cost?: {amount, currency}}`:已用的上下文 token、窗口大小、累计费用。daemon 存在索引里,列表不用重放日志就能显示;还没有过 `usage_update` 的 session 没有这个字段。

列表变化(出现第一条用户消息、删除、归档、`cycle/state` 改变、`cycle/unread` 改变、`cycle/background` 的值改变)通过通知 `_cycle/session_list_changed` 告诉所有客户端,通知里不带内容,客户端收到后重新拉列表。

一个等待中的请求被回答(session 不再是 `requires_action`)也发这个通知。

**`updatedAt` 自己的变化不发通知**:session 在流式输出时每条记录都会改它,每次都通知会让所有客户端不停地重拉列表。客户端在看到一个 session 状态改变的通知后重拉,拿到的就是新值。

**缺失字段的含义**(旧 daemon):没有 `updatedAt` 的 session,排在有 `updatedAt` 的之后,彼此之间按 `cycle/lastSeq` 降序(同一个 daemon 里它可比);没有 `cycle/unread` 就不显示未读;没有 `cycle/background` 且 daemon 声明了 `markRead`(即 0.2),是 0;旧 daemon 上则不显示后台状态。

### 删除、归档、改名

- 删除:`session/delete`。session 正在工作时拒绝(错误码见 §11)。daemon 先从索引里去掉它,再移除日志:从那一刻起,任何之后的 `session/resume`(包括断线重连时的)都得到 `-32002`,不会因为日志还没删完而把它重新加载出来;同时在读的列表跳过它。日志读不了的 session 也可以删除(不需要先能打开它):这是清掉它的办法。
- 归档:`_cycle/session/archive` 和 `_cycle/session/unarchive`,只改 daemon 的索引,不动历史。工作中拒绝。
- 改名:`_cycle/session/set_title`,参数 `{sessionId, title}`。daemon 自己保存标题。ACP v2 的 `session/set_title` 目前只在 unstable 里,稳定后改用它。

### 已读

未读由 daemon 记,不由客户端本地记:同一个 daemon 可以有几个客户端,换客户端、重装后也要一致(决定笔记 `2026-11-18-sidebar-workspace-environment`)。

- daemon 在索引里为每个 session 记两个序号:`readSeq`(客户端标记过已读的位置)和 `attentionSeq`(最近一条"值得看"的记录的 seq)。"值得看"的记录是:daemon 写下的一条 `request` 记录(权限或表单:不管 agent 有没有另发 `requires_action`,Claude 适配就不发),`state_update` 变成 `requires_action`,以及 `state_update` 变成 `idle` 且带 `stopReason`(turn 结束,任何 `stopReason`,出错也算:agent 中途退出、prompt 因为 agent 起不来或请求失败而被拒绝,daemon 都会写一条 `stopReason: "error"` 的 idle,所以同样算;agent 恢复时发的不带 `stopReason` 的 `idle` 只是状态快照,不算)。`meta` 记录、改标题、用量更新不算,否则它们会造成假的未读。
- `cycle/unread` = `attentionSeq > readSeq`。规则在 daemon,客户端不重新实现。
- `_cycle/session/mark_read`,参数 `{sessionId, seq}`,响应 `{}`。`readSeq` 取原值和 `seq` 中大的那个,不会倒退;`seq` 大于该 session 的 `lastSeq` 以 `-32602` 拒绝。session 在工作时也接受。
- 什么时候发由客户端决定:打开 session 且窗口有焦点时,以及回合结束时仍在看它时,发当时收到的最大 `seq`;不是每条更新都发。
- `cycle/unread` 变化时发 `_cycle/session_list_changed`。
- 不提供"标为未读":v1 不做(要做时再加,不改 `readSeq` 不倒退的规则)。

### 环境(草稿,2026-11-24)

状态:草稿,daemon 一侧已实现(2026-11-24),桌面端已在用(desktop.md"环境")。"环境"是客户端全局定义、按 workspace 选用的准备配置(脚本、变量、动作),不是 daemon 在哪跑(那是客户端的"工作位置")。理由见决定笔记 [2026-11-24-work-in-and-environments](../.agents/notes/2026-11-24-work-in-and-environments.md),客户端一侧见 desktop.md"工作位置与环境"。

**能力**:daemon 在 `initialize` 里声明 `"environments": true` 才接受下面的字段。没声明时客户端不发,也不让人选。

**创建时带上**:`session/new` 的 `_meta["cycle/environment"]`:

```json
{
  "id": "env-…",
  "name": "Node + Postgres",
  "variables": [{ "name": "DATABASE_URL", "value": "postgres://…" }],
  "secrets": [{ "name": "STRIPE_KEY" }, { "name": "GH_TOKEN", "from": "WORK_GH" }],
  "actions": [{ "id": "dev", "name": "Dev server", "command": { "default": "npm run dev" } }],
  "setup": { "default": "npm ci", "windows": "npm.cmd ci" },
  "cleanup": { "default": "docker compose down" }
}
```

- 是一份**快照**:daemon 校验后存进 session 的索引,和 `mcpServers` 一样**只存在索引里**(变量可能是密钥):不进 JSONL 日志,`session/list` 不返回值。agent 每次启动(新建、停止后的恢复)都用它。客户端之后改了这个环境,不影响已有的 session。
- **`secrets`**(可省,默认空):只有名字的变量,`{name, from?}`:值取自 `secrets.env` 里 `from` 这个键,没写 `from` 就取和 `name` 同名的键。有 `from` 是为了不同环境给同一个变量名(如 `GH_TOKEN`)配不同的值。`from` 也要是合法的键名,否则 `invalid_variable`。值不在环境里、不在线上、不在索引里,而在 daemon 所在机器的 `<数据目录>/secrets.env`(`NAME=value` 一行一个,`#` 注释,`export ` 和引号都可以;daemon 读时把别人可读的权限收回,同 `config.json`)。远程 daemon 用自己机器上的文件,密钥不经过客户端。每次用到时才读,改了文件不用重启;值不写进任何地方。名字和变量共用一套规则(保留名、格式、不重名)。`session/new` 时文件里没有某个名字的值,以 `-32602`、`data.reason: "missing_secret"`、`data.name`(缺的是 `secrets.env` 里的哪个键)拒绝;之后文件里少了,这个变量就不设。旧 daemon 会静默丢掉 `secrets` 字段。
- `session/list` 的 `_meta["cycle/environment"]` 只给 `{id, name, variableNames, secretNames, actions}`(变量只有名字),给界面显示用了哪个环境和顶栏的动作。
- 校验失败以 `-32602` 拒绝,`data.reason`:
  - `reserved_variable`(`data.name` 是哪个):变量名是保留名。保留名是 `PATH`、`HOME`、`SHELL`、`USER`、`LOGNAME`、`TMPDIR`、`TERM`,以 `CYCLE_` 开头的,agent 的隔离目录与命令注入变量(`CLAUDE_CONFIG_DIR`、`CLAUDE_ENV_FILE`、`CODEX_HOME`、`ZDOTDIR`、`BASH_ENV`),以及认证变量(各 agent `auth.viaEnv` 检查的那些,如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`)。这些归 daemon 的 `config.json`(§10"环境变量"),环境不能改,免得一个环境悄悄换掉 agent 的登录或计费。
  - `invalid_variable`:名字不是 `[A-Za-z_][A-Za-z0-9_]*`、重名,或值里有 NUL。
  - `too_large`:变量、动作、脚本合起来超过上限(暂定 64 KiB)。
- 不带这个字段就是没有环境,和现在一样。

**保险库**(`initialize` 声明 `"vault": true`):`secrets.env` 的键,桌面端 Settings → Vault 用它们管理。三个方法,值只进不出:

- `_cycle/vault/list` `{}` → `{ items: [{ key }] }`:只有键名。
- `_cycle/vault/set` `{ key, value }` → `{}`:新增或替换。`key` 是 `[A-Za-z_][A-Za-z0-9_]*`(≤128),`value` 不超过 8192 字符且是一行(没有换行和 NUL);不合格以 `-32602` 拒绝。daemon 只改这一个键所在的那一行(写成 `KEY='value'`),文件里其他行(注释、手写的顺序)原样保留;同一个键重复出现的,留第一处、删掉其余;整个文件写好再改名换上,权限 0600;符号链接的文件写到它指向的地方。
- `_cycle/vault/remove` `{ key }` → `{}`:删掉这个键的行;键不在也算成功。
  没有任何方法返回值:想核对只能重新设置。写文件按顺序一个接一个。

**密钥的作用范围**:只给 session 的终端、动作、`session/new` 时的 setup 与 session 结束时的 cleanup 脚本;**三个 agent 的命令都拿不到**,agent 自己用 EnterWorktree/ExitWorktree 触发的 setup/cleanup 也只有字面变量(那时跑的是 agent 改过的仓库代码,拿到密钥就等于给了 agent)(Claude 的 `CLAUDE_ENV_FILE`、Codex 的 `shell_environment_policy.set`、agy 的 `agy-env/.zshenv` 里都没有)。理由:agent 能在命令里 `env`、`echo` 出它看到的变量。setup 失败时回给客户端和 agent 的输出,先把密钥的值替换成 `***`。注意:`secrets.env` 和索引一样是 daemon 同一用户能读的文件,agent 若有读文件的权限仍能读到它;要挡住就给它加 deny-read 规则,`chmod 600` 挡不住同一用户。

**不让 agent 读 `secrets.env`**:daemon 把 `secrets.env` 和 `providers.json`(含符号链接指向的真实路径)交给 agent 的 adapter(`CYCLE_ADAPTER_CONFIG.denyRead`)。Codex:线程用 `extends ":workspace"` 的权限 profile 把这些文件设为 `none`(profile 与 `sandbox` 不能同时给,所以线程不给 `sandbox`;工作区类模式的 turn 也不再给 `sandboxPolicy`);只读和完全访问模式不在内。Claude:Read/Edit 工具永远有 deny 规则;vault 里有密钥时再开 SDK sandbox 的 `filesystem.denyRead`。Antigravity 没有办法。见 `.agents/notes/2026-11-24-keep-agents-from-reading-secrets-env.md`。

**变量的作用范围**:session 的 agent 跑的命令(Claude、Codex、agy)、session 的终端(在 `terminal.allowEnv` 取到的之后、`TERM` 等固定项之前加上)、setup/cleanup 脚本、动作。agent 进程本身拿不到它们。各 agent 怎么做到见下。

**每个 agent 怎么带上变量**(2026-11-24 读代码并用真实会话验证:Claude 用 SDK 0.3.327 自带的二进制,Codex 0.171.0 app-server 和 agy 1.5.16 `acp` 用 daemon 的登录各跑了一个 turn,让 agent 执行 `env | grep ^PROBE_`)。

变量**只给 agent 跑的命令,不进 agent 进程本身**:agent 进程的环境仍然只有 daemon `config.json` 的显式白名单(AGENTS.md 红线)。否则一个项目环境里的 `GOOGLE_APPLICATION_CREDENTIALS`、`CLAUDE_CODE_USE_BEDROCK`、代理变量之类会悄悄换掉 agent 的账号或走向,保留名列不全。

每个 Cycle session 本来就有自己的适配进程(`daemon.ts` `#startAgent` 每个 session 一个 `AgentLink`,`agent-link.ts` 调 `definition.launch()`)。daemon 的 `launch()` 接受这个 session 的变量,harness 把它放进 `CYCLE_ADAPTER_CONFIG` 的 `sessionEnv` 或私有脚本路径,和 agent 进程自己的 `env` 分开。带变量的新会话不复用无变量的 standby 预热进程。走启动参数而不是 `session/new` 的 `_meta`:daemon 重启后 `session/resume` 不用再带。

| agent  | 适配里怎么用 `sessionEnv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 验证结果                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Claude | daemon 每次启动这个 session 的 Claude 时写 `<数据目录>/claude-env/<sessionId>.sh`(目录 0700、文件 0600,一行一个 `export NAME='value'`,写好再改名换上),把路径作为 `CLAUDE_ENV_FILE` 给 Claude,它在每条 Bash 命令前 source 这个文件。和索引一样在数据目录里,不多一处密钥;daemon 每次启动清空这个目录。文件不能放在 Claude 自己的配置目录里(Claude 拒绝那里的路径)                                                                                                                                                                         | 命令里看得到,Claude 进程的环境里没有                                                                                    |
| Codex  | `thread/start`、`thread/resume` 的 `config` 里每个变量一个 dotted key:`shell_environment_policy.set.<NAME>`。不用整张 `shell_environment_policy` 表:那会替换掉用户自己 `config.toml` 里的这张表                                                                                                                                                                                                                                                                                                                                         | start 和 resume 都到了命令里;名字含 `KEY`/`TOKEN`/`SECRET` 的不被默认排除;用户自己的 `set` 项还在(整表的写法会把它丢掉) |
| agy    | daemon 每次启动带变量的 agy session 时写 `<数据目录>/agy-env/<sessionId>/.zshenv`(目录 0700、文件 0600,写好再改名换上;若在 zsh 中先按需 source `$HOME/.zshenv`,再逐行 `export NAME='value'`,末尾 `unset ZDOTDIR BASH_ENV` 以免影响子 shell 的 `.zshrc` 或覆盖子命令显式改写的变量),适配进程仅把目录作为 `ZDOTDIR`、文件作为 `BASH_ENV` 传给 `agy acp`(不进 `planUsage` / `pluginReader`)。`agy` 进程自身不读这两个变量,也不会拿到会话变量的值;daemon 启动时清空 `<数据目录>/agy-env`,带变量的新会话不复用无变量的 standby 进程(CYC-314) | macOS `zsh -c`(不带 `-f`)与 Linux `bash -c` 命令都能读到变量,`agy` 进程环境与 `CYCLE_ADAPTER_CONFIG` 不含变量值         |

保留名(上面 `reserved_variable`)保证这些变量换不掉任何 agent 的 `HOME`、配置目录和认证。终端在 `Terminals.create` 时把 `sessionEnv` 并进去(那里已经有 `sessionId`);它是登录 shell,用户的 profile 之后仍可能改掉同名变量。

**动作**:在 session 的终端里跑。`_cycle/terminal/create` 加可选参数 `actionId`:daemon 从 session 存的快照里取这个动作的命令(按自己的系统选),用登录 shell 的 `-c` 跑,标题是动作的名字。客户端不能借这个参数跑任意命令:命令只来自 session 创建时存下的快照。`actionId` 不存在以 `-32602`、`data.reason: "unknown_action"` 拒绝。

**setup 和 cleanup**:只在 daemon 新建 worktree 之后、删除它之前,在这个 worktree 的根目录运行,不在主 checkout 里运行(见下一节 "Worktree")。

### Worktree(2026-11-24,CYC-273)

决定见 [2026-11-24-worktree-is-cycles](../.agents/notes/2026-11-24-worktree-is-cycles.md)。三个 agent 在 Cycle 驱动的这一层都只接收 `cwd`,所以 worktree 由 daemon 管,对三个 agent 一视同仁。

**能力**:`initialize` 里 `"worktrees": true` 才接受下面的字段和 `_cycle/git/branches`。

**位置和名字**:`<主 checkout>/.agents/worktree/<name>`,分支 `worktree-<name>`。和仓库里 Claude 的 `WorktreeCreate` hook 完全一样,两边做出来的 worktree 互相认得。`name` 是用 `/` 分段的若干段,每段只含字母、数字、`.`、`_`、`-`,总长不超过 64;没给就随机生成(`wt-<8 位十六进制>`)。同名目录已经是这个仓库的 worktree 就直接用,不再跑 setup。

**创建时带上**:`session/new` 的 `_meta["cycle/worktree"]`:`{ "base"?: string, "name"?: string }`。daemon 在 session 创建之前建好 worktree,把它的路径作为 `cwd` 交给 agent;session 的 `cwd` 就是这个路径。

- `base`:起始分支,本地分支名,或远端默认分支 `origin/<name>`。不给时用远端默认分支(`refs/remotes/origin/HEAD`),没有就用 `HEAD`。**不 fetch**:用本地已有的引用。
- 目录不是 git 仓库时以 `-32602`、`reason: "not_a_repository"` 拒绝。第一版不支持远程(SSH)工作位置:daemon 不知道自己是不是被远程连接的,所以由客户端不给远程位置发这个字段。
- 校验失败以 `-32602` 拒绝,`data.reason`:`not_a_repository`、`invalid_name`、`invalid_base`、`not_a_worktree`。session 创建失败时,这次请求新建的 worktree 一并删掉。
- **setup**:这次新建了 worktree 且环境带 setup 时,在 worktree 根目录运行一次(超时 10 分钟)。**失败不阻止 session 创建**:worktree 保留,session 照常启动,输出的末尾 8 KiB 放进 `session/list` 行 `_meta["cycle/worktree"].setupFailed`,由客户端显示。

**`session/list` 行**:`_meta["cycle/worktree"]` = `{ root, path, branch?, managed, setupFailed? }`。`root` 是主 checkout,客户端用它把 session 归到同一个 workspace 下;`managed` 为真表示 worktree 是 Cycle 建的(只有这种 Cycle 才会删)。

**`_cycle/git/branches`**:参数 `{cwd}`,响应 `{ branches: string[], current?: string, defaultBranch?: string }`:本地分支、当前检出的分支、远端默认分支(有同名本地分支时是本地名,否则是 `origin/<name>`)。不在仓库里以 `-32602`、`data.reason: "not_a_repository"` 拒绝。

**删除 session**:`session/delete` 的 worktree 是 Cycle 建的时:

1. 先看 worktree 里有没有没提交的文件、没有出现在其他分支上的提交。有,而且 `_meta["cycle/worktree"]` 不是 `{ "discard": true }`,就以 `-32602`、`data.reason: "unsaved_changes"` 拒绝,`data.files`、`data.commits`(各最多 50 条)列出来,session 原样保留。
2. 通过后,先结束 agent,再运行 cleanup(超时 60 秒,失败只记日志,不阻止删除),再 `git worktree remove` 并删分支(有丢弃的提交时强删,否则让 git 决定)。
3. **归档不动 worktree**:归档的 session 以后可能取消归档,它的 `cwd` 要还在。
4. 不是 Cycle 建的 worktree(Claude 的 hook 或人自己建的)Cycle 不删。

**中途进出**:

- **Claude** 用自己的 `EnterWorktree` / `ExitWorktree`,Cycle 不屏蔽、不替换。
- **Codex、agy** 由 daemon 的 MCP 网关(§14)给 session 一个名为 `cycle-worktree` 的内置服务器,里面是同名、同契约的 `EnterWorktree` / `ExitWorktree`(只在 session 的目录在 git 仓库里、且 agent 是 Codex 或 agy 时给)。入参、出参和拒绝的条件照 Claude SDK 0.3.327 的类型定义:
  - `EnterWorktree`:`name?` 和 `path?` 互斥;`path` 必须在 `git worktree list` 里;出参 `worktreePath`、`worktreeBranch?`、`message`。已经在 worktree 里时拒绝。
  - `ExitWorktree`:`action: "keep" | "remove"`,`discard_changes?`;`remove` 且有没提交的文件或没合并的提交时,必须传 `discard_changes: true`,否则拒绝并列出;只删 Cycle 建的;出参 `action`、`originalCwd`、`worktreePath`、`worktreeBranch?`、`discardedFiles?`、`discardedCommits?`、`message`。
  - 工具名在 agent 里会带前缀(如 `mcp__cycle-worktree__EnterWorktree`);服务器的 `instructions` 说明它们就是 Claude 那两个工具。
- session 的 `cwd`、`worktree` 立刻变(文件、diff、终端跟着变);**agent 自己的目录从下一个 turn 起变**:daemon 把 agent 标为过期,这个 turn 结束后结束它的进程,下一条 prompt 用 `session/resume` 带新的 `cwd` 把它拉起。这条路对 Codex 和 agy 一样;agy 恢复时换 `cwd` 能否保留上下文没有用真实账号验证过。队列里还有 prompt 时,过期的重启要等队列处理完。
- Claude 自己建的 worktree 目前**不会**触发 Cycle 的 setup / cleanup,Cycle 也不观察 `EnterWorktree` 的结果(见"待定")。

## 7. 附着、历史补发与重连

这是 ACP 没有定义、由 L1 补上的部分。

客户端通过 `session/resume` 附着到一个 session。参数沿用 ACP 的 `ResumeSessionRequest`,其中 `replayFrom` 的取值扩展为:

| `replayFrom`                         | 含义                                    |
| ------------------------------------ | --------------------------------------- |
| 缺省或 null                          | 只附着,不补发。之后的更新会推送给客户端 |
| `{"type": "start"}`                  | 从第 1 条记录开始补发全部历史(ACP 已有) |
| `{"type": "_cycle.seq", "after": N}` | 补发序号大于 N 的记录(Cycle 扩展)       |

行为:

1. daemon 从自己的日志读取要补发的记录,按序号顺序以 `session/update` 发给该客户端,每条带 `cycle/seq`。补发过程中产生的新更新排在补发之后,不丢也不重复。
2. 补发完成后发一条 `replay_complete` 更新(ACP 已有),它的 `cycle/seq` 是补发时的最新序号。没有补发时(`replayFrom` 缺省)不发。
3. 随后发一条当前状态的 `state_update` 快照。ACP v2 规定每次成功的 `session/resume` 都在响应之前发这个快照,且响应本身不代表 session 空闲。快照是聚合状态而不是一次新的完成,客户端要幂等地应用它。
4. 之后进入实时推送。
5. 响应是 ACP 的 `ResumeSessionResponse`。

**重连的标准做法**:客户端记住每个 session 收到的最大 `cycle/seq`,断线重连后用 `{"type": "_cycle.seq", "after": 该值}` 附着。daemon 不保存客户端的位置,位置完全由客户端持有。

如果 `after` 大于 session 当前的最新序号,daemon 以 `-32602`(Invalid params)拒绝。

**重连时某个 session 已经没有了**(断线期间别的客户端删除了它):daemon 对该 session 的 `session/resume` 回 `-32002`。客户端把这个 session 从观察列表里去掉,告诉界面,并继续附着其余的 session,不重试整个连接,也不再带着它重连。只有连接本身的错误才重试整个连接。在所有 session 都附着完之前,客户端的连接状态不是 `connected`。

**历史补发不经过 agent。** agent 进程可能已经退出(daemon 重启、sandbox 销毁),历史照样可读。

### 继续一个已停止的 session

附着只读取历史,不启动 agent。当客户端对一个 `stopped` 的 session 发 `session/prompt` 时,daemon 才启动 agent 进程,并用 session 日志里保存的 `cwd`、`mcpServers`、配置去恢复它(调用 agent 的 `session/resume`,**不带 `replayFrom`**,避免 agent 重复产生历史,否则日志里会出现重复记录)。恢复失败的处理见 §11。

**agent 自己有没有这个 session 的记录。** 创建 session 时 agent 不一定已经有了它的记录(Claude 要到收到第一个 prompt 才写)。daemon 记下 session 里有没有一个被回答过的 turn(以 `end_turn` 结束;出错或被截断的不算,它们可能没到过 agent),并在恢复时把它放进 `session/resume` 的 `_meta["cycle/hadTurn"]`(为 `true` 时才带)。agent 据此决定怎么做:

- 找到自己的记录:恢复它。
- 没找到,且没有 `cycle/hadTurn`:agent 可当新的开始。能复用 ID 时沿用原 ID，否则按 §6 关联新 ID。只有明确的记录不存在才可走此分支，其他恢复错误照常上报。
- 没找到,但有 `cycle/hadTurn`:记录丢了。agent 以错误回应这个 `session/resume`,daemon 报告为 `-32013`(`resume_failed`:历史仍可读,但不能继续对话,§11),而不是悄悄在同一个名字下开一段新对话。
- agent 没办法查看自己的记录(Claude 适配器没有给 Claude 的配置目录,或查看失败)时,按有记录处理,与以前一样。

已验证(2026-11-18,Claude Agent SDK 0.3.327,本地模拟 API):新进程、同一个 `CLAUDE_CONFIG_DIR`,不带 `replayFrom` 恢复后,模型收到的请求里包含之前的用户消息,上下文完整。恢复依赖 Claude 的 transcript 还在配置目录里,而 transcript 按 `cwd` 存放,所以恢复时必须用创建时的 `cwd`。细节见 [docs/adapters/claude.md](adapters/claude.md)。

**agent 在恢复时发的状态快照不进日志。** ACP v2 要求 agent 在 `session/resume` 响应前发一条当前状态(`state_update`)。这是握手,不是历史:daemon 在等待 agent 的 resume 响应期间丢弃 agent 发来的更新。否则每次重启 agent 都会在历史里留下一条没有 `stopReason` 的 idle,客户端会把它当成一个 turn 的结束(实际测试中出现过,见 `apps/daemon` 的测试)。

**怎么区分一个 turn 的结束和状态快照**:turn 结束的 `state_update` 是 idle 并带 `stopReason`;快照没有。客户端据此判断 turn 是否结束。

**daemon 自己发的合成更新没有 `cycle/seq`**,因为它们不在日志里:

- `session/resume` 之后的 `replay_complete`:带 `cycle/seq`,值是补发到的最后序号(它不占序号,只是标记位置)。
- 随后的状态快照:没有 `cycle/seq`。
- 两者都没有 `cycle/ts`(§5)。

## 8. 提交 prompt 与 turn 状态

沿用 ACP v2 的模型:

- `session/prompt` 立即返回 `messageId`,不代表 turn 结束。
- turn 的状态由 `state_update` 表达:`running`、`requires_action`、`idle`。`idle` 带 `stopReason`(`end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`、`error`),它标志 turn 结束。
- **turn 不一定由 prompt 开始。** agent 自己开始一轮时(Claude 的后台任务完成后唤醒主 agent),agent 发 `state_update: running`,随后是这一轮的内容,最后以带 `stopReason` 的 `idle` 结束,中间没有 `user_message`。客户端和 daemon 把它当作普通的 turn:状态显示工作中,排队的 prompt 在 `end_turn` 之后发出,结束时照常通知;这时到达的 prompt 被当作"agent 忙"而排队。
- 用户消息通过 `user_message` 更新进入日志。agent 没有发出时,daemon 用 `session/prompt` 的内容合成一条,保证历史里一定有用户消息。Claude 适配自己会发这一条(用 `session/prompt` 返回的 `messageId`),所以对 Claude 不会触发合成;合成只是对其他 agent 的兜底。daemon 通过 `messageId` 去重。

**内容校验**(决策 0010):daemon 在启动 agent 之前检查 `prompt` 的每一块,不合格就以 `-32602` 拒绝,`data` 为 `{reason, index}`,不会丢掉其中一部分再继续:

- 允许的类型:`text`、`resource_link`(每个 agent 都接受),以及该 agent 的 `promptCapabilities` 允许的:`image`(PNG、JPEG、GIF、WebP)、`resource`(`embeddedContext`:文本,或 `application/pdf` 的二进制)。`audio` 一律不收。
- 上限:每块解码后 5 MiB,整个 prompt 12 MiB,最多 32 块;文本块按 UTF-8 字节数算,`resource_link` 按名字和 uri 的字节数算。常量在 `@cycle/protocol`(`PROMPT_LIMITS`),客户端可以用同一个函数 `checkPrompt` 提前检查。
- `reason`:(空数组在 ACP 的 schema 那一层就被拒绝,没有 `reason`;下面这些是 daemon 自己给的。)`too_many_blocks`、`unsupported_block`、`malformed_block`(缺必需字段,或图片没有内容)、`unsupported_media_type`、`block_too_large`、`prompt_too_large`、`invalid_base64`。

附件和图片进入日志的 `user_message`,历史补发时和文字一起到达。

**客户端附加的文件**(决策笔记 `2026-11-22-attach-any-file`,协议和上限不变):客户端把用户选的本机文件做成上面允许的块之一,不新增类型。图片是 `image`;agent 声明了 `embeddedContext` 时,UTF-8 文本(不含 NUL)是 `resource` 带 `text`,`mimeType` 是文件自己的文本类型、否则 `text/plain`;PDF 是 `resource` 带 base64 的 `blob`、`mimeType: "application/pdf"`。别的文件客户端在发送前拒绝。文件的 `uri` 是 `attachment:///` 加百分号编码的文件名:不是路径(agent 可能在另一台机器上,页面也不知道文件在哪),最后一段就是名字,ACP 的 `resource` 没有 `name` 字段。别的来源的 `resource`(如 `file://`)照样合法,daemon 不看 scheme。

**agent 自己在重试请求**:agent 的模型请求失败、它自己会等一会儿再试时(Claude SDK 的 `api_retry`),agent 发一条 `notice`,`severity: "info"`,`title` 是给人看的一句话,`_meta["cycle/retry"]` 为 `{attempt, maxRetries, delayMs, status?}`(第几次、最多几次、要等多久、HTTP 状态码,连接错误时没有 `status`)。它进日志,但不是 turn 的结束,也不需要人做什么:客户端只在它是进行中 turn 的最后一项时,把它当作"正在重试"的状态显示,turn 有了新内容就不再显示;不在会话里画成一行。重试用完仍失败时,turn 照常以 `stopReason: "error"` 结束。

**上下文用量(`usage_update`,CYCL-72)**:字段沿用 ACP:`used`、`size`、可选的 `cost: {amount, currency}`。Claude 的取法:

- `used`:主线程最近一次模型调用的 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`,即下一次调用开始时上下文里有的。缓存读写的 token 照样占上下文,所以算在里面,不单独报。子 agent 的调用不算(它们有自己的上下文)。
- `size`:带了下面的 `_meta["cycle/context"]` 时,是它的 `window`,即 Claude Code 自己衡量用量的窗口(模型的窗口,或更小的压缩窗口,例如 1M 窗口的模型在 200K 处压缩);没带时,是这一轮 `result.modelUsage` 里各模型 `contextWindow` 的最大值,模型标称的窗口。
- `cost`:`result.total_cost_usd`,整个 session 到目前的累计,美元。省略表示沿用上一次,`null` 表示清掉。
- **什么时候发**:每个 turn 结束时一次(turn 被取消时不发);以及一次压缩完成之后,SDK 的 `compact_boundary` 带了 `post_tokens` 时,紧跟在 `compaction_update: completed` 之后发一次,`used` 是压缩后的量,`size` 沿用本进程上一次的,不带 `cost`。本进程还没报过 `size`(刚恢复、还没有 turn 结束)时这一次不发,压缩后的量在 turn 结束时报。没有 `post_tokens` 时什么都不发,不估算。
- 所以客户端看到一条 `compaction_update: completed` 之后还没有新的 `usage_update` 时,手上的用量是压缩**之前**的,应当这样说明,不当作现在的值。
- **`_meta["cycle/context"]`(CYCL-74 之后)**:turn 结束的那条可以带上窗口里各部分的占用,`{window, parts, autoCompactAt?}`。Claude 的取法是 turn 结束时向进程要一次 `getContextUsage({detail: "summary"})`(用上一次响应的用量加本地估算,不调 API,实测几毫秒),最多等 2 秒,没回答或回答不对就不带。
  - `window`:衡量用的窗口(SDK 的 `rawMaxTokens`),同时作为这条的 `size`,所以百分比和各部分对得上。
  - `parts`:`{id?, name, tokens, kind}`,按 CLI 给的顺序,去掉 0 token 的。`id` 是稳定的部分名(`system_prompt`、`system_tools`、`mcp_tools`、`mcp_instructions`、`custom_agents`、`memory_files`、`skills`、`messages`、`autocompact_buffer`、`compact_buffer`、`free_space`、`*_deferred` 等,以后可能增加),客户端认得的按 `id` 用自己的文字显示,不认得的显示 `name`(CLI 的英文名)。`kind`:`used` 在窗口里;`free` 是剩下的;`buffer` 是给压缩留的;`deferred` 是没加载进窗口的工具定义,不算用量。
  - `autoCompactAt`:自动压缩开始的 token 数,自动压缩关着时没有。
  - 各部分是 Claude Code 的估算,`messages` 是总数减去其他部分算出来的;总数(`used`)仍是上面那个实测值。压缩之后补发的那条不带(它只有 `post_tokens`),所以客户端在下一次 turn 结束前没有压缩后的分部。
- 没有缓存命中量、压缩次数这些字段:压缩发生过几次,客户端从会话里的 `compaction_update` 数。

**套餐用量(`_cycle/plan_usage`,CYCL-74 之后)**:订阅账号的用量限额(5 小时、每周等)用了多少、什么时候重置。它属于 agent 在 daemon 那台机器上登录的**账号**,不属于某个 session,所以不进 session 的历史:

- **agent → daemon**:agent 在某个 session 的流里发一条 `session/update`,`sessionUpdate: "_cycle/plan_usage"`,`{windows: [{kind, utilization, resetsAt, status?}], at}`。`kind` 是 `five_hour`、`seven_day`、`seven_day_opus` 等;`utilization` 是用掉的比例,从 0 起,超了会大于 1;`resetsAt`、`at` 是毫秒时间戳;`status` 是 `allowed`/`allowed_warning`/`rejected`。只在变化时发,只带这次听到的限额(不必是全部)。
- **daemon**:收下这条,不写日志、不占序号、不作为 `session/update` 转发;按 agent、按限额(`kind`)记住最新的:一条只说到某几个限额时,其余的保留;每个限额只被 `at` 不更早的那条替换(各 session 的进程各说各的,旧进程的旧消息不覆盖新的)。通知和读取给出的是合并后的全部限额,`at` 是其中最新的,只在内存里,daemon 重启后要等下一次 agent 说。然后向每个连接发通知 `_cycle/plan_usage_changed`,`{agent, usage: {windows, at}}`。
- **客户端**:`_cycle/plan_usage/read`(`{}` → `{agents: {[agentId]: {windows, at}}}`)读 daemon 已知的,连接时读一次,之后跟通知更新。`cycle/capabilities` 有 `planUsage: true` 的 daemon 才有这两样。一个窗口过了 `resetsAt` 就不再显示,因为重置后用了多少不知道。
- **Claude 的取法**:Claude Code 从每次 API 响应的头里读到限额,以 `rate_limit_event` 告诉 SDK,`rate_limit_info.unifiedWindows` 列出全部窗口(SDK 的类型里还没有这个字段,没有时只取 `rateLimitType` 那一个)。只有用订阅账号登录(`claude setup-token` 的 token 或 `/login`)时才有;API key 登录没有,也就什么都不发。SDK 的实验接口 `usage_EXPERIMENTAL…()` 不用:用 `setup-token` 的 token 时它答不上(缺 profile 权限),而且随时可能改。

**失败后重新发送**是客户端的事,协议不变:客户端把失败那个 turn 的 `user_message` 原样作为新的 `session/prompt` 再发一次(Try again),或放回输入框,由人核对后再发(Edit message)。它和别的 prompt 一样走权限流程,之前的批准不沿用。

多个客户端同时附着的规则:

- session 不是 `idle` 时,`session/prompt` 进入队列,不再被拒绝,见下面的"排队"。队列满了才以 `-32010`(`session_busy`)拒绝。daemon 的 `cycle/capabilities` 没有 `queue` 时,客户端只在 session 空闲时发送。
- `session/cancel` 任何附着的客户端都可以发。
- 一个客户端发出的 prompt,对所有附着的客户端都可见(通过 `user_message` 更新;排队的 prompt 通过 `_cycle/queue_update`,发出时才有 `user_message`)。

### 排队(session 忙时发的 prompt)

session 不是 `idle` 时(`running` 或 `requires_action`),`session/prompt` 不再被拒绝,daemon 把它放进该 session 的**队列**。队列由 daemon 持有、写进日志,所以客户端断线、关窗口、换客户端都不会丢。

- **id**:`messageId` 是 agent 在收到 prompt 时自己生成的(Claude 适配用 `randomUUID`),排队的 prompt 还没到 agent,所以没有。队列条目用 daemon 生成的 `queueId`。它**不是**之后历史里 `user_message` 的 `messageId`,两者没有对应关系,客户端不得假设相同。
- **响应**:立即返回,`messageId` 填 `queueId`(ACP 的响应必须有这个字段),`_meta["cycle/queued"]` 为 `true`。内容校验(`checkPrompt`)在入队时就做,不合格同样以 `-32602` 拒绝。
- **上限**:每个 session 最多排 8 条,满了以 `-32010`(`session_busy`)拒绝。
- **`stopped` 的 session 不排队**:照 §7 启动 agent 并直接发送。如果它的队列里还留着东西(崩溃留下的),先把旧队列以 `reason: "interrupted"` 退回,再处理这条 prompt。
- **队列的表达**:`session/update` 的一个 Cycle 变体 `sessionUpdate: "_cycle/queue_update"`,每次队列变化发一条**完整快照**,占一个序号,写进日志。它由 daemon 产生,不是 agent 发的:

```json
{
  "sessionUpdate": "_cycle/queue_update",
  "entries": [{ "queueId": "…", "prompt": [{ "type": "text", "text": "…" }] }],
  "returnId": "…",
  "returned": [{ "queueId": "…", "prompt": [] }],
  "reason": "cancelled"
}
```

- **`entries` 是状态,`returned` 是事件。** 客户端以最后一条的 `entries` 为当前队列,所以从任意位置补发都能得到它。`returned` 和 `reason` 只在队列被退回的那一条里出现,daemon 只交给最早完成附着且仍在线的一个客户端。客户端**只在它实时到达时**(`replay_complete` 之后)把内容放回输入框;补发过程中遇到的 `returned` 一律忽略,否则重启应用后每次历史里的退回都会再放一遍。
- **附件字节**照决策 0013 存进 blob(daemon 的提取是递归的,覆盖快照里的 `entries[].prompt[]` 和 `returned[].prompt[]`),同一份内容按 sha256 只存一次,快照反复出现不会反复占用空间。
- **发出**:turn 以 `idle` 加 `stopReason: "end_turn"` 结束时,daemon 取队头发给 agent,再发一条新的 `_cycle/queue_update`。它的 `user_message` 和直接发的 prompt 一样,来自 agent 收到时的回显(Claude 适配会发),所以也是此时才进历史,历史里的顺序就是真实发生的顺序。
- **退回,不自动发**:turn 以 `end_turn` 之外的原因结束(`cancelled`、`error`、`max_tokens`、`max_turn_requests`、`refusal`),或者 `session/cancel`、`session/close` 到达时,队列里剩下的**整体退回**:`entries` 清空,原内容放在 `returned`,`reason` 说明原因(`cancelled`、`error`、`closed`、`interrupted`)。客户端把 `returned` 的内容放回输入框,不当作错误显示。宁可退回,也不在用户已经叫停或出错之后替他发出他可能想改的消息。
- **退回时没有客户端附着**(窗口都关了),或者 **daemon 重启**(进程被中断,没有机会退回):daemon 不退回,也不自动发送,队列留着。下一次有客户端附着时,daemon 在补发、`replay_complete` 和状态快照**之后**退回:原因照旧(重启则是 `interrupted`)。队列清空的快照占新的序号，领取通知单独发送。daemon 自己关闭时杀掉 agent 进程,不算退回的理由。
- 排队退回时,多个客户端附着:先完成附着的客户端领取一批，原发送者断线不影响领取。新客户端握手声明 `_meta["cycle/ackReturns"]`，将退回的内容放入草稿后调用 `_cycle/prompt/ack_return {sessionId, returnId}`。daemon 将确认写入日志并返回 `{acknowledged: true}`；重复确认或来自其他连接的确认返回 `false`。未确认前掉线则转交下一位，重启后仍可领。领取通知没有 seq，普通队列快照照常广播；重放不触发领取。旧客户端按通知送达确认。丢失确认时可能重投，客户端用 queueId 去重。
- **撤回**:`_cycle/prompt/dequeue`(客户端 → daemon),参数 `{sessionId, queueId}`。成功时响应里带那条 prompt 的内容(`{prompt}`),客户端放回输入框编辑,并发一条 `_cycle/queue_update`。那条已经发出或不在队列里,以 `-32016`(`not_queued`)拒绝。

### 插入(steer:把 prompt 放进正在运行的 turn)

排队的 prompt 要等 turn 结束才发;插入的 prompt 现在就交给 agent,由 agent 在当前 turn 里接着处理(Claude 在下一次工具调用之间读到它)。

- **请求**:`session/prompt` 的 `_meta["cycle/steer"]` 为 `true`。只在 session 是 `running` 或 `requires_action` 时有意义;session 空闲或已停止时,这个标记被忽略,照常发送。
- **能力**:daemon 的 `cycle/capabilities` 有 `steer: true`,`_cycle/agents/list` 里能插入的 agent 带 `steer: true`(§10)。客户端只对这样的 agent 提供插入;旧 daemon 不认识这个 `_meta`,会照常排队,所以发了也不会出错。
- **daemon 的处理**:agent 声明能插入时,daemon 把 `session/prompt` 原样转给 agent,`_meta` 里带 `cycle/steer: true`;agent 不声明、拒绝或 agent 进程不在,daemon 退回到排队(§8 "排队"),响应照排队的写法带 `cycle/queued`。插入成功的响应是 agent 给的 `messageId`,`_meta["cycle/steered"]` 为 `true`。
- **agent 的处理**(L2):agent 在当前 turn 收下这条 prompt,立即发它的 `user_message`(带同一个 `messageId`),然后继续这个 turn,不另起 `state_update`。turn 在 agent 处理完它之前结束的(例如 Claude 恰好已经说完),agent 让 turn 继续,把它当作同一个 turn 的后续处理,turn 只以一条 `idle` 结束。turn 被取消时还没处理的插入,agent 必须保证它不会在之后悄悄运行(Claude 适配会结束进程,下一条 prompt 启动新进程恢复会话)。
- **历史**:插入的 `user_message` 在 agent 收下时进日志,所以它在历史里出现在 turn 中间,位置就是它被收下的时刻。
- 插入不经过队列,也不改变队列:队列里等着的 prompt 仍在 turn 正常结束后发出。

### 下一轮输入建议(`_cycle/prompt_suggestion`,CYCL-225)

turn 结束后,agent 可以猜一句用户接下来可能说的话,客户端把它作为输入框空着时的提示,用户一键采用。只是提示:不会自己发出,也不改变 turn 和队列。

- **要不要**:`session/prompt` 的 `_meta["cycle/promptSuggestions"]` 为 `true` 表示发这条 prompt 的客户端想要建议,`false` 表示不要(用户在设置里关了)。daemon 记住每个 session 最近一次收到的值(只在内存里),之后它交给 agent 的每条 prompt(直接发的、排队后发出的)都在 `_meta` 里带上它;没收到过的不带。agent 按它收到的最近一条 prompt 决定,没收到 `true` 就不要求、也不发建议,所以旧客户端、旧 daemon 不会多出这样的请求。
- **agent → daemon**:turn 以 `idle` 结束之后,agent 发 `session/update`,`sessionUpdate: "_cycle/prompt_suggestion"`,`{suggestion}`(一句话,不为空)。每个 turn 最多一条,也可以没有。它属于刚结束的那个 turn:下一个 turn 已经开始(agent 收到新的 prompt、自己开始一轮)才到的,agent 不发。schema 是 `@cycle/protocol` 的 `PromptSuggestionUpdateSchema`。
- **daemon**:session 不在空闲时(新的 prompt 已经接下)、或最近的 prompt 没要建议、或不符合 schema 的,丢掉;其余照常写日志、占序号、转发、回放。它是 agent 说的话,和 `agent_message` 一样不做 §12 的凭证过滤;不算"值得看"(§6),不改变 `cycle/state`,不发 `_cycle/session_list_changed`。
- **客户端**:一条建议从它到达起有效,到下一个 turn 开始为止:之后的 `user_message`、`state_update` 的 `running` 或 `requires_action`、新的 `_cycle/prompt_suggestion` 都让它作废。回放即还原,所以重新打开 session 仍能看到最后一个 turn 的建议。客户端不认识它就忽略;没有它的 agent(只有 Claude 会发)照旧显示原来的提示文字。
- **Claude 的取法**:query 的 `promptSuggestions: true`,SDK 在 `result` 之后发一条 `prompt_suggestion`,原样换成上面的更新。不要建议时用 flag 设置 `promptSuggestionEnabled: false`(新进程在 `settings` 里,运行中的进程用 `applyFlagSettings`;要的时候以 `null` 清掉覆盖,用户自己 `settings.json` 里的 `promptSuggestionEnabled: false` 仍然生效),并且丢掉这时到达的建议。SDK 在第一个 turn、API 出错之后、plan 模式里、套餐用量接近上限时不给建议。

### daemon 停止时进行中的 turn

agent 是 daemon 的子进程,daemon 停止(`cycle stop`、升级、崩溃、机器重启)时 agent 跟着结束,进行中的 turn 不会继续,重启后也不续接。历史里这个 turn 必须有一个终态,不能停在"进行中":

- **终态记录**:一条 `state_update`,`state: "idle"`、`stopReason: "error"`、`error.code` 为 `-32018`(`daemon_stopped`,§11),`error.message` 供人阅读。它和其他 turn 结束一样占一个序号、写进日志、算"值得看"(§6"已读"),所以 session 显示为未读;客户端断线重连后按 `cycle/seq` 补发就能看到它,知道 turn 是被 daemon 的停止打断的。客户端按 `error.code` 识别它,不解析 `message`。
- **什么时候写**:daemon 正常关闭时(收到 `SIGTERM`/`SIGINT`),对每个有进行中 turn 的 session 先写终态,再结束 agent;此后 agent 发来的更新不再记录。等待回答的权限请求和表单写 `aborted`,按取消回给 agent。没来得及写的(崩溃、`kill -9`、还没有这个规则的旧 daemon 停的),daemon 下一次加载这个 session 时补写(加载发生在第一次 `session/list` 或附着时)。
- **怎么知道 turn 还开着**:按日志判断:最后一条 `user_message` 或 `running`/`requires_action` 的 `state_update` 之后没有任何 `idle`。索引里的 `turnOpen` 记着这个结论(§12),加载时只有它为 `true`(或旧索引里没有它)才读日志核对,所以重启后不必读每个 session 的日志两次。
- **队列不丢**:终态记录不退回队列。排队的 prompt 照"排队"一节的重启规则留着,下一次有客户端附着时以 `reason: "interrupted"` 退回到输入框。
- 后台子 agent 和后台任务随 agent 进程结束,不写记录(它们不属于某个 turn,`cycle/background` 归 0)。
- **停之前先问**:`cycle stop` 先用 `session/list` 看有没有在工作的 session(`cycle/state` 为 `running` 或 `requires_action`,或 `cycle/background` 大于 0),有就列出来,由人选等待(`--wait`)或强停(`--force`),见 [daemon.md](daemon.md)。用的是已有的方法,所以新的 `cycle` 也能这样停一个旧 daemon(升级时正是这样)。daemon 里同一个判断是 `Daemon.activity()`,空闲退出(CYCL-104)只在它为空时发生。

### 提及(@)文件与文件夹

客户端在输入框里用 `@` 引用 session 的 `cwd` 下的文件或文件夹。还没有 session 的空白对话(§6 列表)引用它选好的 `cwd` 下的。

**搜索**:`_cycle/files/search`(客户端 → daemon),参数 `{sessionId, query, limit?}` 或 `{cwd, query, limit?}`(两者恰好给一个),响应 `{root, entries: [{path, kind}], truncated}`:

- `root` 是 `cwd` 的绝对路径;`path` 是相对 `root` 的路径,用 `/` 分隔;`kind` 是 `"file"` 或 `"folder"`。
- 排序:名字以 `query` 开头的在前,名字包含的次之,路径包含的最后;`query` 含 `/` 时只匹配路径。`query` 为空时给顶层的文件夹和文件。`limit` 缺省 20,最大 50。
- **只在 `cwd` 内**:daemon 对每个候选取 `realpath`,不在 `cwd` 的 `realpath` 之内的丢掉;符号链接不跟随,也不列出。`cwd` 不存在时返回空列表,不是错误。
- **有上限**:最多检查 50,000 个条目、最多走 2 秒;到了上限就带 `truncated: true` 返回已找到的。跳过 `.git` 和 `node_modules`;名字以 `.` 开头的文件,只有 `query` 里含 `.` 时才给。
- 这是 daemon 读本机文件系统的新入口:不返回文件内容,只返回路径;只在 loopback、unix socket 或 SSH 通道上服务,不放宽。session 不存在以 `-32002` 拒绝。
- **按 `cwd` 搜**:给空白对话用,那时还没有 session。`cwd` 必须是绝对路径,否则以 `-32602` 拒绝;同时给 `sessionId` 和 `cwd`,或都不给,也是 `-32602`。规则和按 session 搜完全一样,`root` 是给的 `cwd`;不存在时同样返回空列表。它不比按 session 搜多暴露什么:谁能连上 daemon,谁就能用任意 `cwd` 新建 session 再搜。能力 `filesInFolder` 为 `true` 才有;旧 daemon 没有时,客户端在空白对话里不提供 @ 搜索,有了 session 之后照常。

### 提及(@)另一个 session

客户端可以在 prompt 里提及同一个 daemon 上的另一个 session,让 agent 读到那段对话。

- **形式**:一个 `resource_link`,`uri` 为 `cycle://session/<sessionId>`,`name` 是 session 的标题(没有标题时是客户端显示它的名字),`_meta["cycle/mention"]` 是正文里 `@` 后面写的那几个字(和文件提及一样,正文同时写 `@名字` 给人看)。客户端在 daemon 的 `cycle/capabilities` 有 `sessionMentions: true` 时才提供;旧 daemon 没有这一项,客户端不列出 session。
- **展开**:daemon 在把 prompt 交给 agent 的那一刻(直接发送、排队的发出、插入都一样)把这样的块换成一块 session 的简短记录。agent 的 `promptCapabilities` 有 `embeddedContext` 时是一块嵌入资源 `{type: "resource", resource: {uri, mimeType: "text/plain", text}}`,否则是一块 `text`。块数不变,所以不影响 32 块的上限;内容校验在展开之前,对客户端发来的原样进行。
- **记录的内容**:只有人说的话(`user_message` 的文字,其中的提及写成 `@名字`,图片写成 `[image]`)和 agent 的回答(`agent_message_chunk` 的文字,按 `messageId` 拼成一条)。不含思考、工具调用及其输出、计划、权限。每条消息最多 4,000 个字符(超出的截去尾部并注明),消息部分合计最多 40,000 个字符(另有开头一句说明):从最新的往前取,放不下的旧消息整条丢掉,开头注明丢了几条。常量在 `@cycle/protocol` 的 `SESSION_MENTION_LIMITS`。
- **只读本 daemon 的**:`sessionId` 必须在 daemon 的索引里(Cycle 在这个 daemon 上建的 session,归档的也算)。找不到(从没有、已删除、正在删除)、日志读不了,或者提及的就是这个 session 自己时,daemon 不拒绝这条 prompt,而是把那一块换成一句给 agent 的说明(`text` 块),说清是哪个 session、为什么没有内容。
- **历史里是链接,不是记录**:展开出来的块在 `_meta["cycle/expandedFrom"]` 里带着原来的 `resource_link`。agent 回显的 `user_message` 进日志之前,daemon 把带这个标记的块换回原来的链接,所以日志、补发和其他客户端看到的都是提及,不是那份记录;排队的 prompt 在队列里也保持链接,发出时才展开,所以读到的是发出那一刻的内容。agent 回显时要原样保留块的 `_meta`(Claude 适配是这样);不保留的 agent,记录会进它的历史。
- 记录给 agent 的是那时候的快照:被提及的 session 之后的变化不会跟过来。这条路径只读 daemon 自己的日志,不经过 agent,也不跨 daemon。

### 浏览和预览文件(`_cycle/fs/*`,CYCL-91)

右侧面板的 Files 标签浏览、预览 session 的 `cwd` 里的文件。文件在 daemon 那台机器上，所以由 daemon 来读，客户端只看，不写。理由和 Diff 的基线见决定笔记 [2026-11-22-files-and-diff-sources](../.agents/notes/2026-11-22-files-and-diff-sources.md)。

**路径**:两个方法的 `path` 都**相对 `cwd`**,用 `/` 分隔,`""` 是 `cwd` 自己。以 `/` 开头、含 `.`、`..` 或空的段(`a//b`)、含 NUL 的，以 `-32602` 拒绝,`data.reason` 为 `invalid_path`。

**只在 `cwd` 内**:每次请求，daemon 都重新取 `cwd` 和目标的 `realpath`,目标不在 `cwd` 的真实路径之内就以 `-32602` 拒绝,`data.reason` 为 `outside`。所以符号链接可以列出、可以走进，但走不出 `cwd`;列出时检查过的，打开时再检查一遍(agent 在这里执行命令，链接随时可能被换掉):文件以不跟随最后一级链接的方式打开，打开后再核对它仍在 `cwd` 之内、且就是真实路径所指的那个文件，所有字节都从这一个句柄读。session 不存在、`cwd` 不存在、目标不存在，都是 `-32002`。读不了的是 `-32602`,`data.reason` 为 `unreadable`。

`_cycle/fs/list`,参数 `{sessionId, path}`,响应 `{root, path, entries: [{name, kind, link?, size?, ignored?}], truncated}`:

- 只列一层(懒加载),不递归。`root` 是 session 的 `cwd`(和 `_cycle/files/search` 的 `root` 一样),`path` 是请求的 `path`。目标不是文件夹以 `-32602` 拒绝,`data.reason` 为 `not_a_folder`。
- `kind`:`"file"`、`"folder"`,或 `"other"`(指向 `cwd` 外面、或已断开的符号链接，以及设备、管道、socket 这类):`other` 只列出，不能打开。符号链接带 `link: true`,`kind` 是它指向的东西的。`size` 只有文件有，单位字节。
- `.git` 不列。名字以 `.` 开头的照常列出，显不显示由客户端决定。
- `ignored: true` 表示按 git 的忽略规则被忽略(客户端画淡，不藏)。只在 `cwd` 位于 git 仓库里、且**仓库的根目录被信任**时给:git 读的是仓库的配置，所以看的是仓库根目录的信任，不是 `cwd` 的(规则见下面"信任文件夹"和决定笔记);其余情况一律不带这个字段，客户端把缺失当作"不知道",不是"没被忽略"。
- 排序：文件夹在前，其余在后；同类按名字，不分大小写，同序的以字节序为准。
- **有上限**:最多看一个文件夹的 20,000 个条目，最多给 5,000 个；多了带 `truncated: true` 返回已有的。

`_cycle/fs/read`,参数 `{sessionId, path, offset?}`,响应 `{path, size, mtimeMs, kind, ...}`,`kind` 决定其余字段:

- `"text"`:`{text, offset, next}`。从字节偏移 `offset`(缺省 0)读最多 1 MiB,在 UTF-8 字符边界处截断;`next` 是下一块的偏移，读到末尾为 `null`。客户端按 `next` 一块块要，不要一次读完大文件。`offset` 超过文件大小、或落在一个字符中间，以 `-32602` 拒绝,`data.reason` 为 `invalid_offset`。开头之后不合法的 UTF-8 字节换成 U+FFFD,不拒绝。
- `"image"`:PNG、JPEG、GIF、WebP(按扩展名),`{mimeType, data}`,`data` 是 base64。大于 10 MiB 的不给 `data`,带 `tooLarge: true`。SVG 是文本，按 `"text"` 给。
- `"binary"`:只有 `size`,没有内容。文件的前 8 KiB 里有 NUL,或不是合法的 UTF-8(在末尾截断的字符除外),就是二进制；不管 `offset` 是多少，都按开头判断。
- 目标是文件夹以 `-32602` 拒绝,`data.reason` 为 `not_a_file`。`mtimeMs` 让客户端知道预览是不是旧了：读后续块时它变了，就从头重读。
- 常量在 `@cycle/protocol` 的 `FS_LIMITS`。

**不比现在多暴露什么**:能连上 daemon 的人本来就能让 agent 在这台机器上执行命令。监听仍只在 loopback、unix socket 或 SSH 通道上，不放宽。daemon 的日志不记路径和内容。能力 `fs` 为 `true` 才有这两个方法；旧 daemon 没有：客户端不显示 Files 标签。

### 工作区的改动(`_cycle/diff/*`,CYCL-94)

右侧面板的 Diff 标签有两个视图(决定笔记 [2026-11-22-files-and-diff-sources](../.agents/notes/2026-11-22-files-and-diff-sources.md))。"本会话的编辑"由客户端从日志里工具调用的 `diff` 内容汇总，不需要新方法；"工作区"由 daemon 在 session 的 `cwd` 上运行 git 算出：工作区(已暂存的、未暂存的、未跟踪的，不含被忽略的)对比 `HEAD`,还没有提交时对比空树。只看 `cwd` 之内，路径相对 `cwd`,用 `/` 分隔。不做改名识别：改名是一删一增。

**只在信任的仓库里算**:git 读的是仓库自己的配置，所以要求 `cwd` 所在仓库的**根目录**(最近的 `.git` 所在)被信任(§8"信任文件夹")。运行方式和 `_cycle/fs/list` 标忽略时相同：加固参数、白名单环境、`GIT_CEILING_DIRECTORIES`、`GIT_LITERAL_PATHSPECS=1`、每次最多 10 秒。

`_cycle/diff/status`,参数 `{sessionId}`,响应按 `state` 分:

- `{state: "ok", head, files, truncated}`:`head` 是 `HEAD` 的提交号，没有提交时为 `null`。`files` 是 `[{path, status, additions?, deletions?, binary?}]`,按路径排序;`status` 是 `added`(已暂存的新文件)、`modified`、`deleted`、`untracked`;`additions`、`deletions` 是行数，二进制文件带 `binary: true` 不带行数。未跟踪文件的行数由 daemon 数(经过和 `_cycle/fs/read` 一样的路径检查),超过 1 MiB 的、读不了的、数了 2 秒还没数到的，不带行数。仓库里未被跟踪的另一个仓库按文件夹列出(`path` 是它的路径,带 `folder: true`),没有行数，也没有补丁。最多 1,000 个文件，多了带 `truncated: true`。
- `{state: "not_git"}`:`cwd` 不在 git 仓库里。
- `{state: "untrusted", repository}`:仓库根目录 `repository` 没有被信任。客户端说明原因，并指向信任的设置。
- session 不存在、`cwd` 不存在：`-32002`。git 不在、超时或失败:`-32603`,`data.detail` 是 git 的说法。

`_cycle/diff/file`,参数 `{sessionId, path}`,响应 `{path, patch, truncated, binary}`:

- `patch` 是这个文件对比同一基线的统一 diff(git 的格式，从文件头开始;客户端从第一个 `@@` 起画)。未跟踪的文件给出整份新增。最多 1 MiB,在行尾截断并带 `truncated: true`。二进制文件 `binary: true`,`patch` 为空。没有改动时 `patch` 为空。
- `path` 的规则和 `_cycle/fs/*` 相同(相对、不含 `.`、`..`、空段、NUL,否则 `-32602` 加 `invalid_path`);未跟踪文件还要通过同样的真实路径检查。空路径也是 `invalid_path`。目标是文件夹、管道或设备，以 `-32602` 拒绝,`data.reason` 为 `not_a_file`。仓库不在或没被信任，以 `-32602` 拒绝,`data.reason` 是 `not_git` 或 `untrusted`。

能力 `diff` 为 `true` 才有这两个方法；旧 daemon 没有：客户端只提供"本会话的编辑"。常量在 `@cycle/protocol` 的 `DIFF_LIMITS`。

### 终端(`_cycle/terminal/*`,CYCL-97)

用户在 session 旁边开的交互式 shell。PTY 在 daemon 里，跑在 session 所在的机器上，经本连接传输，本地和 ssh 一样。理由和取舍见决定笔记 [2026-11-22-terminals-in-the-daemon-over-l1](../.agents/notes/2026-11-22-terminals-in-the-daemon-over-l1.md)。能力 `terminal` 为 `true` 才有这些方法和通知;旧 daemon 没有，客户端不提供终端。

- **只给人用**:agent 看不到终端，也收不到它的输入输出。ACP 的 `terminal/*` 客户端能力仍不支持(§3)。
- **属于一个 session**:工作目录是 session 的 `cwd`。session 被归档或删除时，它的终端被关掉(应答不等它们的进程结束),归档的 session 不能再开终端;daemon 停止(包括空闲退出)时，所有终端被关掉。终端不算 daemon 在工作,不拖住空闲退出(docs/daemon.md"空闲退出")。
- **shell 和环境**:daemon 的 `SHELL`(绝对路径且可执行)作为登录 shell(`-l`)启动;daemon 没有 `SHELL`(旧版桌面端启动的本地 daemon 就没有)或它不可用时，用账户的登录 shell(系统用户数据库里的),再不行用 `/bin/sh`。环境不继承 daemon 的，只取 daemon 配置 `terminal.allowEnv` 里列出的变量(以 `*` 结尾的项按前缀匹配),再设 `TERM=xterm-256color`、`COLORTERM=truecolor`、`SHELL`(实际启动的 shell),没有 `CLICOLOR` 时设 `CLICOLOR=1`(macOS 自带的 `ls` 等 BSD 命令据此输出颜色);在 macOS 上 `LANG`、`LC_ALL`、`LC_CTYPE` 都没有时(从访达启动的应用就没有)再设 `LANG=en_US.UTF-8`,和系统终端一样，让提示符和文件名里的非 ASCII 字符正常显示。配置不经协议修改。
- **上限**:每个 session 的终端数(含已退出、还没关的)和整个 daemon 的终端数有上限(配置 `terminal.maxPerSession`、`terminal.max`,默认 8 和 32),超过以 `-32019`(`terminal_limit`)拒绝。

**终端的信息** `TerminalInfo`:`{terminalId, sessionId, title, cols, rows, status, exitCode?}`。`status` 是 `running` 或 `exited`;`exitCode` 只在 `exited` 时有，被信号结束时为 `null`。`title` 起初是 shell 的名字，shell 用 OSC 0 或 2 设了标题就换成它。

**方法**(客户端 → daemon):

- `_cycle/terminal/create`,参数 `{sessionId, cols, rows}`,响应同 `attach`。新开一个终端，调用的连接随即附着在它上面。以 `-32602` 拒绝的情况,`data.reason` 分别是:`cwd` 不在了(`cwd_missing`)、shell 起不来(`spawn_failed`)、session 已归档(`archived`)、daemon 正在停止(`daemon_stopping`)。读 session 的索引就够，不加载它的历史。
- `_cycle/terminal/list`,参数 `{sessionId}`,响应 `{terminals: TerminalInfo[]}`,按创建先后。
- `_cycle/terminal/attach`,参数 `{terminalId}`,响应 `{terminal, screen, seq}`:`screen` 是重画当前屏幕(含回滚，最多 `terminal.scrollback` 行，默认 5000)的转义序列,`seq` 是它已包含的最后一段输出的序号。之后这个连接收到这个终端的输出。
- `_cycle/terminal/detach`,参数 `{terminalId}`,响应 `{}`:这个连接不再收它的输出。连接断开等于对它附着的每个终端 `detach`。
- `_cycle/terminal/input`,参数 `{terminalId, data}`,响应 `{}`:`data` 原样写进 PTY(按键、粘贴),一次最多 64 KiB。已退出的终端以 `-32602` 拒绝,`data.reason` 为 `exited`。
- `_cycle/terminal/resize`,参数 `{terminalId, cols, rows}`,响应 `{}`。`cols` 2–1000,`rows` 1–500。多个客户端附着时以最近一次为准，客户端在附着和获得焦点时各发一次。
- `_cycle/terminal/close`,参数 `{terminalId}`,响应 `{}`:终端立即从列表里去掉;它上面的进程在后台结束:这个终端上的每个进程(shell、前台作业、后台作业)收到 `SIGHUP`,忽略它的(如 `nohup`)留下;2 秒后 shell 还在，`SIGKILL` 它的进程组;最后关掉 PTY。shell 自己先退出时，它留下的进程失去这个控制终端(和普通终端里 `cmd & exit` 一样),不再属于这个终端，不会被结束。

`terminalId` 不存在(或所属 session 已不在)时，以上方法都以 `-32002` 拒绝,`data` 为 `{terminalId}`。

**通知**(daemon → 客户端):

- `_cycle/terminal/output`,`{terminalId, seq, data}`:只发给附着的连接。`data` 是 UTF-8 文本(多字节字符不会被切开),`seq` 每段加一。daemon 把短时间内的输出合成一段(约 16 ms 或 64 KiB)。
- `_cycle/terminal/reset`,`{terminalId, seq, screen, cols, rows}`:某个连接落后太多(还没送出的输出超过 1 MiB)时，daemon 暂停给它发 `output`,等它追上后发一次 `reset`,客户端清屏后写入 `screen`,再接着收 `seq` 之后的 `output`。
- `_cycle/terminal/changed`,`{sessionId, terminals}`:一个 session 的终端有增减，或标题、尺寸、状态变了。发给所有连接,`terminals` 是这个 session 完整的列表(同 `list`)。

**顺序**:`attach`(和 `create`)的响应与第一段 `output` 之间没有先后保证。客户端对还没拿到响应的 `terminalId` 先缓存 `output`,拿到响应后丢掉 `seq` 不大于响应里 `seq` 的，其余依次写入。`reset` 之后同样丢掉 `seq` 不大于它的。

### 选文件夹

新建 session 要在 daemon 所在机器的文件系统里选一个 `cwd`;远程环境的文件夹在本机看不到,所以由 daemon 来列。**不依赖 session**(session 还不存在)。

`_cycle/folders/list`(客户端 → daemon),参数 `{path?, hidden?}`,响应 `{path, parent, home, folders: [{name}], truncated}`:

- `path` 缺省是 daemon 所属用户的主目录;给了就必须是绝对路径,否则以 `-32602` 拒绝。
- 响应的 `path` 是**真实路径**(`realpath`,符号链接已解开):客户端显示它,往下走时用 `path` 加 `name` 拼出下一个。`parent` 是上一级(根目录没有上一级,为 `null`);`home` 是主目录,给"回到主目录"用。
- `folders` 只有**文件夹**,不含文件,更不含内容。指向文件夹的符号链接算文件夹(这是为了能走进 `~/work` 这样的链接),指向别处的不算。名字以 `.` 开头的,只有 `hidden: true` 才给。按名字排序,不分大小写,同序的以字节序为准。
- **有上限**:最多看一个文件夹的 20,000 个条目,最多给 1,000 个;多了带 `truncated: true` 返回已有的。指向别处的符号链接成批地(每批 64 个)去看。
- 路径里有 NUL 字节,以 `-32602` 拒绝;路径穿过一个文件(`/etc/hosts/x`)当作`not_a_folder`。
- 错误:`path` 不存在,`-32002`;不是文件夹或读不了,`-32602`,`data.reason` 是 `not_a_folder` 或 `unreadable`。
- **和 `_cycle/files/search` 不同,它不限定在某个 `cwd` 之内**:选文件夹本来就要走遍整个文件系统。它给出的只有文件夹的名字,而且谁能连上 daemon,谁本来就能让 agent 在这台机器上执行命令;所以没有新增能被利用的东西。仍然只在 loopback、unix socket 或 SSH 通道上服务,不放宽。
- **路径用 `/` 分隔**:v1 只支持 POSIX 的 daemon(Linux、macOS);客户端拼下一级时按这个来。
- 能力 `folders` 为 `true` 才有这个方法。旧 daemon 没有:客户端不提供浏览,用户自己输入路径。

### 搜索对话内容(`_cycle/search`,CYC-342)

⌘K 原本只搜元数据(标题、文件夹、agent、主机)。对话内容的全文在**存历史的 daemon 里**搜,不把整份历史拉到客户端;跨主机的合并和展示由客户端做,不在 L1 里。

`_cycle/search`(客户端 → daemon),参数 `{query, limit?}`,响应 `{hits: [{sessionId, seq, from, snippet}], truncated}`:

- `query`:1 到 200 个字符。一条消息要**含 `query` 里全部的词**(不分大小写)才算命中。词是字母和数字连成的一段,标点和空白只用来分词、本身不参与匹配(`hello, world` 和 `hello world` 一样),按整词匹配;中日韩文字按字符匹配,所以 `登录` 能搜到"登录失败"。没有可搜的词(只有空白或标点)的 `query` 返回空结果,不报错。
- **一条消息**:人发的一条 `user_message`,或 agent 的一条回复。流式回复的多个 `agent_message_chunk`(同一个 `messageId`、前后相接)合成一条回复来搜,词和短语可以跨块;命中的 `seq` 是这条回复**第一块**的序号。一条消息只索引前 100,000 个字符。
- `limit`:1 到 50,缺省 20。多于 `limit` 条命中时只给 `limit` 条,并带 `truncated: true`。
- 搜的是人说的话(`user_message`)和 agent 的回复(`agent_message_chunk`);不搜思考、工具调用及其输出、计划。人的消息里只有文字块被搜:图片、附件、`@` 提及的 session 或文件不进索引。
- 每条命中:`sessionId`;`seq` 是命中那条记录在该 session 历史里的序号,和 `session/update` 的 `_meta["_cycle.seq"]` 同一个序号,客户端用它定位对话位置;`from` 是 `user` 或 `agent`;`snippet` 是含命中词的一段原文(非空,最长约 160 个字符,被截断的一端以 `…` 标出)。
- 顺序:session 按创建时间新的在前,同一个 session 里序号大的在前。
- 没有命中,或还没有任何 session,返回 `{hits: [], truncated: false}`。
- **增量索引**:daemon 在 session 的 JSONL 上建索引,只在内存里,记着每个 session 已处理到的字节位置;每次搜索只读各历史文件**新增**的部分,不重读旧内容。文件变短,或最后一个已索引的行不在原处(压缩改写过)的 session 重建它自己的那一份;读不了的 session 文件这一次跳过,不影响别的 session;已删除的 session 从索引里去掉。索引只存词到序号的对应,不存正文,命中的片段在搜索时分块地从历史里读。第一次搜索要先把所有 session 建进索引。内存和磁盘的量化上限等 CYC-107 的规模基线后再校准。
- 不依赖 session 是否已加载,也不改变任何 session 的状态。
- 能力 `search` 为 `true` 才有这个方法;旧 daemon 没有,客户端跳过对它的搜索,只搜元数据。
- 埋点不在 daemon 里,由前端入口统一上报(只报次数和结果数,不报查询词)。

### 信任文件夹

项目自己的配置里有会**执行命令**的部分:Claude 的 hooks、`.mcp.json` 里 stdio 服务器的命令和 http 服务器的 `headersHelper` 等。agent 只在被信任的文件夹里运行它们。用户级的配置由 Cycle 托管(Claude 的配置目录是 `$CYCLE_HOME/claude`,不是 `~/.claude`),项目级的配置照常加载;"这个文件夹可以运行它自己的命令"这个决定由 Cycle 记下,由 agent 适配交给 agent。理由见决定笔记 [2026-11-19-folder-trust-is-cycles](../.agents/notes/2026-11-19-folder-trust-is-cycles.md)。

- **决定记在 daemon**(它所在的机器上,`$CYCLE_HOME/trust.json`):文件夹的真实路径(`realpath`)到 `true`(信任)或 `false`(不信任)。没有记录就是**没有决定**。
- **管到子文件夹**:一个文件夹的决定适用于它下面的所有文件夹,**离得最近的决定生效**(信任 `/work`、不信任 `/work/x`,则 `/work/x/y` 不信任)。
- `_cycle/trust/read`,参数 `{path}`,响应 `{path, trusted, from}`:`path` 是真实路径;`trusted` 是 `true`、`false`,没有决定时为 `null`;`from` 是这个决定记在哪个文件夹上(`path` 自己或它的上级),没有决定时为 `null`。
- `_cycle/trust/set`,参数 `{path, trusted}`(`trusted` 是布尔),记在 `path` 的真实路径上,响应同 `read`。
- `path` 必须是绝对路径,否则 `-32602`;不存在,`-32002`;不是文件夹或看不了,`-32602`,`data.reason` 是 `not_a_folder` 或 `unreadable`(和 `_cycle/folders/list` 一致)。
- **交给 agent**(L2):daemon 每次启动 agent(`session/new`,以及恢复时的 `session/resume`)都按 session 的 `cwd` 查一次,有决定就在 `_meta["cycle/trusted"]` 里带上 `true` 或 `false`,没有决定就不带。没有决定时 agent 保持它自己原有的状态,不改。Claude 适配的做法见 [docs/adapters/claude.md](adapters/claude.md)。
- **对已有 session 何时生效**:决定在 agent 进程启动时交给它,agent 之后每次起自己的子进程都按它来。所以 `_cycle/trust/set` 之后,daemon 结束这个文件夹(含子文件夹)里每个 session 的 agent 进程:空闲的(没有在跑的 turn、没有排队的 prompt、没有等待回答的请求、没有后台子 agent)立即结束;正在工作或正在启动的,等它下一次这样空闲时结束(turn 结束、最后一个后台子 agent 结束)。下一条 prompt 以新的决定恢复它。
- **客户端**:新建 session 时(空白对话发出第一条消息、`session/new` 之前),`cwd` 没有决定就先问用户(信任并开始、不信任也开始、取消),答案用 `_cycle/trust/set` 记下;不要默认替用户信任。workspace 的菜单里可以改这个决定。
- 能力 `trust` 为 `true` 才有这两个方法。旧 daemon 没有:客户端不问,也不显示。

**发送**:composer 里的 `@路径` 在发送时变成两样东西:

1. 文本块里保留可读的 `@相对路径`,所以历史、其他客户端、别的 agent 都看得懂。
2. 在 prompt 末尾追加一个 `resource_link` 块:`{type: "resource_link", name: 文件名, uri: "file:///绝对路径"}`,文件夹的 `uri` 以 `/` 结尾。同一个 `uri` 只追加一次。结构化引用才是准的:路径里有空格时,文本里的 `@` 形式可能有歧义。

`resource_link` 和图片共用 32 块的上限;超了,多出的 `resource_link` 不发(文字里的 `@路径` 还在,agent 仍读得到路径),文字和图片不受影响。只有文字里还完整写着 `@路径`(前后是空白或标点,不是更长名字的开头)的提及才发。`resource_link` 怎么交给模型是 agent 适配的事:Claude 适配把它写成 XML 标签(见 [docs/adapters/claude.md](adapters/claude.md)),不是协议的一部分。

## 9. 权限请求与交互请求

agent 发来的 `session/request_permission` 和 `elicitation/create` 是**需要回答的请求**,必须能跨越客户端的断线和重连。

1. daemon 收到请求后先写入日志(占一个序号),再转发给所有附着的客户端,同时把 session 的状态置为 `requires_action`:agent 不一定自己发 `requires_action`(Claude 适配就不发),所以 daemon 在状态因此改变时,给已附着的客户端发一条状态快照(和附着时那条一样:`state_update`,没有 `stopReason`,没有 `cycle/seq`,不进日志)。请求被回答或中止、session 不再等人时同样发一次,状态回到 agent 的(通常是 `running`)。这样一直在线的客户端和断线后重连、拿到附着快照的客户端看到的是同一个状态。
2. **第一个到达的响应生效**,daemon 把它转给 agent,并把响应写入日志(占一个序号)。随后给其他客户端发 `_cycle/request_resolved` 通知,带上 `requestId` 和被选中的结果,让它们关闭各自的对话框。后到的响应被丢弃,不报错。
3. 没有客户端附着时,请求保持挂起。新客户端附着时,daemon 在补发之后重新发送所有未解决的请求,并在 `session/resume` 的应答里用 `_meta["cycle/pending"]` 列出它们的 `requestId`。客户端断线前收到过、这里没有列出的请求,在它离线时已被别的客户端答复(或已中止),应关闭对应的对话框。旧 daemon 的应答没有这个字段:客户端不据此关闭任何东西。
4. 客户端收到 `session/cancel` 之后,按 ACP 的规定,所有未解决的权限请求必须以"已取消"的结果回复。这一步由 daemon 代为完成,不依赖客户端。
5. agent 进程退出时,未解决的请求在日志中标记为"已中止",并发 `_cycle/request_resolved`。
6. 子 agent 要的审批(agent 以子 agent 的 `sessionId` 发来,见下面"子 agent")照样是这个 session 的请求,`_meta["cycle/subagentId"]` 是那个子 agent 的 id,客户端据此标出它来自哪个子 agent。没有这个字段的是主 agent 要的。

### elicitation(决策 0011)

`elicitation/create` 用上面同一套机制,差别只有这些:

- 只有在 `initialize` 里声明了 `elicitation.form` 的、已附着的客户端才会被问。请求的 `_meta["cycle/requestId"]` 和权限请求一样。
- 回答是 ACP 的 `{action: "accept" | "decline" | "cancel", content?}`;日志的 `response` 记录整个回答。
- **没有这样的客户端附着时立即回答**(最后一个有能力的客户端断开时,正在等的表单同样如此回答) `{action: "cancel", _meta: {"cycle/noClient": true}}`,不挂起。agent 据此回退:MCP 的 elicitation 当作拒绝,`AskUserQuestion` 走权限请求。
- **表单里填的内容不进日志,也不发给别的客户端**(可能是密码或令牌):agent 拿到完整的回答,日志的 `response` 记录和 `_cycle/request_resolved` 只有 `action`。客户端的回答只取 `action`(`accept`、`decline`、`cancel`)和 `accept` 时的 `content`;别的字段(包括客户端自己加的 `_meta`)丢掉,不是回答的当作 `cancel`。客户端处理不了表单(回了错误)时,和没有客户端一样回 `cycle/noClient`。
- `session/cancel`、agent 退出:未解决的 elicitation 以 `{action: "cancel"}` 结束,并发 `_cycle/request_resolved`。
- agent 自己收回一个请求(JSON-RPC 的 `$/cancel_request`,比如它的回合已经结束、子 agent 被停了):权限请求和 elicitation 一样以取消结束,并发 `_cycle/request_resolved`,不再挂着等人回答。
- URL 模式 v1 不支持,daemon 不声明。
- **`AskUserQuestion` 的表单**:每个问题一个选择字段(`q0`,`q1`…:单选 `oneOf`、多选 `array`)和一个可选的自由输入字段(`q0_other`…,最多 2000 字符)。都没有 `required`:一个字段表达不了"二选一"。自由输入非空时,单选以它为答案,多选把它加在所选标签之后;全部为空等于没回答,工具得到"The user did not answer"。

### 子 agent

`subagent_update`(决策 0014)原样转给客户端:`sessionId` 是子的 id(不是可以打开的 session),`title`、`description`、`state`,以及 `_meta["cycle/subagent"]`:`toolCallId`、`background`、`parentId`、`summary`、`lastTool`、`usage`。客户端不能对子 agent 发 `session/*` 请求(它不是客户端能打开的 session),但可以单独停下一个(下面"停止一个子 agent")。

**停止一个子 agent**(CYCL-143,理由见[决定笔记](../.agents/notes/2026-11-23-stop-one-subagent.md)):

- L1:`_cycle/session/stop_subagent {sessionId, childId}` → `{stopping}`。`sessionId` 是父 session,`childId` 是 `subagent_update` 的 `sessionId`。只停这一个子 agent,父 session 的 turn 和别的子 agent 照常。`stopping: false` 表示没有可停的:它没在跑(已结束、状态未知),或 agent 没说它能停,或 agent 进程不在。它的结束照常以 `subagent_update`(`idle`、`stopReason: "cancelled"`)到达,daemon 不另写记录。daemon 的 `cycle/capabilities.sessionOps` 有 `stopSubagent` 时才有这个方法;没有的 daemon,客户端不提供停止。
- 为什么不是 `session/cancel` 加 `_meta`:旧 daemon 不认识这个 `_meta`,会把整个 turn 取消掉;新方法在旧 daemon 上只是"方法不存在"。
- L2(ACP v2):agent 在 `subagent_update` 里声明 `capabilities.cancel`(补丁规则同 ACP:省略不变,`null` 撤回)。daemon 只对声明了它、还在跑的子 agent,发 `session/cancel {sessionId: <子的 id>}`;这是子 session 的取消,不是父 session 的。
- 客户端只在子 agent 声明了 `cancel`、`state` 还是 `running`、daemon 支持时提供停止。

**子 agent 的对话**(CYCL-134,取代 0014 的"只通告",理由见 [决定笔记](../.agents/notes/2026-11-23-subagent-conversations-are-forwarded.md)):

- L2:agent 先用 `subagent_update` 通告子 agent,之后以子的 id 为 `sessionId` 发 `session/update`(ACP v2 的子 session)。daemon 只认通告过的子 id,没通告过的 `sessionId` 当作父 session 自己的。
- L1:daemon 把它改写成父 session 的一条更新,照常写日志、带父的 `seq`、转发、回放:

  ```json
  {
    "sessionUpdate": "_cycle/child_update",
    "childId": "task_1",
    "update": { "sessionUpdate": "tool_call_update", "toolCallId": "toolu_2", "...": "..." }
  }
  ```

  `childId` 是 `subagent_update` 的 `sessionId`。`update` 只会是 `agent_message(_chunk)`、`agent_thought(_chunk)`、`tool_call_update`、`tool_call_content_chunk`,别的变体 daemon 丢掉;子 agent 的状态只看 `subagent_update`。`update` 里的工具调用和顶层的一样过滤凭证(§12)、检查 `cycle/toolResult`。客户端把它画在启动这个子 agent 的那次调用下面,不当作主 agent 说的话;不认识这个变体的客户端忽略它(§4)。
- 子 agent 的更新不改变 session 的状态,不算"值得看的记录"(§6"已读")。
- 子 agent 又起的子 agent 也这样转发,它的 `subagent_update` 带 `parentId`。
- Claude 的取法见 docs/adapters/claude.md:文字只来整条消息,不流式;子 agent 结束时,它没结束的调用以 `cancelled` 结束。

### 后台任务(`_cycle/task_update`,CYCL-87)

agent 在后台跑的、不是子 agent 的任务:后台命令、Monitor 之类的监视、workflow、MCP 的后台任务。子 agent 仍是上面的 `subagent_update`,不重复发。agent 发 `session/update`,`sessionUpdate: "_cycle/task_update"`,daemon 照常写日志、转发、回放(§12 的凭证过滤按工具调用的规则作用于它):

- `taskId`:任务的 id,同一个任务的各条相同。客户端按它合并:没带的字段沿用上一条。
- `kind`:`shell`、`monitor`、`workflow`、`mcp`、`other`。第一条必带。
- `title`:给人看的一句话(agent 给的任务描述),可能被改写。
- `toolCallId`:启动它的工具调用,知道时带,客户端可以据此跳回对话里的那一行。`parentId`:由某个子 agent 启动时,那个子 agent 的 id。
- `state`:`running`;结束时 `completed`、`failed`、`stopped`;`unknown` 表示它离开了 agent 的后台清单却没有结束的消息(和子 agent 的 `status: "unknown"` 一样,不当作成功)。结束是最后一条,之后同一个 `taskId` 再来 `running` 是它又跑了一次。
- agent 进程退出时,还在跑的任务各发一条 `stopped`。
- 没有停止或打开一个任务的方法;`unknown` 的任务可由用户用 `_cycle/session/dismiss_background` 标记为结束(§6),daemon 写一条 `stopped`。`running` 的任务算进 `cycle/background`(§6),直到它的终态或 `unknown`;所以它和后台子 agent 一样挡住空闲回收(回收会结束 agent 进程,任务跟着结束;信任、运行时、账号变了之后的重启不等它),`cycle stop --wait` 也等它。一直不结束的任务(比如长期的 Monitor)会让 `--wait` 一直等,这时用 `--force`。

Claude 的取法:SDK 的 `task_started`、`task_progress`、`task_updated`、`task_notification` 和 `background_tasks_changed`,`task_type` 不是 `local_agent` 的那些;`ambient`、`skip_transcript` 的(内部的整理任务、自动的监视)不发。`kind` 按 `task_type` 归类,认不出的是 `other`;Monitor 的 `task_type` 和后台命令一样是 `local_bash`,按启动它的工具调用认出 `monitor`,所以同一个任务可能先报 `shell` 再纠正为 `monitor`,客户端以最后带的 `kind` 为准。cron 和 `ScheduleWakeup` 不是后台任务,见下面"定时调用"。

### 定时调用(`_cycle/schedule_update`,CYCL-146)

agent 设好、到点会叫醒这个会话的调用:cron(Claude 的 CronCreate、`/loop`)和唤醒(ScheduleWakeup)。agent 发 `session/update`,`sessionUpdate: "_cycle/schedule_update"`,每次是整份清单,客户端取最后一条为准;daemon 照常写日志、转发、回放(§12 的凭证过滤按工具调用的规则作用于它,`prompt` 是 agent 写的)。schema 是 `@cycle/protocol` 的 `ScheduleUpdateSchema`:

- `jobs`:每项 `id`、`kind`(`cron`、`wakeup`)、`schedule`(五段 cron 表达式,agent 那台机器的本地时间)、`humanSchedule?`(agent 给的说法)、`recurring`、`durable`(存在项目里、比会话活得久;所知的是最后一次听说的)、`prompt`(触发时要说的话,截短)、`nextFireAt?`(预计的下次时间,毫秒时间戳,是推算,不是承诺)、`toolCallId?`(设它的调用,可以跳回对话)。
- `dormant`:为 `true` 时 agent 的进程不在了:不是 `durable` 的,只有在到点前会话又被用到才会触发,否则这一次被跳过。
- 没有这条更新的会话(旧日志、别的 agent)是"不知道",不是"没有";第一次说清单时即使是空的也发。

Claude 的取法:每个 turn 结束时 Stop hook 的 `session_crons` 是进程里全部的(不含 durable 的);两次之间用 CronCreate、CronDelete、CronList、ScheduleWakeup 的结构化结果补上。快照里的唤醒按 prompt 对上设它的调用;没有对上的(比如适配器重启过)当作 `cron`。见 docs/adapters/claude.md。

### 会话的 goal(`_cycle/goal_update`,CYCL-87)

用户给会话设的目标(Claude Code 的 `/goal`):agent 每轮结束时判断是否达成,没达成就继续。agent 发 `session/update`,`sessionUpdate: "_cycle/goal_update"`,`goal` 为 `{condition, iterations, setAt, lastReason?}` 或 `null`(清掉或已达成):

- `condition`:目标的原文;`iterations`:已经检查了几次没达成;`setAt`:设定的时间,毫秒时间戳;`lastReason`:上一次判断没达成的理由。
- 每次变化发一整条,客户端取最后一条为准;daemon 照常写日志,回放即还原。没有这条更新的会话(旧日志、别的 agent)是"不知道",不是"没有 goal"。
- Claude 的取法:SDK 的 `active_goal` 消息,`value` 原样换成上面的字段名。**目前收不到**:Claude Code(SDK 0.3.327)只对云端容器里的进程发这条消息,本地进程没有,所以 Claude 的会话不会有 `goal_update`,客户端按"不知道"显示(CYCL-120,跟进 CYCL-121)。

### 工具调用的结果

工具调用开始或更新时,agent 尽量把结构化目标放进 ACP 的标准字段:命令用 `rawInput.command`(可选 `cwd`),读写编辑用 `rawInput.file_path`/`rawInput.path` 和 `locations`,搜索与抓取用 `rawInput.query`/`rawInput.pattern`/`rawInput.url`,以便客户端无需按 agent 名称特判即可稳定展示摘要与展开详情;历史日志或仅填了 `title`/`locations` 的调用,客户端按结构化字段 → `locations` → `title` 降级读取。

工具调用结束时,agent 尽量用 ACP 自己的字段说它做了什么:编辑是 `diff` 内容(`changes` 加 git 格式的 `patch`,只是这一次调用的改动;太大时 `patch` 为 `null`),
读写的文件在 `locations`(读文件带起始行)。ACP 没有字段的数量,放在这次 `tool_call_update` 的 `_meta["cycle/toolResult"]`,是下面三种之一,只有数字和布尔,**不带内容**:

- `{edit: {additions, deletions, created?, staged?}}`:增删的行数;`created` 为 `true` 是新建的文件;`staged` 为 `true` 是改动被留下等人审、文件没变。
- `{read: {startLine, numLines, totalLines?}}`:从第几行起读了几行,文件共几行。
- `{search: {files, matches?, lines?, more?}}`:找到几个文件,按匹配数或行数计时带上那个数;`more` 为 `true` 是可能还有(被截断、超时、到了上限)。
- `{fetch: {status, bytes?}}`:取一个网页:HTTP 状态码和取到的字节数。
- `{run: {interrupted?, timedOutMs?, background?, exitCode?}}`:命令没有照常跑完时怎么了:被中断;超过时限(毫秒)后转到后台;在后台运行(自己要求的、被转过去的);失败时的退出码。照常跑完是 `{run: {}}`。

网页搜索的结果是 ACP 自己的 `resource_link` 内容项(`uri` 和标题 `name`,不带页面内容),模型在结果之间写的话是文字项,按出现的顺序。
MCP 工具的 `title` 是给人看的名字("server · tool"),由 agent 写,客户端不解析工具名。

命令的输出和错误分开:`content` 里第一项是标准输出,标准错误(不为空时)是另一项,这一项的 `_meta["cycle/stream"]` 为 `"stderr"`。

daemon 原样转发(照常脱敏,§12)。客户端按 ACP 的 `diff` 和这些字段画,不看工具名;daemon 在写进日志时按 `ToolResultSchema`(`@cycle/protocol`)检查,不符合的去掉(和脱敏在同一处,客户端看到的都已检查过),没有这个字段(旧日志、别的 agent)就照旧显示文字。同一个调用后来又发了新的 `content` 而没带这个字段,旧的数量作废。改动被留下等人审、又给不出差异时,是一个 `patch` 为 `null` 的 `diff` 加 `{edit: {additions: 0, deletions: 0, staged: true}}`。

`rawOutput` 只放 `content` 没装下的东西:结果只有文字和图片时不带(读一个文件不必发两遍、记两遍);有别的部分时是原样的结果,已放进 `content` 的图片不重复字节。

## 10. agent 与配置

### agent 清单

`_cycle/agents/list`(无参数)返回 daemon 可用的 agent:

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude",
      "available": true,
      "configSchema": { "...": "JSON Schema,描述该 agent 的可配置项" }
    }
  ]
}
```

`configSchema` 是 JSON Schema,客户端用它渲染配置界面,不需要认识具体 agent。候选配置项(Claude):模型、权限模式、思考强度、MCP 服务、环境变量白名单、系统提示。具体字段在 L3 文档里定义。

可选值有两种写法。只有值:`enum`。值要带给人看的名字和说明:用 JSON Schema 的 `oneOf`,每项是 `{const, title, description?}`,`const` 是值(发给 agent、存进配置的就是它),`title` 是显示名,`description` 说明选了会怎样。agent 建议用的那一项带 `_meta: {"cycle/recommended": true}`,客户端在它旁边标"推荐";需要谨慎选择的高风险项(例如跳过全部权限确认)可带 `_meta: {"cycle/danger": true}`,客户端给予警示;`default` 只说明不设时取哪个值，不代表推荐，两者可以不同。客户端两种都要认:`oneOf` 显示 `title`,并显示 `description`(选项列表里,以及当前选中的那一项);只有 `enum` 时显示值本身。同一个属性不要两种都写。列出的值默认就是全部可取的值:`_cycle/agent_defaults/set` 遇到不在其中的值返回 `-32014`,`data` 里有 `configId`、`value` 和 `allowed`(可取的值),什么都不保存。agent 还接受没列出的值时(例如模型可以写完整的模型名),在这个属性上带 `_meta: {"cycle/open": true}`,列表只是菜单,daemon 不拦。属性带 `_meta: {"cycle/composer": false}` 时，客户端不把它放在输入框旁的选项里，只在 agent 的默认值和会话设置里给出(例如 Claude 的 `advisor`)。

```json
{
  "type": "string",
  "title": "Permission mode",
  "oneOf": [
    {
      "const": "auto",
      "title": "Auto",
      "description": "…",
      "_meta": { "cycle/recommended": true }
    },
    { "const": "default", "title": "Ask before acting", "description": "…" },
    { "const": "plan", "title": "Plan mode", "description": "…" }
  ],
  "default": "auto"
}
```

agent 只在下一轮开始时才采用某个设置的改动时(例如 agy 的 `mode`:实测一轮进行中切换，这一轮余下的工具调用仍按旧模式询问),在 `configSchema` 的这个属性上带 `_meta: {"cycle/nextTurn": true}`。客户端在会话里改它的地方(输入框下的设置菜单、会话设置)说明"从下一轮开始生效";新会话和默认值的表单不显示。没有这个键表示改动立即生效。

session 里 ACP 的 `configOptions` 用 ACP 自己的字段表达同样的东西:`SessionConfigSelectOption` 的 `name`、`description`,推荐项同样在它的 `_meta` 里带 `cycle/recommended`。agent 两边给的名字和说明应当一致。

能把 prompt 插入正在运行的 turn 的 agent 带 `steer: true`(§8 "插入"),没有就是不能。

每个 agent 还有 `promptCapabilities`(ACP 的 `PromptCapabilities`:`image`、`embeddedContext`,缺省都是没有),客户端据此决定是否提供附件入口,daemon 据此校验 prompt(§8)。Claude 的 `model` 用 `oneOf` 给出取值和名字(`default` 叫 "Default model",以及 `sonnet`、`opus`、`haiku`;值不变,0.2.7 之前是只有值的 `enum`,客户端两种都认),`mode` 是权限模式,取值就是 Claude Agent SDK 的 `PermissionMode`:`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`,新 session 默认且推荐 `auto`,各自的名字和说明见 L3 文档。`agy`（Google Antigravity CLI）同样提供 `mode`（`auto` 推荐、`default`、`accept-edits`、`plan`）、开放的 `model`（由会话清单缓存动态填充）与 `effort`（`default`、`low`、`medium`、`high`、`xhigh`，对应 agy 的 `thought_level`），详见 `docs/adapters/agy.md`。

**思考强度(`effort`,CYCL-72)**:Claude 的 `configSchema` 里有 `effort`,`oneOf` 为 `default`、`low`、`medium`、`high`、`xhigh`、`max`,不设时是 `default`。

- `default` 不是一个档位,意思是"Cycle 不覆盖":Claude Code 用用户自己设置里的档位,没有设置时用模型自己的默认。SDK 不告诉我们这时实际是哪一档,所以客户端不得把它当成一个档位的名字;唯一的例外是 Cycle 桌面端按实测把它写作 `medium (default)`(见 docs/desktop.md),选它仍发 `default`。其余各值原样交给 SDK(新进程用 `options.effort`,运行中的进程用 `applyFlagSettings({effortLevel})`,`default` 清掉覆盖)。`max` 只在这个 session 里生效;模型不支持 `max` 时 SDK 按 `high` 跑。
- **哪些模型支持**:来自 SDK 的 `ModelInfo.supportsEffort` 与 `supportedEffortLevels`,不在 Cycle 里写死。session 里 `config_option_update` 的 `model` 选项,每一项在 `_meta["cycle/efforts"]` 里带该模型可选的档位(字符串数组,不含 `default`);空数组表示该模型不支持 effort;没有这个键表示不知道。`effort` 选项的 `options` 是当前模型可选的档位加上 `default`;当前模型不支持时只有 `default`,客户端这时不显示 effort。
- **不知道时**:进程还没报模型清单(新 session 第一个进程起来之前)、或当前模型不在清单里时,`effort` 列出全部档位,值照常交给 SDK,由它决定;清单到了之后,当前值不在当前模型的档位里,adapter 把它改回 `default` 并发 `config_option_update`。换模型时同样:旧档位新模型不支持,改回 `default`(一个值,不按模型分别记)。
- daemon 缓存它见过的模型清单(含各模型的 `cycle/efforts`),叠加到 `_cycle/agents` 返回的 `configSchema` 的 `model.oneOf` 上(同样放在每项的 `_meta["cycle/efforts"]`),新 session 页据此在选模型时决定是否显示 effort、显示哪些档位。缓存只是提示,不做校验:真正可选的档位以 session 里 agent 报的为准。

**自带模型(CYC-300,codex)。** 主人自己的模型服务商(`providers.json`,key 只在 daemon,任何答复只有 `hasKey`)的模型,id 是 `<服务商 id>/<模型 id>`。`_cycle/agents` 返回的 codex `configSchema` 的 `model.oneOf` 里,daemon 现算地追加它们,每项 `_meta["cycle/provider"] = {id, name}`,并带 `cycle/efforts`;这些项不进上面说的缓存。一个 session 要么在 agent 自己的模型上,要么在主人的模型上,由它开始时的模型决定:daemon 在发给 agent 的 `session/new`、`session/resume` 的 `_meta["cycle/model"]` 里带上这个模型。session 里 adapter 报的 `model` 选项只列同一种,另一种的 `setConfigOption` 被拒绝(`-32602`)。每个模型的可选档位由服务商在 pi-ai 清单里的支持集合决定,含 `max` 时不丢掉;上下文窗口是该模型的真实窗口,`usage_update.size` 报 Codex 的有效窗口(真实窗口的 95%)。服务商变化时 daemon 向所有客户端发 `_cycle/providers_changed`(参数 `{}`),客户端重读 `_cycle/providers/list` 和 `_cycle/agents`。决定见 `.agents/notes/2026-11-24-codex-own-models-through-a-pi-ai-gateway.md`。

agent 自己改了配置(例如 Claude 在 plan 模式里被批准后切回常规模式),通过 `config_option_update` 回报;daemon 把变化写进索引的 `config`,恢复时才不会把它改回去。

**标题**:agent 的 `session_info_update.title` 只在用户没有改过名的 session 上生效:`_cycle/session/set_title` 设置的标题优先,之后 agent 给的标题忽略。agent 给出的标题写入索引,`session/list` 的 `_meta.title` 反映它,并发 `_cycle/session_list_changed`。

**临时标题**(CYCL-224):agent 往往在首轮结束后才给标题。session 收到第一条 `session/prompt` 时,如果还没有标题,daemon 立刻用这条消息的开头作临时标题:文字块的第一个非空行,去掉首尾空白、连续空白合成一个空格,超过 60 个字符(按字素数)截断并以 `…` 结尾;消息里没有文字(只有图片或附件)就不设。它和 agent 给的标题同等对待,agent 之后给的标题替换它;用户改过的名字不受影响,之后的 prompt 也不再设。它只写入索引,`session/list` 反映它并发 `_cycle/session_list_changed`,不进日志。标题变化不改 `updatedAt`,列表里的顺序不变。

### 默认配置

- `_cycle/agent_defaults/read`:参数 `{agent}`,返回该 agent 当前的默认配置。
- `_cycle/agent_defaults/set`:参数 `{agent, config}`,daemon 按 `configSchema` 校验后保存,并发 `_cycle/agent_defaults_changed` 通知。

新建 session 时,`cycle/config` 覆盖默认配置。daemon 把 agent 在 `session/new` 应答里报的各项当前值(`configOptions` 的 `currentValue`)也写进 session 的配置记录，再用设置的值覆盖:恢复时整份重发，所以 agent 以后改了新 session 的默认值，已有的 session 不跟着变。`session/new` 的应答里的 `configOptions` 是设置之后的值。恢复时,`session/resume` 应答里有而记录里没有的项(在记录初始值之前建的 session)按应答补记。客户端显示一个已有 session 的配置时,没有记录的项显示为"未设置",不套用 `configSchema` 的 `default`:那是给新 session 的。

恢复时某一项被 agent 拒绝(例如 agent 升级后不再有这个模型或模式),daemon 不把它留在记录里当作仍然生效:记录改为 agent 在 `session/resume` 应答里报的当前值(应答里也没有这项就去掉它),`session/list` 的 `cycle/config` 反映的是实际生效的值,并往该 session 的会话里写一条 `severity: "warning"` 的 `notice`,说明哪一项没有恢复、现在是什么。这发生在下一条 prompt 发出之前。

### session 级配置

session 运行中的配置变更使用 ACP 的 `session/set_config_option`,agent 通过 `config_option_update` 回报当前值。daemon 把最终生效的值写入 session 的配置记录,用于恢复。

### 环境变量

daemon 启动 agent 时只传入显式白名单里的环境变量,不继承自己的环境(AGENTS.md 红线)。白名单是 daemon 的配置,不通过协议修改。

这是 agent **进程**的环境(登录、配置目录、API key)。session 用的环境(§6"环境")是另一件事:它的变量只给 session 跑的命令,不能覆盖这里的设置。

## 11. 错误

沿用 JSON-RPC 2.0 和 ACP v2 的错误码。ACP 已占用:-32700、-32600 到 -32603、-32800(请求取消)、-32000(需要鉴权)、-32002(资源不存在)、-32022(不支持的协议版本)。

- session 不存在,或不属于 Cycle:用 ACP 的 `-32002`,`data` 用 ACP 的 `SessionNotFoundErrorData`。
- 协议版本不兼容:用 ACP 的 `-32022`。
- 其余是 Cycle 自己的,取 -32010 到 -32029,避开 ACP 已用的码(这个范围里有 `-32022`):

| 码     | 名称                | 含义                                                                    |
| ------ | ------------------- | ----------------------------------------------------------------------- |
| -32010 | `session_busy`      | session 正在工作,不接受该操作                                           |
| -32011 | `agent_unavailable` | agent 不可用(未安装、启动失败)                                          |
| -32012 | `agent_exited`      | agent 进程在操作中退出                                                  |
| -32013 | `resume_failed`     | agent 无法恢复该 session。历史仍可读,但不能继续对话                     |
| -32014 | `invalid_config`    | 配置不符合 `configSchema`                                               |
| -32015 | `log_unavailable`   | 历史日志读写失败。写入失败后,该 session 的 prompt 都以它拒绝(§12)       |
| -32016 | `not_queued`        | 要撤回的 prompt 不在队列里(已发出或已退回)                              |
| -32017 | `connector_failed`  | connector 的授权服务器拒绝、不可达(§14)                                 |
| -32018 | `daemon_stopped`    | daemon 停止时 turn 还在进行,turn 被打断(§8"daemon 停止时进行中的 turn") |
| -32019 | `terminal_limit`    | 终端数到了上限(§8"终端")                                                |
| -32020 | `plugin_failed`     | agent 的 plugin 机制没做成:找不到、取不到、被它拒绝(§15)                |
| -32021 | `agent_auth_failed` | agent 订阅认证或登出在运行期失败(§16)                                   |

ACP 以后可能占用这个范围里的码,所以 Cycle 的码在 schema 里集中定义,升级 ACP 时对照检查。

错误的 `data` 里带 `{sessionId?, detail?}`,`detail` 供人阅读,客户端不得解析它。

## 12. 日志格式(daemon 内部,但规定以保证可迁移)

每个 session 一个 JSONL 文件,一行一条记录,字段:

```json
{
  "seq": 12,
  "ts": "2026-11-18T04:00:00.000Z",
  "kind": "update",
  "data": { "sessionUpdate": "agent_message_chunk", "...": "..." }
}
```

`kind` 取值:

- `update`:agent 发来的 `session/update` 内容(daemon 合成的用户消息和 daemon 自己产生的 `_cycle/queue_update` 也是这一类)。
- `request`:agent 发来的需要回答的请求,`data` 含 `requestId`、`method`、`params`。
- `response`:对某个 `request` 的回答,`data` 含 `requestId` 和结果,以及回答来自哪个客户端。
- `aborted`:某个 `request` 被中止。
- 附件的字节(决策 0013):`update` 里 `image` 块的 `data` 和嵌入资源的 `blob`,base64 不小于 16 KiB 时不写进日志,而写在 `<数据目录>/blobs/<sessionId>/<sha256>`,日志里该字段为 `""`,所在对象的 `_meta["cycle/blob"]` 记 `{field, sha256, bytes}`。daemon 读日志时还原,客户端不会看到引用;文件丢了的那一块是 `data: ""` 加 `_meta["cycle/blobMissing"]: true`,其余照常。旧日志里内联的字节照常读。
- `meta`:daemon 自己的事件(session 创建、agent 启动和退出、配置变更)。

要求:

- 只追加。写入单行,崩溃留下的末尾半行在读取时丢弃。
- `seq` 严格递增且连续。读取时发现不连续视为日志损坏,以 `-32015` 报告,不静默跳过。唯一的例外是压缩(下面"压缩"):带 `merged: n` 的记录代表它之前连续的 n 条,所以它的 `seq` 比上一行大 n。
- **命令表去重。** `available_commands_update` 平均 15 KB,agent 常常原样重发。写入前与这个 session 日志里最近一条比较(过滤之后的内容逐字相同),相同就不写、不占 `seq`、不推给客户端(客户端手里已经有那一条)。打开日志时已从读进来的记录里取得最近一条(不再读第二遍),所以重启后 agent 重发同样的表也不会再写;比较和落盘之间不等待,记录仍按 agent 发来的顺序得到 `seq`。
- **压缩。** 打开已有 session 的日志时(没有写入者,也还没有客户端附着),把已结束的相邻文本块并成一条:同一个 `sessionUpdate`(`agent_message_chunk` 或 `agent_thought_chunk`)、除文字外各字段(`messageId`、`_meta`)全等、`content` 只有 `type: "text"` 和 `text` 的一连串记录,首尾两条不动,中间 ≥2 条并成一条:`seq` 取它们最后一条的,`ts` 取第一条的,`text` 依次相接,加 `merged: n`(n 是被并的条数)。首尾不动是因为客户端用第一块的时间当开始、最后一块的时间当结束(思考用时);只并中间的,时间一个都不丢。日志末尾的一串不并(消息可能还在增长)。不改 `seq` 的编号,所以 `readSeq`、`attentionSeq` 和客户端记着的位置都仍然有效;只有一个客户端恰好停在被并的那一段中间(断线后 daemon 重启)才会把那段文字再收一遍。省下的行数不到 32 条不重写文件。写入是先写临时文件并 fsync、再改名,崩溃留下旧文件或新文件;失败就保持原样。`merged` 是日志记录的字段,不在 `data` 里,不发给客户端。
- 日志不包含已知的凭证。写入前过滤,过滤发生在 daemon 把记录交给存储的那一处;客户端收到的是日志写下的那份,所以磁盘、实时推送和重放看到的一样。给客户端的权限请求(它不经过日志)用同一个过滤。规则刻意收得窄,因为猜错会改掉用户自己历史里的内容:
  1. **键名**:`tool_call` / `tool_call_update` 和权限请求里的工具调用(`subject.toolCall`)中,键名表示秘密的值换成 `"[redacted]"`,不论嵌套多深。键名按小写、去掉 `_ - .` 和空格后比较,以 password、passwd、passphrase、secret、apikey、accesskey、privatekey、credential、authorization、cookie 结尾(可带复数 s),或以 token 结尾(单数:`inputTokens` 这类计数不算),或恰好是 auth、bearer、pwd、pin。`{name, value}` 形式的列表(环境变量),`name` 符合上面的规则时换掉 `value`。
  2. **字符串**:工具调用里的所有字符串(命令、输出、文件内容、标题),把确定是凭证的部分换掉:常见令牌形态(`sk-ant-`、`sk-`、GitHub、Slack、AWS、Google、JWT)、私钥块、`Bearer`/`Basic` 后面又长又带数字的串(`Basic configuration` 这类文字不动)、`://用户:密码@主机` 里的密码、等号两边没有空格的赋值(全大写的 `NAME_KEY=值`,即 `cat .env` 的输出;小写的 `token=值`,如查询串)、`--token=值` 这类命令行参数、文本里 JSON 的 `"password": "值"`。等号两边有空格的(`const API_KEY = x`)、`==` 是代码,不动。
  3. **不过滤**:用户和模型说的话(`user_message`、`agent_message_chunk` 等):它们分块到达,模式跨不过块;也是用户自己的话。表单(elicitation)的答案不进日志,见 §9。
     这是已知凭证的过滤,不是保证:没有固定形态、也不在带名字的键里的秘密(命令输出里的一串随机字符)认不出来。已经写下的历史不会被改写,回放时也不会补过滤:升级前的会话里原有的内容仍在盘上,也仍会回放给客户端。

session 索引是另一个文件,记录 sessionId、agent id、agent 侧 session id、`cwd`、归档标记、标题、创建时间,`readSeq` 和 `attentionSeq`(§6"已读"),以及 `turnOpen`(日志里有没有还没结束的 turn,§8"daemon 停止时进行中的 turn";turn 开始和结束时各改写一次,旧索引里没有它时加载时读一次日志)。`lastSeq` 和 `updatedAt` 不存在索引里,以日志为准(`updatedAt` 取最后一条非 `meta` 记录的 `ts`),避免每条记录都改写索引。`attentionSeq` 在每条值得看的记录(通常每个 turn 一两条)后改写一次,`readSeq` 每次标记已读改写一次,都不是每条记录一次。daemon 打开 session 时,若 `readSeq` 或 `attentionSeq` 超过日志的 `lastSeq`(崩溃截掉了日志末尾的半行,之后的 seq 会重新分配),把它们压回 `lastSeq`。

从没有这两个字段的旧索引升级时,两个都按 0 算,所以旧 session 不是未读(升级不会让所有旧 session 变成未读);之后第一个值得看的记录才会让它变成未读。索引整体写入:先写临时文件再改名,崩溃后留下的是旧索引或新索引,不会是半个。索引存在但无法读取时 daemon 拒绝启动,不覆盖它(决策 0002)。

**写入失败。** 日志有一条写不进去(磁盘满、权限、存储故障)时,daemon 不当作没事:

- 这个 session 标记为历史不可写,到 daemon 重启为止(写了一半的行可能留在文件末尾,在同一进程里继续写会把新记录接在它后面;重启时打开日志会把它截掉)。
- 正在跑的 turn 被停止:daemon 向 agent 发 `session/cancel`,等着回答的权限请求和表单按取消回给 agent。
- 已附着的每个客户端收到一条不进日志、不带 `seq` 的 `state_update`:`state: "idle"`、`stopReason: "error"`、`error.code` 为 `-32015`。它走的不是日志(日志正是坏的),所以重放里没有它;之后才附着的客户端,打开时收到的 `state_update` 的 `_meta["cycle/historyFailed"]` 为 `true`,列表行里也有同一个字段。
- 之后的 `session/prompt` 以 `-32015` 拒绝,不启动 agent,不写任何东西。读取已有历史仍可用。
- 权限答复和表单答复在 `response` 记录写成功之后才交给 agent;写不成,agent 得到的是取消,不是客户端的答案。`request` 记录写不成时,请求没有给任何客户端看过,agent 同样得到取消。

同一个 session 同时被几个请求打开(比如两个客户端同时 `session/resume`)时,daemon 只加载一次,日志只有一个写入者;打开日志本身也是先占位再读文件,同一个 session 的第二次打开会被拒绝,打开失败会释放占位。

**读不了。** 日志里有损坏的整行(不是 JSON、不是记录、`seq` 不连续)时,这个 session 的读取以 `-32015` 失败,但只是这一个 session:`session/list` 仍列出所有 session,损坏的那个带 `cycle/historyFailed: true`(§6),其余照常打开、读取、写入。崩溃留下的末尾半行不算损坏,仍在打开时截掉。

日志的写入细节:打开时先把崩溃留下的末尾半行截掉,再追加,否则新记录会接在半行后面,损坏落在文件中间。写入按调用顺序逐条进行,保证序号和文件一致。

## 13. 待定

多客户端领取和后台任务清单的规则分别见 §8 和 §6。

- 排队的上限(8)和"只有 `end_turn` 才自动发下一条"是否合适。
- L3:Claude 适配需要产生哪些 `session/update` 变体,以及配置 schema 的具体字段。
- 日志过滤的规则能否让用户加自己的键名和模式;已有历史是否提供一次性清理。
- fork 时新 session 的 id 怎么分配(Claude SDK 允许 fork 时指定新 id,待验证)。
- 日志的压缩和滚动(上云时再定)。
- 云端 sandbox 下 daemon 与适配进程的连接方向(见决策 0001)。
- ACP v2 稳定后,`session/set_title`、`session/archive` 等 unstable 方法是否替换我们的 `_cycle/session/*`。
- `attentionSeq` 里"值得看"的记录是否还要包括用户取消的 turn(`stopReason: cancelled`)。现在按"都算",因为取消时用户通常在看,客户端会立刻标记已读。
- `cycle/background` 要不要在 daemon 重启后重建:agent 进程已不在,v1 不重建。
- connector(§14):loopback 回调的随机端口哪些授权服务器接受(没有在真实服务器上验证);agent 在云端 sandbox 时网关的地址;正在运行的 agent 要不要在 connector 变化后重启。
- Worktree(§6):Claude 原生 `EnterWorktree` 建出来的 worktree 怎么触发 Cycle 的 setup/cleanup、cwd 变化怎么观察;agy 恢复时换 `cwd` 的真实验证;远程(SSH)工作位置;起始分支是否允许先 fetch。
- plugin(§15):项目级范围;运行中的 session 即时生效(Claude 有 `reloadPlugins`);来源自己声明要运行命令才能取到的 plugin;agent 给 plugin 服务器起的名字变了时怎么发现。

## 14. Connector

connector 是 Cycle 自己管理的 MCP 服务器:在 Cycle 里加一次、授权一次,每个 agent 的每个 session 都能用,不需要在各个 agent 里分别配置。理由和取舍见决定笔记 [2026-11-19-connectors-behind-a-daemon-gateway](../.agents/notes/2026-11-19-connectors-behind-a-daemon-gateway.md)。能力 `connectors` 为 `true` 才有这些方法;旧 daemon 没有时,客户端不显示 connector 的入口。schema 在 `@cycle/protocol` 的 `connectors.ts`。

### 模型

```json
{
  "id": "3f0c…",
  "name": "linear",
  "enabled": true,
  "transport": { "type": "http", "url": "https://mcp.example.com/mcp" },
  "auth": { "type": "oauth" },
  "secrets": { "headers": ["X-Team"], "env": [] },
  "authorized": false,
  "status": { "state": "needs_auth" }
}
```

- `id`:daemon 分配的 UUID,不会变。`name`:交给 agent 时用的服务器名,`[a-z0-9_-]{1,32}`,在这台 daemon 的 connector 里唯一,可以改。
- `transport`:
  - `{type: "http", url}`:streamable HTTP。`url` 必须是 `https`;`http` 只允许 loopback 地址(否则 `insecure_url`)。
  - `{type: "stdio", command, args, cwd?}`:daemon 在自己的机器上启动的进程。`cwd` 是绝对路径;缺省时用 session 的 `cwd`。
- `auth`:`{type: "none"}`,或 `{type: "oauth", clientId?, scopes?}`(只用于 http,否则 `oauth_needs_http`)。按 MCP 的授权规范:protected resource metadata(RFC 9728)、authorization server metadata(RFC 8414)、动态注册(RFC 7591)、PKCE S256、resource 参数(RFC 8707);服务器什么元数据都没有时,退回它所在源的 `/authorize`、`/token`、`/register`。`clientId` 只在服务器不支持动态注册时由用户填(否则 `no_registration`)。
- `secrets`:用户填的密钥**的名字**。http 的 `headers` 加在每个发往服务器的请求上,stdio 的 `env` 是进程的环境变量。值只能写入,永不读出。`Host`、`Content-Type`、`Accept`、`Mcp-Session-Id` 这类由网关自己管的头不能设(`reserved_header`)。
- `authorized`:daemon 有没有这个 connector 的 token。
- `origin`(可缺):`{type: "plugin", agentId, pluginId, pluginName?, server}`(`pluginName` 是显示用的名字,`pluginId` 客户端不拆),表示它是某个 agent 的 plugin 带来的 http 服务器(§15 "plugin 带的 MCP 服务器"),不是用户加的。这样的 connector 由 daemon 随 plugin 建立、停用和删除:`update` 只能写 `secrets`,改别的字段和 `remove` 都以 `managed` 拒绝;授权的三个方法照常。它只交给 `agentId` 那个 agent 的 session。没有 `origin` 的是用户自己加的。
- `requires`(可缺):这个 connector 要用户填值的名字(plugin 的请求头里写的 `${NAME}`)。值经 `update` 的 `secrets.env` 写入;`secrets.env` 里列出的是已经有值的。有名字还没值时 `status.state` 是 `needs_auth`。
- `status.state`:`disabled`(关着)、`needs_auth`(oauth 没有 token,或 token 被拒、刷新也失败)、`error`(附带 `status.reason`:`unreachable`、`auth_failed`、`spawn_failed`、`protocol`)、`ready`。它是 daemon 最近一次知道的情况,不是实时探测;daemon 重启后从 `ready` 或 `needs_auth` 重新开始。

### 方法(客户端 → daemon)

| 方法                            | 参数                                                 | 响应                         |
| ------------------------------- | ---------------------------------------------------- | ---------------------------- |
| `_cycle/connectors/list`        | 无                                                   | `{connectors}`               |
| `_cycle/connectors/add`         | `{name, enabled?, transport, auth, secrets?}`        | `{connector}`                |
| `_cycle/connectors/update`      | `{id, name?, enabled?, transport?, auth?, secrets?}` | `{connector}`                |
| `_cycle/connectors/remove`      | `{id}`                                               | `{}`                         |
| `_cycle/connectors/auth/start`  | `{id, redirectUri}`                                  | `{flowId, authorizationUrl}` |
| `_cycle/connectors/auth/finish` | `{flowId, code?, state?, error?}`                    | `{connector}`                |
| `_cycle/connectors/auth/clear`  | `{id}`                                               | `{connector}`                |

- **密钥只进不出**:`secrets` 是 `{headers?: {名字: 值}, env?: {名字: 值}}`,只出现在 `add` 和 `update` 的参数里。没提到的名字保留原值,值为 `null` 表示删除。daemon 不在任何响应、通知、日志里回传密钥或 token。
- **换了地址或授权方式,旧 token 作废**:`update` 改了服务器的地址(stdio 是命令、参数、目录)、授权方式或 `clientId` 时(改名字、开关、scopes 不算),daemon 先尽力向授权服务器撤销,再删掉 token 和注册信息,不会把旧服务器的 token 发给新地址。用户填的 `secrets` 保留(是用户自己的决定)。
- **授权**:
  1. 客户端在**自己这一侧**开一个 loopback 回调(`http://127.0.0.1:<端口>/callback`),把它作为 `redirectUri` 调 `auth/start`。`redirectUri` 必须是 loopback 的 http。
  2. daemon 做发现、按需动态注册、生成 PKCE 和 `state`,返回 `authorizationUrl`。verifier 只在 daemon 的内存里。
  3. 客户端在系统浏览器里打开它,接到回调后把 `code`、`state`(或授权服务器给的 `error`)交给 `auth/finish`;daemon 校验 `state`,换 token,存进凭证库。
  4. 动态注册得到的 client 会被复用:回调只换了端口时算同一个(RFC 8252 §7.3),不重新注册。
  5. 一个 `flowId` 10 分钟内有效,只能用一次(错的 `state` 也会用掉它);同一个 connector 开新的流程,旧的作废;daemon 重启,流程都没了。
- `auth/clear` 尽力撤销并删掉 token 和注册信息。`remove` 同时删掉清单条目和全部凭证,客户端必须先向用户确认。
- 有变化(增删改、授权、状态变了)时,daemon 向每个连接发 `_cycle/connectors_changed`(无参数),客户端重新 `list`。

### 交给 agent(L2)

- daemon **每次启动 agent**(`session/new`,以及恢复时的 `session/resume`)时,把当时所有 `enabled` 的 connector 放进 L2 的 `mcpServers`,每个是一个 http 条目:`{type: "http", name, url: "http://127.0.0.1:<端口>/mcp/<connectorId>", headers: [{name: "Authorization", value: "Bearer <key>"}]}`。所以新加或打开的 connector,在 agent 下次启动时生效;正在运行的 agent 不变。
- 只给在 `initialize` 里声明了 `capabilities.session.mcp.http` 的 agent。session 自己的 `mcpServers`(§6)和 connector 重名时,session 自己的优先,那个 connector 不给这个 session。
- **key** 每次启动 agent 时新生成,只能访问这次给它的 connector,agent 退出就失效。它不是任何账号的 token。
- **网关**只绑 `127.0.0.1`,`Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`(否则 421),没有 key 是 401。请求头和响应头都按白名单转发:agent 的 `Authorization` 不发给服务器,服务器的 `WWW-Authenticate` 不回给 agent(否则 agent 会自己去登录)。不跟随重定向(它会把 token 带到别处)。服务器回 401 时,daemon 用 refresh token 刷新一次再重发;同一个 connector 同时只刷新一次;刷新得到的 token 只在凭证没被改过时写入,期间的退出登录或重新登录优先。还是不行就把它标成 `needs_auth`。
- **stdio** 的进程由 daemon 启动,每个 session 每个 connector 一个,在 agent 第一次用到时启动,agent 退出时结束。环境变量只有 `PATH`、`HOME`、`USER`、`LANG`、`LC_ALL`、`TMPDIR`(取自 daemon 的环境)加上它自己的 `secrets.env`;它的 stderr 丢弃(可能打印密钥)。网关把它当 streamable HTTP 提供:POST 写入消息、回复按 JSON 返回(agent 取消或放弃的请求不再等待);GET 是它主动发的消息的事件流;DELETE 结束它。改了它的环境变量值或关掉它,正在运行的进程随即结束。

### 错误

- `id` 或 `flowId` 不存在、已用过、已过期:`-32002`。
- 参数不合法:`-32602`,`data.reason` 是固定的词:`name_taken`、`insecure_url`、`oauth_needs_http`、`invalid_cwd`、`reserved_header`、`state_mismatch`、`no_registration`、`managed`;名字格式不对是 schema 校验的 `-32602`。
- 授权服务器拒绝或不可达:`-32017`(`connector_failed`),`data.reason` 是 `auth_rejected` 或 `unreachable`,`detail` 只说状态码之类,不含 token。

## 15. Plugin

plugin 是某个 agent 自己的扩展包(skill、命令、子 agent、hook、MCP 服务器)。**它归 agent**:格式、来源、安装位置都是那个 agent 的,daemon 让 agent 自己的机制去装,L1 只给出与 agent 无关的字段。理由、实测和取舍见决定笔记 [2026-11-23-plugins-are-the-agents-their-mcp-is-cycles](../.agents/notes/2026-11-23-plugins-are-the-agents-their-mcp-is-cycles.md)。能力 `plugins` 是支持 plugin 的 agent 的 id 列表;没有这个能力或列表为空时,客户端不显示 plugin 的入口。schema 在 `@cycle/protocol` 的 `plugins.ts`。

### 模型

```json
{
  "agentId": "claude",
  "id": "linear@anthropic-plugin-directory",
  "name": "linear",
  "description": "Linear issue tracking integration.",
  "version": "1.0.0",
  "sourceId": "anthropic-plugin-directory",
  "installed": true,
  "enabled": true,
  "scope": "user",
  "contents": { "skills": 0, "commands": 0, "agents": 0, "hooks": 0, "mcpServers": 1 },
  "servers": [{ "name": "linear", "by": "cycle", "connectorId": "3f0c…" }]
}
```

- `builtin?`:`true` 表示它随 Cycle 一起发(`packages/clawdot-plugins`),由 daemon 静默装好。能停用(`set_enabled`),不能卸载:`uninstall` 以 `plugin_failed`、`reason: "failed"` 拒绝。客户端不显示它的卸载入口。`icon?`:它的图片,`data:image/…;base64,…`(不超过约 60 KB),取自 plugin 目录里的 `assets/icon.svg`(或 `icon.png`);只有内置的有,agent 自己的 plugin 没有。Claude、Codex、agy 的清单都没有通用的图标字段,所以这是 Cycle 一层的约定。

- `agentId`:它是哪个 agent 的。`id`:在这个 agent 里唯一,**客户端不解析它**(Claude 的是 `名字@来源`,别的 agent 可以是别的)。
- `name`、`description?`、`version?`:显示用,原样来自 plugin 或它的来源。
- `sourceId`:它来自哪个来源(下面的 `PluginSource.id`)。
- `installed`。只有已安装的才有后面这些:
  - `enabled`:开着没有。
  - `scope`:`user`(这台 daemon 上这个 agent 的所有 session)或 `project`。v1 只安装和启停 `user`。
  - `contents`:它带了什么,各类的个数。`hooks`、`mcpServers` 和 `commands` 是会运行代码的部分。
  - `servers`:它带的 MCP 服务器。`by: "cycle"` 是经 Cycle 的网关提供的,`connectorId` 是对应的 connector(§14,带 `origin`),登录和填密钥都在那个 connector 上做;`by: "agent"` 是 agent 自己启动的(stdio 等),Cycle 不经手。

来源(`PluginSource`):`{agentId, id, name, kind, location?, removable}`。`kind` 是固定的词:`builtin`(agent 自带的目录,不能移除)、`git`、`directory`、`url`、`other`。`location` 是用户当初给的地址,显示用。

### 方法(客户端 → daemon)

| 方法                             | 参数                                            | 响应                            |
| -------------------------------- | ----------------------------------------------- | ------------------------------- |
| `_cycle/plugins/list`            | `{agentId}`                                     | `{sources, plugins}`(已安装的)  |
| `_cycle/plugins/available`       | `{agentId, sourceId?, query?, cursor?, limit?}` | `{plugins, nextCursor?, total}` |
| `_cycle/plugins/install`         | `{agentId, id, acknowledged: true}`             | `{plugin}`                      |
| `_cycle/plugins/uninstall`       | `{agentId, id}`                                 | `{}`                            |
| `_cycle/plugins/update`          | `{agentId, id}`                                 | `{plugin, updated}`             |
| `_cycle/plugins/set_enabled`     | `{agentId, id, enabled}`                        | `{plugin}`                      |
| `_cycle/plugins/sources/add`     | `{agentId, location, acknowledged: true}`       | `{source}`                      |
| `_cycle/plugins/sources/remove`  | `{agentId, id}`                                 | `{}`                            |
| `_cycle/plugins/sources/refresh` | `{agentId, id?}`                                | `{}`                            |

- `available` 是可以装的(已装的也在里面,`installed` 为 `true`),按来源、再按名字排。内置目录有几千项,所以分页:`limit` 默认 50、最多 200;`query` 在名字和说明里找,不分大小写;`total` 是符合条件的总数。daemon 会缓存 agent 给的清单,`sources/refresh` 让它重新取(不给 `id` 是全部来源)。
- **安装要确认**:plugin 可以在 daemon 的机器上运行代码(hook、命令、MCP 服务器)。`install` 和 `sources/add` 必须带 `acknowledged: true`,客户端在用户确认之后才带;没带是 `-32602`、`not_acknowledged`。装完以后 `contents` 说明它实际带了什么。
- `sources/add` 的 `location` 交给 agent 解释(Claude:`owner/repo`、git 或 https 地址、daemon 机器上的路径)。
- `uninstall` 同时删掉它带来的 connector 和它们的凭证;客户端必须先向用户确认。
- 这些操作由 agent 自己的机制执行(Claude:用和 session 相同的白名单环境、在 Cycle 托管的配置目录里运行 `claude plugin …`),可能联网、要几秒到几十秒。同一个 agent 的写操作一次只做一个,后来的排队。
- 有变化时 daemon 向每个连接发 `_cycle/plugins_changed`,参数 `{agentId}`,客户端重新 `list`。失败的改动之后也发(它可能做了一半)。plugin 带来的 connector 变了,另有 `_cycle/connectors_changed`。
- **内置 plugin**:daemon 启动后,在后台为每个有 plugin 的 agent 装好随 Cycle 发的那一批(Claude、Codex 把 `clawdot-plugins` 目录作为名为 `clawdot` 的本地 marketplace 加进去再装;agy 按目录装,它自己转换格式)。装过的不再问,随 Cycle 发的版本更新了就更新;用户停用的保持停用。失败(agent 没装好、没有权限)不影响任何事,下次启动这个 agent 之前再试。这一批是 Cycle 自己的代码,所以不要求 `acknowledged`。
- **生效**:下次启动这个 agent 时(新 session,或恢复一个 session);正在运行的 agent 不变。

### plugin 带的 MCP 服务器

- plugin 已安装并启用时,daemon 为它声明的每个 **http** 服务器建一个带 `origin` 的 connector(§14):地址是 plugin 写的;请求头里不含变量的原样带上,含 `${NAME}` 的把名字列进 `requires`,值由用户填;一开始按不需要登录对待,建立时探一次,探到或之后转发时收到 401,就改成 `auth: {type: "oauth"}`、`needs_auth`(plugin 自己带凭证的不改:请求头里有 `Authorization` 或有要用户填的值时,401 说明那个值不对)。请求头里除 `${NAME}` 以外的变量写法(默认值、plugin 自己的选项)daemon 代不了,这样的服务器留给 agent。plugin 停用,它们随之停用(凭证保留);卸载,随之删除;更新后地址变了,按 §14 作废旧 token,用户填过的值也一并清掉、重新问(不把给旧地址的密钥发到新地址)。daemon 在每次启动这个 agent 之前,先向 agent 问一次已装的 plugin(只问已装的,不问来源;一分钟内问过就不再问,最多等 3 秒),把这些 connector 对齐,因为 plugin 可能在没人看的时候变了。只管用户级安装的 plugin。
- 启动这个 agent 时,daemon 把它们放进 L2 的 `mcpServers`,**名字用 agent 给这个服务器起的名字**(由 agent 的 plugin 实现给出;Claude 是 `plugin:<plugin 名>:<服务器名>`)。agent 见到同名条目,就用它顶替 plugin 自己声明的那个:请求都经网关,token 不到达 agent,工具名和 plugin 自己写的一致。还没登录的也照样给(网关回 401,agent 看到的是连不上),否则 agent 会绕过网关自己去连、自己去登录。
- 地址不是 `https`(或指向本机的 `http`)、地址里带变量、或者不是 http 的服务器(stdio、sse),不建 connector,由 agent 自己启动,`by: "agent"`。它们在 agent 的进程里运行,用的是 agent 的环境(§10 "环境变量"的白名单)。

### 错误

- `agentId` 不存在或不支持 plugin、`id` 不存在:`-32002`。
- 没确认:`-32602`,`data.reason` 是 `not_acknowledged`。
- agent 的机制没做成:`-32020`(`plugin_failed`),`data.reason` 是固定的词:`not_found`(来源里没有这个 plugin,或来源取不到)、`needs_command`(来源要先运行它声明的命令,v1 不支持)、`unavailable`(agent 的程序不在或起不来)、`timeout`、`failed`(其余);`detail` 是 agent 的原话,供人阅读。

## 16. Harness 状态、认证与运行时配置

用于 Settings → Harness 页查询各 agent 的可用性、订阅账号态、套餐用量、Cycle 托管的运行时配置和只读宿主诊断,并在界面内驱动订阅登录与登出。schema 在 `@cycle/protocol` 的 `agent-setup.ts`,完整设计见 [harness-settings.md](harness-settings.md)。

- **能力协商**:daemon 在 `initialize` 响应的 `_meta["cycle/capabilities"]` 里声明单一布尔位 `agentSetup: true`。未声明该能力的旧 daemon,客户端不调用本节任何方法,Settings → Harness 页平滑降级为仅展示会话默认配置(`_cycle/agent_defaults/*`)。
- **凭证安全边界**:
  - 长期凭证(OAuth access token、refresh token、API key)永不经 L1 传输。
  - `environment.allowEnv` 与 `environment.envNames` 以及 `auth.viaEnv` **只返回环境变量名,绝不返回值**。
  - hosted-callback 登录模式(`"code"`)中用户粘贴的一次性授权码是短期凭证,经 `_cycle/agent_auth/submit` 送至 daemon 仅在内存中写入登录子进程 stdin,永不落盘、永不进 session JSONL 或 `daemon.log`,受 PKCE 绑定、`flowId` 单次消费与 10 分钟 TTL 约束。

### 只读快照(`_cycle/agent_setup/read`)

- 参数:`{ agent, refreshUsage?, forceRefresh? }`
  - `agent`:agent id(如 `"claude"`、`"codex"`、`"agy"`);未知 agent 返回 `-32602`(`data.reason: "unknown_agent"`)。
  - `refreshUsage`:为 `true` 且该 agent 支持主动查询套餐用量(如 Codex `account/rateLimits/read`)时同步刷新 `planUsage`。
  - `forceRefresh`:为 `true` 时绕过 daemon 侧对只读探测的短 TTL 缓存(如 `agy models`)。
- 响应 `AgentSetupSnapshot`:
  - `agent`、`name`、`available`:agent 标识、显示名与当前是否可用。
  - `binary`:`{ source: "builtin" | "configured" | "path" | "missing", path?, version?, minVersion?, problem?: "missing" | "version_too_old" | "probe_failed" }`。
  - `auth`:
    - `state`:`"binary_unavailable" | "signed_out" | "signing_in" | "signed_in" | "signing_out" | "auth_unknown"`。无法可靠判定时必须报 `auth_unknown` 并带固定 `unknownReason`(`"network_error" | "timeout" | "probe_failed"`),不得把探测失败误报为未登录。
    - `method`:`"subscription" | "api_key" | "oauth_token" | "third_party" | "none" | "unknown"`。
    - `viaEnv?`:若 `config.json` 通过环境变量覆盖了账号鉴权,只给变量名(如 `"ANTHROPIC_API_KEY"`),绝不给值。
    - `account?`:`{ email?, organization?, plan?, expiresAt?, tierObservedAt? }`。其中 `tierObservedAt` 为被动观测档位(如 `agy` 的 `_meta.antigravity.tier`)的毫秒时间戳,登出后清空。
    - `signInModes`:daemon 为该 agent 声明的有序登录模式数组,每项 `{ mode: "browser" | "code" | "device_code", requiresLocalLoopback: boolean }`。环境是客户端概念,由客户端(桌面主进程 `ConnectionManager`)按本地/远程传输过滤并选用合适模式,daemon 在发起登录时二次校验。
    - `canSignOut`:布尔,是否支持界面内登出。
    - `loginCommand`:始终保留的可复制兜底命令(如 `"cycle login claude"`)。
  - `planUsage?`:复用 §8 的 `PlanUsage`。
  - `canRefreshUsage`:布尔,是否支持通过 `refreshUsage: true` 主动拉取用量。
  - `runtime`:`{ schemaVersion: 1, schema: { type: "object", properties }, values, overrides, revision, fileError? }`。
    - `schema` 复用 §10 的 `configSchema` JSON Schema 风格,限定为封闭版本化子集(Phase 2 细化可编辑字段与 `_cycle/agent_setup/set_runtime` / `_cycle/agent_setup_changed`)。客户端遇到不认识的属性类型时降级为只读展示,不得整页报错。
    - `revision` 为该 agent 独立的单调递增整数(未写过为 `0`);`fileError` 在 `<dataDir>/agent-settings.json` 损坏或版本未知时存在,值固定为 `"agent-settings.json is unreadable"`(路径和解析错误只进 `daemon.log`);文件不可读期间每次读取快照或写入都会重读它,修好或移走后自动恢复。文件里不符合该 agent schema 的值(未知键、类型不符、越界)在加载时丢弃并记日志。
  - `environment`:
    - `configFile`:`{ path, exists, stale, error? }`。`stale` 表示 `config.json` 的修改时间晚于 daemon 启动时刻,需重启 daemon 后生效。
    - `dataDir`、`customDataDir`:Cycle 为该 agent 托管的状态目录及是否在 `config.json` 中自定义。
    - `allowEnv`、`envNames`:只包含变量名列表,绝不含值。

### 运行时配置(`_cycle/agent_setup/set_runtime` 与 `_cycle/agent_setup_changed`)

- **封闭版本化 `configSchema` 子集(`schemaVersion: 1`)**:`runtime.schema` 沿用 §10 的 JSON Schema 风格(`{ type: "object", properties }`),每个可编辑属性仅允许以下三种受控类型:
  1. `type: "boolean"`(`title`、`description?`、`default: boolean`、`_meta?`)
  2. `type: "integer"`(`title`、`description?`、`minimum`、`maximum`、`multipleOf?`、`default: number`、`_meta?`)
  3. `type: "string"` + `oneOf: [{ const, title, description?, _meta? }]`(`title`、`description?`、`default: string`、`_meta?`)
  - 允许的 `_meta` 键:
    - `_meta["cycle/applyScope"]`:`"immediate" | "next_session" | "next_idle_restart" | "daemon_restart"`
    - `_meta["cycle/enabledWhen"]`:`{ key: string, equals: boolean | number | string }`
    - `_meta["cycle/danger"]`:`true`
  - 客户端遇到未来版本新增的不认识属性类型时,必须降级为只读展示,不得整页报错。
- **`_cycle/agent_setup/set_runtime`**:
  - 参数:`{ agent, patch: Record<string, boolean | number | string | null>, expectedRevision: number }`。
  - `patch` 为局部修改;字段值为 `null` 表示删除 `<dataDir>/agent-settings.json` 中的显式覆盖,恢复继承 `config.json` 或字段默认值。
  - 合并优先级:`agent-settings.json` > `config.json` > schema 默认值。
  - 每个 agent 维护独立的单调递增整数 `revision`(未写过为 `0`)。若 `expectedRevision` 与当前该 agent 的 `revision` 不一致,返回 `-32602`(`data.reason: "revision_conflict"`)。
  - 未知字段、类型不符、越界值,或 `<dataDir>/agent-settings.json` 损坏/版本未知(`fileError`)拒绝覆写时,返回 `-32014`(`invalid_config`)。
  - 响应:`{ values, overrides, revision }`。
- **`_cycle/agent_setup_changed`**(daemon → 客户端通知):
  - 载荷:`{ agent, revision? }`,在运行时配置保存、登录完成或登出后广播给所有已连接客户端,提示刷新快照。

### 订阅登录与登出(`_cycle/agent_auth/*` 与 `_cycle/agent_auth_completed`)

用于桌面端在界面内发起各 agent 的订阅登录与登出,同时保证长期凭证不经过 L1、单 agent 操作串行互斥、登录流程绑定发起连接且断线即清理:

| 方法 / 通知                   | 方向              | 参数 / 载荷                                              | 响应                                                                          |
| ----------------------------- | ----------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `_cycle/agent_auth/start`     | C → D             | `{ agent, mode?: "browser" \| "code" \| "device_code" }` | `{ flowId, mode, expiresAt, authorizationUrl?, verificationUrl?, userCode? }` |
| `_cycle/agent_auth/submit`    | C → D             | `{ flowId, code }`                                       | `{ ok: true }`                                                                |
| `_cycle/agent_auth/cancel`    | C → D             | `{ flowId }`                                             | `{}`                                                                          |
| `_cycle/agent_auth/logout`    | C → D             | `{ agent }`                                              | `{}`                                                                          |
| `_cycle/agent_setup/prewarm`  | C → D             | `{ agent }`                                              | `{}`                                                                          |
| `_cycle/agent_auth_completed` | D → C(仅发起连接) | `{ flowId, agent, ok, reason? }`                         | —                                                                             |

- **模式选择与校验**:客户端按本地/远程传输从 `auth.signInModes` 过滤并选择 `mode`(远程环境跳过 `requiresLocalLoopback: true`);daemon 二次校验 `mode` 必须属于该 agent 当前允许的 `signInModes`,否则返回 `-32602`(`data.reason: "unsupported_mode"`)。若 agent 二进制不可用,返回 `-32021`(`binary_unavailable`)。
- **单 agent 互斥**:同一 agent 同时最多运行 1 个活跃登录流或登出操作;并发调用返回 `-32021`(`auth_in_progress`),不强杀已有流程。
- **`flowId` 连接绑定与单次消费**:`flowId`(随机 UUID)绑定 `(connectionId, agent, flowId)`,仅发起连接可调用 `submit` / `cancel`(其他连接返回 `-32602` `flow_forbidden`)。`submit` 仅适用于 `"code"` 模式,状态机单向流转 `pending → submitting | cancelled | expired → completed`,原子单次消费(重复提交返回 `-32602` `flow_consumed`,与 `cancel` 竞争失败返回 `-32602` `flow_not_active`)。
- **一次性授权码边界**:`_cycle/agent_auth/submit` 中的 `code` 仅驻留内存并一次性送入登录子进程 stdin,绝不落盘、绝不进 session JSONL / `daemon.log` / 错误对象。
- **TTL 与断线/退出清理**:每个登录流固定 10 分钟 TTL(`expiresAt` 为毫秒时间戳)。发起连接断开、TTL 到期或 daemon 关闭时,daemon 立即终止对应登录子进程,不留孤儿进程。
- **完成通知范围**:`_cycle/agent_auth_completed` **仅推送给发起该流程的连接**,用于更新该客户端的登录弹窗态;全局状态刷新统一通过 `_cycle/agent_setup_changed` 广播给所有客户端。
- **提前起进程**(`agentPrewarm: true`):空白页选中某个 agent 时,客户端发 `_cycle/agent_setup/prewarm`。agent 的定义声明了 `standby`(进程的启动与 `initialize` 和 session 的 cwd、MCP、环境无关,目前是 agy)时,daemon 先起好并初始化一个,每个 agent 最多一个;下一个要起这个 agent 的 session 直接接手它(日志 `agent_standby_taken`),不再起新的。没人接手时 5 分钟后释放(`agent_standby_expired`);该 agent 的账号或运行时设置变了、daemon 停止时同样释放。不能提前起、起失败都回 `{}`,由 session 自己起并报原因。
- **登出、登录与会话生命周期**:`_cycle/agent_auth/logout` 成功,或登录流以 `ok: true` 完成时,账号可能已经换了,两者走同一套处理:不中断运行中 turn 或后台任务;立即终止该 agent 未发过 prompt 的预热进程,将其余运行中或启动中的 session 标为 `stale` 并复用空闲重启路径(`#restartIfStale`;正在 `session/new` 里、还没登记的 session 在登记后立即回收);清空 daemon 内存中该 agent 的 `planUsage`、观测档位时间与只读探测缓存,向所有连接发 `_cycle/plan_usage_changed`(`windows: []`),并广播 `_cycle/agent_setup_changed`。标为 `stale`(账号原因)的旧进程在回收前报的套餐用量不再记下。
- **断线与关闭**:发起连接在 `start` 尚未返回时断开,该 agent 的互斥锁保持到驱动的启动结束、子进程被取消之后才释放;daemon 关闭时等待进行中的启动与登出结束(有上限)。连接已断,daemon 不再发 `_cycle/agent_auth_completed`;`disconnected` 只是客户端(主进程埋点)的说法,不是协议里的 `reason`。

### 错误约定

本节所有错误沿用数字 `code` + 固定词 `data.reason`,**绝不透传原始 stderr、URL、路径或授权码**:

- 参数/状态校验错误:`-32602`,固定 `data.reason`:`unknown_agent`、`unsupported_mode`、`flow_not_found`、`flow_forbidden`、`flow_consumed`、`flow_not_active`、`revision_conflict`。
- 运行时配置校验错误:`-32014`(`invalid_config`),附带 `data.field` / `data.reason`。
- 认证或登出运行期失败:`-32021`(`agent_auth_failed`),固定 `data.reason`:`binary_unavailable`、`auth_in_progress`、`parse_failed`、`invalid_code`、`expired`、`cancelled`、`process_failed`、`timeout`。

### 本地存储(`_cycle/storage/*`,CYC-277)

每个 agent 在 Cycle 托管的目录里会积下东西:包管理的下载缓存(`.bun/install/cache`、`.npm/_cacache`、`.npm/_npx`、`Library/Caches`、`.cache/uv`)和它自己的会话记录(`projects`、`sessions`)。尺寸和清理都在 daemon 所在的机器上,客户端按 location 显示。

- **能力协商**:`initialize` 响应的 `_meta["cycle/capabilities"]` 有 `storage: true` 才有这两个方法;旧 daemon 上客户端不显示这一块。
- **读取**(`_cycle/storage/read`,`{}` → `{agents: [{agent, name, managed, items: [{id, kind, bytes}]}]}`):`kind` 为 `cache`(要用时会再下载,清掉只多一次下载)或 `history`(会话恢复要读的记录,只显示,不提供清理)。尺寸用 `du -skP` 量,不跟链接,总共 60 秒封顶,量不到的按 0。各 agent 的托管目录取 harness 声明的 `storageDir`(未声明时回落到 `cli.env` 里的 `HOME`;`config.json` 的覆盖也算),因此 Claude/Codex 透传宿主 `HOME` 时仍只量各自的 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`,绝不把宿主 `HOME` 当托管目录(CYC-401),协议层不认具体的 agent。
- **只清缓存**(`_cycle/storage/clean`,`{agent}` → `{cleaned: true, freedBytes}` 或 `{cleaned: false, problem, message}`):只删上面五个缓存目录,每个先 `lstat`,是链接就跳过,路径上有链接而落到 HOME 之外也跳过。**从不**碰 HOME 整个、登录状态(`.gemini`、`auth.json`)、`.local`、`Library/Application Support`、`plugins/`、`claude-env/`、Cycle 的 sessions/blobs/JSON 存储,以及 agent 替用户写的文件(`code/`、`Desktop/`)。
- **`problem`**:`busy`——该 agent 有会话在回合中、等待回答或有后台任务,清缓存可能把正在跑的 `bun install` 弄坏,等它结束;`unmanaged`——它的 HOME 不在 daemon 的数据目录之内(用户把 `configDir`/`home` 指到了自己的文件夹),什么都不量不删;`unknown_agent`;`failed`——有缓存要删但一个都没删成(权限之类)。清理中途该 agent 起了新回合,会在下一个目录之前停下并回 `busy`,已经删掉的不恢复。一个目录读不了或超过 30 秒没量完,只是不出现在 `items` 里,不影响别的。`read` 对这样的 agent 返回 `managed: false` 和空 `items`。
- 客户端清理之前要让用户确认,并说明下次用到时会重新下载。

## 17. Loop 服务

Loop 服务(`cloud/loop`)是独立于 daemon 的进程:一个进程服务多个 Project,和 daemon 在同一台机器上。桌面端像连 daemon 一样连它,但它不是 daemon,也不转发 ACP;本节只定义桌面端读它的方法。理由见决定笔记 [2026-11-25-loop-server-is-its-own-process](../.agents/notes/2026-11-25-loop-server-is-its-own-process.md)。schema 在 `@cycle/protocol` 的 `loop.ts`,桌面端只依赖这些类型,不依赖 `cloud/loop` 的代码。

- **常驻流水线**:server 进程(`cloud/loop/src/cli.ts`)启动时,只读 `loop.json` 一个文件(每个 Project 条目里除 `name`、`projectKey`、`repo`、`token` 外还有流水线字段 `repoRoot`、`stateDir`、`planKey` 等,字段含义见 `config-file.ts`;流水线 CLI 读同一份),为每个 Project 建好流水线(tracker、store、锁、daemon 连接,经本机 `daemon.sock`)后,才打开 `loop.sock` 并一起开始,按各自 `run.json` 接着做未完成的工单;某个 Project 缺流水线必填字段、或任一 Project 建不起来,进程启动失败并说明原因。流水线不依赖 socket 上有没有客户端。协议方法不变。
- **启停(CYC-456)**:启动就是 `bun cloud/loop/src/cli.ts`(或交给进程守护如 systemd/launchd 拉起),不设配置开关,也没有协议方法,桌面端不启停。停止靠信号:第一次 `SIGINT`/`SIGTERM` 让各 worker 在当前步完成后退出,不开始新的一步,进程干净退出(码 0)、关 `loop.sock`、释放锁;第二次立即释放各 Project 的锁并以码 130 退出(释放卡住时第三次信号直接退出)。信号处理在各 Project 建好、socket 打开之后才装上,启动期间收到信号会直接终止进程,锁随之留下,下次启动按锁的陈旧判断处理。被杀的 Loop 重启后按各 `run.json` 接着做。进程守护应发 `SIGTERM`,并把停止等待时间设得比一步和空闲间隔(默认 60 秒,空闲的 worker 睡满一个间隔才看到停止)都长,否则会被强杀,下次靠 `run.json` 恢复。
- **传输**:JSON-RPC 2.0,换行分隔(§2)。本地是 daemon 数据目录里的 unix socket `loop.sock`。经 SSH 连远端的 Loop 服务还没做;客户端连不上时,按"未连接"处理,不报协议错误。
- **没有握手和鉴权**:同 §1 的 v1 约定,能连上 socket 的是本机同一用户。
- **Project 的来源**:服务启动时读一个配置文件(模式必须是 `0600`,组或其他人可读就拒绝启动,附固定原因 `config_mode`)。里面每个 Project 有名字、`projectKey`、仓库地址、forge 类型和访问令牌。令牌只在这个文件里,**任何方法都不返回令牌**,错误对象也不带它。

### 方法(客户端 → Loop 服务)

| 方法            | 参数 | 响应         |
| --------------- | ---- | ------------ |
| `projects/list` | 无   | `{projects}` |
| `runs/list`     | 无   | `{projects}` |
| `events/list`   | 见下 | 见下         |

```json
{
  "projects": [
    {
      "name": "Cycle",
      "projectKey": "CYC",
      "repo": { "displayName": "clawdot/cycle", "forge": "github" }
    }
  ]
}
```

- `name`:配置里给的显示名。`projectKey`:itsaplan 的 Project 键(如 `CYC`),在这台服务里唯一。
- `repo.displayName`:`owner/name` 形式,从仓库地址取,不含主机、协议和凭据。`repo.forge`:`github` 或 `gitlab`。
- 响应里没有令牌、仓库完整地址和本地路径。以后加字段(运行状态、调度)时仍遵守这一条:能让别人拿到凭据或路径的字段不进这个方法。
- 服务只读本进程的配置,不访问 itsaplan;看板内容由桌面端用使用者自己的账号读(见决定笔记 [2026-11-25-desktop-holds-a-personal-itsaplan-key-for-now](../.agents/notes/2026-11-25-desktop-holds-a-personal-itsaplan-key-for-now.md))。

### 运行记录(`runs/list`,CYC-390)

返回配置里每个 Project 的运行记录,数据读自 Loop 现有的 `<stateDir>/runs/<KEY>/run.json`(每张工单一份)。用来纠正"In Progress 即在跑"的已知误差;工单所处阶段不在这里,改用工单字段(CYC-442、CYC-443)。

```json
{
  "projects": [
    {
      "projectKey": "CYC",
      "runs": [
        {
          "key": "CYC-390",
          "kind": "dev",
          "state": "active",
          "startedAt": "2026-11-26T01:00:00.000Z",
          "updatedAt": "2026-11-26T02:00:00.000Z"
        }
      ]
    }
  ]
}
```

- 数据位置:读 `<stateDir>/runs/<KEY>/run.json`。服务配置格式不变,不含 `stateDir`;各 Project 的 `stateDir` 由启动服务的一方提供,配置合并(CYC-455)后改读合并后的配置。不发给客户端。
- 每个配置里的 Project 都有一项,顺序同 `projects/list`;`runs/` 下还没有记录的 Project 返回 `runs: []`。某个 `run.json` 损坏或读不出来、或键与目录名不符时,该条被跳过,服务在日志里写固定原因和 Project 键,不写路径。某个 Project 的 `stateDir` 未知、不存在或 `runs/` 读不了时,整个调用返回 `-32603`(`Internal error`),不返回空列表,客户端不要把它当成"没在跑"。`runs` 按 `key` 排序;符号链接不跟随。
- `kind`:`dev` 或 `research`。`state`:`done`(阶段为 done)、`blocked`(阶段为 blocked)、其余为 `active`。含已结束的记录,客户端自己按 `state` 过滤。
- **`active` 不保证进程还活着**:Loop 异常退出后 `run.json` 还在,仍是 `active`。怎样判断运行仍然活着(待确认,心跳或锁)还没定,定了再加字段;在此之前客户端用 `updatedAt` 的新旧自行判断,不要把 `active` 当成"正在跑"的证明。
- 字段逐个挑出,不含工单标题、阶段细节、worktree、分支、会话、PR 地址和阻塞原因。响应里没有令牌、仓库完整地址和本地路径。
- 不提供 `loop/start`、`loop/stop`;事件流见下一节。

### 运行事件流(`events/list`,CYC-457)

按 `seq` 续传的事件流,数据读自 `<stateDir>/events.jsonl`(Loop 现有的全局事件日志,每个 Project 一份)。采用**客户端按 `seq` 轮询的方法**,不是服务推送的通知:连接断开后没有订阅状态要恢复,重连只需带上最后收到的 `seq`。桌面端想要"实时"就短间隔轮询;`hasMore` 为真时立即再取。

| 方法          | 参数                              | 响应                                     |
| ------------- | --------------------------------- | ---------------------------------------- |
| `events/list` | `{projectKey, afterSeq?, limit?}` | `{projectKey, events, lastSeq, hasMore}` |

```json
{
  "projectKey": "CYC",
  "events": [{ "seq": 41, "ts": "2026-11-26T02:00:00.000Z", "run": "CYC-390", "kind": "phase" }],
  "lastSeq": 41,
  "hasMore": false
}
```

- **`seq`**:事件在 `events.jsonl` 里的行号,从 1 起。文件只追加,所以同一条事件永远是同一个 `seq`,不会有两个;`seq` 严格递增。由服务读文件时按行号赋,引擎不改,旧行同样有 `seq`。没写完(还没有换行)的最后一行等写完再发;不是事件的行(损坏)占一个号但不发,所以 `seq` 可能有空洞,客户端不要假设连续。
- **续传**:`afterSeq` 默认 0(从头),只返回 `seq > afterSeq` 的事件,按 `seq` 升序;`limit` 默认 500,最大 1000,按看过的行数算(损坏行也占一个),所以一页的事件可能少于 `limit`;`hasMore` 为真时剩下的行可能全是损坏行,多问一次得到空页即可。`lastSeq` 是下次要带的值(返回的最后一条,没有就等于 `afterSeq`;被跳过的损坏行也计入,所以不会反复读到)。
- **`seq` 太旧**:现在文件不截断、不轮转,任何 `seq` 都还在。以后若要轮转,`seq` 已不在文件里时返回 `-32602`,`data.reason` 为 `seq_gone`,客户端从 0 重取并自行去重。
- **`seq` 超前**:`afterSeq` 大于文件现有行数(文件被换掉了),返回 `-32602`,`data.reason` 为 `seq_ahead`,客户端从 0 重取。已知限制:换掉后的新文件若已长过 `afterSeq`,检测不到,客户端会从新内容中间续传;现在没有任何东西会换文件,真要轮转时再加文件标识。
- `projectKey` 不在配置里或参数不合法:`-32602`。`stateDir` 未知或文件读不了:`-32603`(同 `runs/list`),不返回空列表。
- 每条事件只有 `seq`、`ts`、`run`(工单号或 `plan-<轮次>`)、`kind` 四个字段,其余字段一律不发(行里的附加字段可能含路径或地址)。响应里没有令牌、仓库完整地址和本地路径。
- 不提供 `loop/start`、`loop/stop`;阶段显示归 CYC-442、CYC-443。

### 工单状态按钮(桌面端写 itsaplan,CYC-387)

写入不经过 Loop 服务:桌面主进程用使用者自己的 key 直接写 itsaplan,审计上分得清是人批准的。页面只有三个按钮,不支持拖动:

- `approve` 批准:Backlog 移到 Todo 并打 `auto`。**必须确认**:主进程在 `confirmed !== true` 时什么都不写。
- `to_backlog` 退回 Backlog:从 Todo 或 Doing 退回,同时去掉 `auto`。默认不确认。
- `to_todo` 放回 Todo:从 Doing 放回。默认不确认。
- Done 没有按钮;Doing 里带 `auto` 的是 Loop 在处理的,也没有按钮。按钮由主进程按列的状态类型和 `auto` 标签决定,写之前再读一次工单,位置变了就拒绝(`not_allowed`)。
- 失败给固定词,不透传 itsaplan 的文字:`unconfirmed`、`no_key`、`forbidden`(401/403)、`conflict`(409)、`not_allowed`、`offline`、`refused`。

### 与工单对话(桌面端,CYC-389)

工单页的"与 agent 对话"按钮:桌面主进程再读一次工单,按列的状态类型决定,然后用本机 daemon 新开会话。

- Backlog / Todo(`chat: "new"`;Todo 里带 `auto` 的是排给 Loop 的,Loop 会自己接手,所以为 `none`,要细化先退回 Backlog):新开 codex 会话,模型取该 agent 在设置里的默认模型;第一条消息带工单号,agent 通过 itsaplan connector 读写工单,凭据由网关注入。不限制 agent 的工具(CYC-375 的强制部分推迟)。
- In Progress(按启动列的角色,第一个启动列;`chat: "watch"`):只读旁观,不提供对话。这一列暂时被当作"Loop 正在跑"的判据;已知误差:Loop 异常退出留在 In Progress 的工单会被误判为在跑,CYC-390 用运行数据纠正。其余列(In Review、Blocked,接入原会话见 CYC-388)为 `none`。
- **工作目录**:ticket 对话的会话跑在专用目录 `<Cycle 数据目录>/ticket-chat/`(安装版是 `~/.cycle/ticket-chat/`),首次使用时创建;不用用户的主目录,也没有默认回退(没配置目录就不创建会话)。
- 会话已创建但第一条消息没发出去:失败结果带上 `sessionId`,页面给出"打开这个会话"。
- 默认模型没设:不创建会话,返回 `needs_model`,页面提示去设置里配置,而不是创建失败。
- 失败给固定词:`needs_model`、`not_allowed`(工单已不在可对话的列)、`no_key`、`offline`(连不上 itsaplan)、`refused`、`failed`(agent 没能启动或没收下消息)、`no_folder`(工作目录建不了)、`auth_required`。埋点 `loop_ticket_chat` 只记结果。

### Notice:需要人处理的事(桌面端派生,CYC-388)

Loop 页顶部的 Notice 区由桌面主进程从两处派生,不依赖 Loop 服务,也不存储、不记历史和已读:一条 Notice 在它的原因消失时就消失。

- **来源和顺序**(按需要人处理的紧迫度):`permission`(daemon 里 Dev 会话在等权限或表单,会话标题为 `[<工单号>] Dev`,工单号属于该 Project)、`blocked`(Blocked 列的工单)、`review`(评审升级给人的工单)。
- **列的角色**沿用 Loop 的约定(`cloud/loop/src/project.ts`):`started` 列按看板顺序,第 2 个是 In Review,第 3 个是 Blocked。
- **原因取自 Loop 留在工单里的评论**(读 `list_issue_activity`,经 `execute_read`):Blocked 取 `自动化在「<阶段>」卡住了：<原因>`,并从「现场已保留：Dev 会话「[<工单号>] Dev」」取要接入的会话名;评审升级只看以 `已开 PR：<地址>` 开头的**最新**评论(评论按时间排序,不依赖接口顺序),且只在 PR 行后 Loop 写的固定标题行里找"升级给人"或"需要人工处理"(合并评论的标题行带评审自己写的摘要,不算);取结论和 PR/MR 地址。评论读不到时整次读取算失败(不猜),已知的 Notice 不变。读不到评论时 Notice 仍在,原因为空。In Review 里不是评审升级的(如 PR 在自动化之外合并),不生成 Notice。
- **Blocked 的按钮**:Loop 在 Blocked 已停手,所以带 `auto` 的 Blocked 工单也有"退回 Backlog"和"放回 Todo"(放回 Todo 不动标签,Loop 会在原会话里继续)。Doing 里其他带 `auto` 的仍没有按钮。
- **接入会话**:工单页的"接入开发会话"按会话名在已连接的工作位置里找 `[<工单号>] Dev`,找到就在会话区打开,人在那里回答权限、给指示。
- **系统通知**:只对 `blocked` 和 `review` 发。主进程每分钟读一次每个 Project(同一时刻只有一次在读),与上一次比较,只对新出现的发;每个 Project 第一次读不发;读失败不改变已知状态;因窗口在前台没有弹出的,不算已见,下次再发。页面打开时每 30 秒也重读 Notice。`permission` 不发:会话自己的 attention 通知(`needs-you`)已经管,再发会重复。窗口在前台时不发。
- **埋点**:`loop_notices_read`(各类几条)、`loop_notice_notified`(`kind`)、`loop_notice_opened`(`kind`)、`loop_session_joined`;不含原因、标题或评论文字。

### `loop/` 方法:看板、run、Notice、批量批准(CYC-482)

桌面端和运营 agent 之后只调这组方法,itsaplan 只在 Loop 内部对接一处,不再解析评论、不再写死标签名。决定见 [2026-11-26-loop-api-is-the-only-way-in](../.agents/notes/2026-11-26-loop-api-is-the-only-way-in.md)。**本节取代上文"服务不访问 itsaplan""工单状态按钮(桌面端写 itsaplan)""Notice(桌面端派生)"三处**:桌面端改用这组方法由下一张单做,在那之前它们仍是桌面端现在的行为。`projects/list`、`runs/list`、`events/list` 保持原名;新方法在 `loop/` 下,`loop/projects/list` 与 `projects/list` 同。schema 在 `loop.ts`,每个返回都按它校验。

| 方法                 | 参数                                                            | 返回                                                   |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| `loop/projects/list` | 无                                                              | `{projects}`                                           |
| `loop/board/get`     | `{project}`                                                     | `{project, columns, stale, readAt}`                    |
| `loop/runs/list`     | `{project, filter?: {state?}}`                                  | `{project, runs}`                                      |
| `loop/run/get`       | `{project, key}`                                                | 阶段、轮次、会话 `{kind,id}`、PR、最近 50 条事件、心跳 |
| `loop/notices/list`  | `{project?}`                                                    | `{notices}`                                            |
| `loop/ticket/get`    | `{project, key}`                                                | 单张工单的详情(见下)                                   |
| `loop/tickets/act`   | `{project, verb, keys[], reason?, confirmed, actor, actorKind}` | `{results}`                                            |
| `loop/intents/retry` | `{project, id?, key?, actor, actorKind}`                        | `{retried}`(重新排队的 intent 数)                      |
| `loop/status`        | 无                                                              | `{version, restartedAt, projects}`                     |

- **看板**:server 用 `planKey` 读 itsaplan,列按 stateType(backlog、unstarted、started、completed、canceled)再按看板顺序;完成和取消的列只取最近 30 张。卡片有编号、标题、类型名、优先级、标签名、`pendingReason`(带 `待批准` 的卡,取最新评论首行,最多 20 张、140 字,读不到为 `null`)、`phase`(只对 started 列里有未完成 run 的卡,`{name, since}` 取自 run 的 `phase` 和 `updatedAt`,不读 tracker 自定义字段;心跳在 `run/get` 和 `stuck` Notice 里用)。缓存 15 秒;读失败时返回上一次的结果并标 `stale: true`(`readAt` 仍是上次成功的时间);第一次就失败返回 `-32603`,`data.reason` 为 `tracker_unreachable`。
- **run**:`state` 为 `active`/`blocked`/`done`;`filter.state` 过滤。`run/get` 的会话是 `{kind, id}`(kind:`dev`、`qa`、`review`、`research`、`research_qa`、`triage`、`shape`、`shape_qa`),run 不存在返回 `-32602`,`data.reason` 为 `unknown_run`。
- **Notice**:`kind` 为 `permission`、`blocked`、`review`、`stuck`、`intent_stuck`、`supervisor`、`operator`;每条有 `project`、工单 `key`、`session`(种类和 id,可为 `null`)、`text`、`at`。来源:`runs`(Blocked 的 run 直接带 `resumeFrom` 对应的会话,不解析评论)、`notices` 表(`permission` 在会话等权限时由 Loop 写,会话种类不限:Dev、QA、评审、调研、规划;其余种类由写入方写)、`intents` 里卡住的(`intent_stuck`)、心跳超过 15 分钟没动的未完成 run(`stuck`)。**寿命**:`blocked`、`intent_stuck` 在原因存在时就在;表里的 Notice 在它的 run 结束、或 run 记录在 Notice 之后又更新(已往前走)时消失;`permission` 每个 run 只显示最新一条,且超过 24 小时不再显示。
- **`loop/tickets/act`**:`verb` 为 `approve`(移到 Todo,打 `auto`,摘 `待批准`)或 `return`(摘 `待批准`,打 `Loop 跳过`)。每张**重读**,只在它还在 Backlog 且带 `待批准` 时才写;标签和列按名字/stateType 每次从 `get_project` 解析(名字来自配置,默认 `auto`、`待批准`、`Loop 跳过`),改名后不用重启。先写标签、再移列,移列失败会尽量还原标签。`approve` 必须 `confirmed: true`,否则整次请求 `-32602`(`unconfirmed`),什么都不写;`return` 不要求确认。`approve` 总是发一条评论,`return` 有 `reason` 才发,末尾是「由 <actor> 在桌面端批准/退回」(`actorKind` 为 `operator` 时写「经运营 agent」)。每张结果:`{key, status: "ok"}`、`{status: "skipped", reason}`(`not_found`、`not_in_backlog`、`not_pending`)、`{status: "failed", reason}`(`offline`、`forbidden`、`conflict`、`label_missing`、`refused`),不透传 itsaplan 的文字;重复的 key 只做一次。每张(含 skipped、failed)写一条 `actions`(`ticket_approve`/`ticket_return`,带 `actor`、`actorKind`、结果)。这些写入直接写,不走对账。同一 Project 的写请求一个接一个做。
- **`loop/ticket/get`(CYC-493)**:单张工单,给工单页用。规则从桌面端搬来,在 Loop server 里一处实现。返回 `{identifier, title, priority, column, actions, chat, body, attention?, acceptance, links}`:
  - `column` 是列名;`actions` 是 `approve`、`to_backlog`、`to_todo` 的子集;`chat` 为 `new`、`watch`、`none`。列的角色沿用 Loop 的约定:`started` 列按看板顺序,第 1 个是 In Progress,第 2 个是 In Review,第 3 个是 Blocked。
  - `actions`:Backlog 有 `approve`;Todo(`unstarted`)只有 `to_backlog`;进行中的列(`started`)里带 `auto` 且不是 Blocked 的归 Loop,没有按钮,否则 `to_backlog`、`to_todo`;Done、Canceled 没有。
  - `chat`:Backlog 为 `new`;Todo 不带 `auto` 为 `new`,带 `auto` 为 `none`(Loop 会自己接手);In Progress 为 `watch`;其余 `none`。开对话的会话仍由桌面端经 daemon 创建,这里只告诉能不能开。
  - `acceptance`:正文里 `## 验收标准`(或 `## Acceptance criteria`)一节的各条;`links`:正文和 development 链接里的 PR/MR 地址,只要 https。
  - `attention` 只取 Loop 自己的记录,不解析评论:Blocked 列且 Loop 有该工单 `blocked` 的 run 时为 `{kind: "blocked", text: <原因>, session: {kind,id}|null}`;In Review 列且 `notices` 表里有 `review` 类 Notice(同上文的寿命规则)时为 `{kind: "review", text, prUrl: string|null}`。Loop 没有记录的(例如人手动移到 Blocked 的)不给 `attention`。
  - 标签和列按名字、stateType 每次从 `get_project` 解析。工单不存在返回 `-32602`,`data.reason` 为 `not_found`;读不到 itsaplan 返回 `-32603`,`data.reason` 为 `tracker_unreachable`。
- **`to_backlog`、`to_todo`(CYC-493)**:`loop/tickets/act` 的两个新 `verb`,都不要求确认。每张**重读**,按上面的 `actions` 判断仍可用才写,否则该张 `skipped`(`reason: not_allowed`,工单不存在为 `not_found`)。`to_backlog` 移到 `backlog` 类里看板顺序最前的列,同时摘掉 `auto`;`to_todo` 移到 `unstarted` 类里看板顺序最前的列(Paused 也是 unstarted,但不是 Todo),不动标签。先写标签、再移列,移列失败尽量还原标签。有 `reason` 时发评论,末尾是「由 <actor> 在桌面端退回 Backlog/放回 Todo」(`operator` 写「经运营 agent」)。每张写一条 `actions`(`ticket_to_backlog`/`ticket_to_todo`)。直接写,不走对账。`approve`、`return` 的 `skipped` 原因仍是上面几个;`not_allowed` 只出现在这两个新 verb。
- **对账的重试与 `loop/intents/retry`(CYC-497)**:Loop 写给 tracker 的评论、移列、标签和阶段字段是 intent,由对账按工单依次执行。失败按种类处理:网络错误、超时、5xx **不计入** `attempts`,intent 留在 `pending`,按它自己的 `next_at` 退避重试(30 秒、1、2、4 分钟,上限 10 分钟),所以 tracker 断网多久都不会让它 `stuck`;其他错误照旧计数,超过 10 次标 `stuck`;`tracker.get` 明确返回找不到(工单被删),直接标 `stuck`,原因 `not_found`,不重试。**同一张工单**里,前面有 `stuck` 的评论或移列时,后面的评论和移列不执行、保持 `pending`(先评论再移列);标签照旧,阶段字段是另一条 lane,不受影响。卡住时只有一条 Notice(`intent_stuck`,来自 `intents` 里卡住的那条);重新排队后它随之消失。
  - `loop/intents/retry`:把 `stuck` 的 intent 改回 `pending`、`attempts` 和退避清零、`next_at` 清空,下一次对账就执行。`id` 指一条,`key` 指这张工单(如 `CYC-390`)的全部卡住的 intent;两者必须给且只给一个,否则 `-32602`(`invalid_params`)。`id` 不存在返回 `-32602`(`not_found`);不是 `stuck` 的什么都不改。需要 `actor` 和 `actorKind`(缺则 `actor_required`,什么都不写)。每条重新排队的 intent 写一条 `actions`(`intent_retry`,带 `intentId`、`actor`、`actorKind`)。返回 `{retried}`。
- **`actor` 和 `actorKind`**:写方法必须带,`actorKind` 只认 `desktop`、`operator`;缺或不合法返回 `-32602`,`data.reason` 为 `actor_required`,什么都不写。**这不是认证**:能连上 `loop.sock` 的就是本机同一用户,`actor` 是自报的;写入用 Loop 自己的 itsaplan key,所以 itsaplan 的审计里是 Loop,评论和 `actions` 才是谁做的记录。剩余风险见决定笔记。
- **`loop/status`**:`version`(Loop 所在发行版本)、`restartedAt`(本进程启动时间)、每个 Project 的 `workers` 数和未结束且不在 Blocked 的 run(`key`、`kind`、`phase`)。
- **socket**:仍是 `<dataDir>/loop.sock`,`0600`;一行最多 1 MB(1,048,576 字节),超过不等换行就断开连接。
- **埋点**:只记行为,不含工单内容:每次调用写一行日志 `loop api <方法名> <结果计数>`(如 `ok=2 skipped=1 failed=0`),没有工单号、标题、原因或 actor。不向 PostHog 发(Loop 服务不在 Electron 主进程里,桌面端改用这组方法时再在主进程埋点)。

### 错误

沿用 §11 的数字 `code`;`data.reason` 固定词,不透传路径或令牌。未知方法返回 `-32601`。
