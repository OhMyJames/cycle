# 架构治理进度

审计基线为 `95bb58db`。依赖边以各 workspace 的 manifest 为准。用 `bun scripts/module-graph.ts > modules.dot` 导出完整生产模块图。门禁使用同一个图检查环，失败时显示闭环路径。在 Loop 验证重构后的快照（8a35fd75）上有 482 个文件、1,405 条边，覆盖 workspace 的 src 下 TS/TSX 文件、相对路径与包导出、字面量动态加载和 require。计算生成的模块名、纯类型依赖和进程间 RPC 各有不同语义。

## 模块、依赖与状态所有权

| 模块                         | 负责的状态或契约                                                                         | 直接生产依赖（仓库内）                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| apps/desktop                 | Electron 主进程持有连接、待回答请求和窗口设置，页面经 preload bridge 发起操作            | analytics、client、oidc、protocol、ui                          |
| apps/daemon                  | 会话生命周期、JSONL 历史、环境、工作树、终端和 connector 凭证；CLI 用 client 连接 daemon | client、三个 harness、model-gateway、protocol、clawdot-plugins |
| cloud/loop                   | 工单执行状态、运行记录、交付流程；通过 L1 驱动任务                                       | client、protocol                                               |
| harness/claude               | Claude SDK 会话和 ACP 适配状态                                                           | protocol                                                       |
| harness/codex、harness/agy   | 各自的子进程状态与 ACP 更新映射                                                          | command-permissions、line-rpc、protocol                        |
| packages/client              | L1 请求、连接、订阅和重放游标                                                            | protocol                                                       |
| packages/protocol            | Cycle 的 wire schema、方法、错误码与元数据                                               | 无                                                             |
| packages/ui                  | 纯会话投影、页面 store、组件和样式；令牌见 DESIGN.md                                     | analytics                                                      |
| packages/analytics           | 事件字典、字段校验、发送开关与 PostHog 客户端                                            | 无                                                             |
| packages/command-permissions | 命令前缀规则。授权集合由各适配器的会话持有                                               | 无                                                             |
| packages/line-rpc            | 行协议子进程通信与请求关联                                                               | 无                                                             |
| packages/oidc                | 桌面登录协议                                                                             | 无                                                             |
| packages/model-gateway       | provider 请求适配与网关                                                                  | protocol                                                       |
| packages/clawdot-plugins     | 随 daemon 分发的插件资源                                                                 | 无                                                             |

以上生产依赖图无环。开发依赖中 client 和 daemon 成环：client 的集成测试启动 daemon，daemon CLI 的 stop 等命令需要 client。增量测试应同时覆盖两者。进程通信方向、会话数据流与传输约束见 [架构](architecture.md)，主进程内部的写入者见 [桌面端](desktop.md)。

## 已核对的取舍与任务池

| 范围                 | 证据、处置与验收依据                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工具链、目录所有权   | 增量选包与 ACP catalog 门禁曾各复制一份目录 glob。二者改读根清单，重叠模式去重。用自定义目录和未注册目录作回归样例。                                                                             |
| 持久化与缓存         | daemon 的 JsonFile 串行修改并在写失败时回滚内存。desktop 的 KeptEntries 在持久化成功后确认未知字段和条目。保留两端各自的契约，见两个 json-file.ts 和各自的调用方。                               |
| 分层约束             | 分区门禁已迁移至 Oxc 语法树。删除自制词法器，保留类型、动态导入和 require 检查。原压力测试在本机用时约 0.5 秒，上限 3 秒。                                                                       |
| UI、状态与业务模型   | Harness 已迁入 LocationScope，与订阅、API keys、Vault 共用位置选择、断线保留、能力回退与空状态。每页原有的能力缓存寿命保留。曝光由选中的 Harness 上报，浏览器用例核对两次位置曝光。              |
| 错误、重试、可观测性 | 桌面主进程的终端限额、connector 和配置保存错误改读协议字典。纯 UI 模型沿用分区约束，由重发测试以 CycleErrorCode 校验四种失败投影。client 持有连接重连的退避计时，Loop 主进程轮询按项目独立退避。 |
| 配置、权限与身份     | 三种 harness 的 CLI 与适配器均经各自 env 函数进入 harnessEnv。共同处理白名单、系统代理和显式覆盖，专用目录由适配器决定。system-proxy.test.ts 校验目录冲突时的优先级和宿主秘密隔离。              |

Loop 的节点和整单验证现在各创建一次 verificationPass。每次验证独享结果缓存、隔离目录和超时配置，节点重试事件带 nodeId。目标 bun test 的退出码、跳过计数和证据说明在 criteria.ts 一处判定。整单测试层和工单验收条件仍由各自调用方选择。

Codex 与 agy 曾以互不导入为由复制审批前缀函数。迁移前比较了实现和测试，去除注释、空白后实现一致，测试样例完全一致。共享包只提供纯函数，两个适配器保留各自的权限请求与会话级测试。见[审批规则所有权决定](../.agents/notes/2026-11-27-shared-command-prefix-policy.md)。

埋点门禁按 AST 的 typeOnly 信息检查页面导入。事件字典可以出现在类型位置，混合导入、重导出值、动态加载、相对路径直达 analytics 和直接加载 PostHog 都有回归覆盖。

Electron 通知由 BackgroundNotifications 管理窗口检查、保活、释放与前台恢复。attention.ts 保留会话标题和目标，loop-alerts.ts 保留工单去重、暂缓重试及点击目标。两处均通过既有测试验证。

设置页的二进制诊断共用 UnavailableBinary，空白页和设置页的安装提示来自同一函数。旧 daemon、加载失败和 sign-in 刷新仍由各自的页面负责。
