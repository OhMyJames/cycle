# 架构治理进度

审计基线为 `95bb58db`。依赖边以各 workspace 的 manifest 为准。对 481 个 src 下 TS/TSX 文件，用 Bun.Transpiler.scanImports 按文件类型提取依赖。可解析的相对运行时导入中无环。此扫描未覆盖计算生成的路径、跨包导入和纯类型依赖。

## 模块、依赖与状态所有权

| 模块                       | 负责的状态或契约                                                                         | 直接生产依赖（仓库内）                                         |
| -------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| apps/desktop               | Electron 主进程持有连接、待回答请求和窗口设置，页面经 preload bridge 发起操作            | analytics、client、oidc、protocol、ui                          |
| apps/daemon                | 会话生命周期、JSONL 历史、环境、工作树、终端和 connector 凭证；CLI 用 client 连接 daemon | client、三个 harness、model-gateway、protocol、clawdot-plugins |
| cloud/loop                 | 工单执行状态、运行记录、交付流程；通过 L1 驱动任务                                       | client、protocol                                               |
| harness/claude             | Claude SDK 会话和 ACP 适配状态                                                           | protocol                                                       |
| harness/codex、harness/agy | 各自的子进程状态与 ACP 更新映射                                                          | line-rpc、protocol                                             |
| packages/client            | L1 请求、连接、订阅和重放游标                                                            | protocol                                                       |
| packages/protocol          | Cycle 的 wire schema、方法、错误码与元数据                                               | 无                                                             |
| packages/ui                | 纯会话投影、页面 store、组件和样式；令牌见 DESIGN.md                                     | analytics                                                      |
| packages/analytics         | 事件字典、字段校验、发送开关与 PostHog 客户端                                            | 无                                                             |
| packages/line-rpc          | 行协议子进程通信与请求关联                                                               | 无                                                             |
| packages/oidc              | 桌面登录协议                                                                             | 无                                                             |
| packages/model-gateway     | provider 请求适配与网关                                                                  | protocol                                                       |
| packages/clawdot-plugins   | 随 daemon 分发的插件资源                                                                 | 无                                                             |

以上生产依赖图无环。开发依赖中 client 和 daemon 成环：client 的集成测试启动 daemon，daemon CLI 的 stop 等命令需要 client。增量测试应同时覆盖两者。进程通信方向、会话数据流与传输约束见 [架构](architecture.md)，主进程内部的写入者见 [桌面端](desktop.md)。

## 已核对的取舍与任务池

| 范围                 | 证据、处置与验收依据                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工具链、目录所有权   | 增量选包与 ACP catalog 门禁曾各复制一份目录 glob。二者改读根清单，重叠模式去重。用自定义目录和未注册目录作回归样例。                                                                             |
| 持久化与缓存         | daemon 的 JsonFile 串行修改并在写失败时回滚内存。desktop 的 KeptEntries 在持久化成功后确认未知字段和条目。保留两端各自的契约，见两个 json-file.ts 和各自的调用方。                               |
| 分层约束             | 分区门禁已迁移至 Oxc 语法树。删除自制词法器，保留类型、动态导入和 require 检查。原压力测试在本机用时约 0.5 秒，上限 3 秒。                                                                       |
| UI、状态与业务模型   | Harness 已迁入 LocationScope，与订阅、API keys、Vault 共用位置选择、断线保留、能力回退与空状态。每页原有的能力缓存寿命保留。曝光由选中的 Harness 上报，浏览器用例核对两次位置曝光。              |
| 错误、重试、可观测性 | 桌面主进程的终端限额、connector 和配置保存错误改读协议字典。纯 UI 模型沿用分区约束，由重发测试以 CycleErrorCode 校验四种失败投影。client 持有连接重连的退避计时，Loop 主进程轮询按项目独立退避。 |
| 配置、权限与身份     | 继续核对 harness 注册表到启动环境、凭证存储与代理网关的调用路径。                                                                                                                                |
