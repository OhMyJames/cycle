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

门禁压力复审在同一开发机、独立 Bun 进程中进行。原词法器处理旧压力输入时峰值约 156 MiB。初版语法树路径约 668 MiB；没有任何字符串或模板分隔符时直接返回后，同组输入约 53 MiB。另测五万行后带真实导入的输入，约 62 MiB，正确识别末尾导入。这是单进程数据，CI 的内存仍取决于并行负载。

两次完整门禁曾在 stop.test.ts 的等待用例超时，单文件复跑十轮通过。夹具已改为先观察到运行状态，再验证 stop 连续读到忙碌会话后仍不发信号。修改后单文件二十轮共 160 项通过，完整门禁也通过。

## 修改一个概念时从哪里开始

| 概念                 | 写入者与读者                                                                                                                                         | 修改时的验证入口                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 会话事件、恢复、重连 | daemon 的 session 与 log 保存顺序、请求和结果。client 按 seq 续订；桌面 watcher 提供视图；UI model 将更新投影为会话。                                | daemon 的 log、replay、queue 用例，client 重连用例，web 集成         |
| 权限和表单           | daemon 登记 pending，并将请求写入会话日志。桌面 pending 管理向用户展示的请求；回答返回 daemon 后由 daemon 结算。适配器持有原生请求及会话内审批记忆。 | daemon 的 permission、elicitation、abort 用例及各适配器的审批测试    |
| 工作位置、环境与配置 | 桌面 settings、environments 保存用户定义。daemon 的 config 负责进程启动，agent-settings 持有运行时覆盖，options-cache 只保存可重新发现的选项。       | 各 store 的文件兼容性用例、daemon 的配置与代理测试、设置页浏览器测试 |
| 身份与凭据           | desktop 主进程的 accountStoreFor 选择账号存储。打包版本使用 safeStorage。connector 的 OAuth 和上游凭据由 daemon 管理，agent 会话经本地网关使用服务。 | desktop 账号存储、daemon connectors 的测试与模拟身份提供方           |
| 观测与隐私           | daemon 的 logger 记录运行诊断，redact 处理进入会话记录的敏感字段。产品分析事件由 analytics 字典定义，Electron 主进程校验和发送。                     | 脱敏、文件日志、字典与内容排除用例，页面导入门禁                     |
| Loop 状态与交付      | db/store 持有运行记录和事务；engine 管调度，flows/dev 驱动阶段，ports 连接具体外部系统；桌面经 Loop API 获取状态。                                   | db 迁移、pipeline、图节点与协议用例，engine 导入边界                 |

布局与视觉取舍从 [DESIGN.md](../DESIGN.md) 进入。工作树、远程传输、L1 方法和消息形状从 [协议](protocol.md) 进入。宿主运行时、后端存储、客户端降级以及集成套件的入口分别在 [daemon](daemon.md)、[桌面端](desktop.md) 和[测试说明](testing.md)。

## 相似实现的处置与待确认事项

- **保留旧存储读取。** Loop 的 db/import 使用 RunStore 导入存量文件，openStore 在数据库尚未建立时仍服务统计与 dry-run。撤掉旧实现需要已有部署完成导入的证据。见[存储决定](../.agents/notes/2026-11-27-loop-state-in-sqlite.md)。
- **保留分层状态。** daemon 的 pending 决定请求是否已结算，桌面的 PendingStore 决定向哪个连接和窗口展示，UI store 保存渲染状态。强行共享对象会把断线重连、历史重放和窗口寿命混到一起。
- **待确认离线 Harness 导航契约。** 桌面的 BUILTIN_HARNESSES 会在尚无连接时显示内置项，在线列表还要接纳新版 daemon 广告的 agent。直接删除静态列表会改变离线体验；让 renderer 导入 daemon 清单会穿透进程边界。现有优先级由桌面实现规定。待确认是否引入构建时元数据或扩展 bridge，让桌面在离线时也能读同一来源。
- **保留不同的插件命令契约。** agy 和 Codex 插件命令分别处理 stdout、stderr 和退出状态，Claude 插件驱动另有诊断处理。两份短命令执行代码相同，但搬进 line-rpc 会混淆短命令与双向通信的所有权。单独新增进程包的收益有限，后续出现第三个同契约调用方时再评估。
- **延后 daemon 会话状态重组。** daemon.ts 的日志写入、失败回滚、pending 结算和队列归还共同依赖 Session 的时序。拆分需先用状态转换和并发测试约束写失败、断连和关闭三者相交的路径。仅按文件长度切割会把写入顺序隐藏在回调之间。

- **保留两种测试汇总语义。** Loop 的 readSummary 区分缺失的 pass 行和明确的零，供工单验收报告使用。集成运行器的 parseSummary 为表格提供零默认值。两者在有计数的输出上以用例对照。

## 复核方法

- 在同一台机器上按基线和当前实现运行 agy、Claude、Codex 的 108 组环境对照。组合覆盖 HOME 缺失、空值、宿主值，白名单变化，显式配置及专用目录覆盖，结果逐字段一致。
- 比对 Codex 与 agy 旧权限规则的代码和用例，再通过各适配器的真实调用入口验证共享实现。两个会话的授权集合仍分别存放。
- 读回 desktop 主进程、renderer 和 daemon 的实际调用方，区分 Electron 通知消失、窗口恢复、Loop 暂缓重试和页面渲染状态。架构门禁和浏览器测试分别检查依赖方向与用户路径。
- 逐文件依赖图与 workspace manifest 图回答不同问题。前者只包含可静态解析的代码依赖；后者还包含类型与测试所需的包。动态插件、RPC、文件约定和运行时环境应结合领域文档与集成测试核对。

源码门禁从根 manifest 推导扫描目录，覆盖 scripts 和各 workspace 所在的顶级目录。迁移时逐路径比对了 889 个文件，结果一致。独立复审发现 Loop 的 planning.ts 还导入根 scripts/integration-suites.ts。依赖图从 15 个 workspace 的 src 递归跟踪仓库内可达的 TS/TSX，现覆盖 486 个文件、1,419 条边，未发现环。

桌面 bridge 保留已发布的认证失败类型定义。壳的 UI 更新兼容摘要取自 api.ts，等价的类型改写也可能导致旧壳拒绝更新。主进程复用协议错误词表，用类型检查确保本地补充的词与 bridge 契约一致。三个页面的 agent 埋点分类共用一个函数，类型覆盖 analytics 字典，契约测试用未知 ID 和原型属性名核对隐私回退。

## 本轮验收

以 715bd3e5 的生产代码在 macOS arm64 本地验证。完整门禁通过，249 个测试文件共 2,580 项通过。完整 Chromium 界面测试 49 个文件共 592 项通过。严格模式串行运行 Node 客户端、Claude、Codex、agy、SSH、整套后端、打包应用和 Web 八个集成套件，全部通过。打包用例重新构建桌面端与 daemon，并在隔离环境中启动应用。真实模型凭据测试未开启。

最后一次复核也发现 update.test.ts 偶发超时。用例现在观察更新器报告的等待状态，放行当前轮次后检查新 daemon 已监听。旧客户端结束通知与关服的先后顺序不属于此用例的契约。修改后该文件二十轮共 300 项通过。

后续从上面的待确认事项进入。离线导航需要明确数据来源和升级契约，旧文件存储的退出需要部署迁移证据，会话状态重组需要先约束并发时序。

## 独立复审

三位 Agent 分别核对 95bb58db 至 811ca39d 的行为、模块边界和门禁覆盖。旧桌面壳的 UI 契约摘要和 preload 字节已与基线逐项核对。Loop 现在会为共享审批规则的变更选择适配器集成测试。增量门禁覆盖架构测试及集成套件清单，renderer 的直接相对导入与包名导入均检查后端边界。workspace 回归样例覆盖相对路径、排除模式、显式注册和嵌套包所有权。
