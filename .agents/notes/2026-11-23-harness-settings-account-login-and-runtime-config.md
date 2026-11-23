# Agent Note: Settings 中以 Harness 分组承载多 agent 订阅账号登录、用量与热生效运行时配置

Status: accepted
Date: 2026-11-23
Basis: 负责人 2026-11-23 在多 agent（Claude、Codex、Antigravity）配置设计讨论中的拍板（Settings 增加 Harness 分组与各 agent 子 tab、上半区账号与用量、下半区部分可编辑部分只读、三家本轮只做订阅账号登录并将 API key 留给后续 pi、不做切换到宿主 `~/.claude`/`~/.codex`/`~/.gemini` 登录、只管 Cycle 托管配置），2026-11-23 在隔离临时目录中对锁定二进制 `claude 2.1.327`、`codex 0.171.0`、`agy 1.5.15` 的只读 CLI/RPC 实测探测，以及 PR #131 评审后负责人确认采纳的协议与生命周期收敛方案。完整设计方案见 [docs/harness-settings.md](../../docs/harness-settings.md)。尚未开始代码实现与测试。
Supersedes: [Claude 的 config.json 在界面里只显示状态,修改留在 daemon 所在的机器上](2026-11-22-claude-config-status-not-values.md)

## Problem

CYCL-80 的旧决定仅针对单个 Claude，且要求界面完全只读、所有登录与配置改动都回到 daemon 所在机器手动执行。接入 Codex 与 Antigravity（`agy`）后，这套边界出现三类明显缺口：

- Settings 里只有平铺的 `Defaults` 页管理会话默认项（`mode`/`model`/`effort`），用户看不到各 agent 的登录状态、套餐用量、安装/版本问题，也无法在界面完成日常订阅登录与登出。
- 实测发现三家 agent 的订阅登录机制都能在不把长期凭证暴露给前端的前提下由 daemon 驱动（Claude 与 `agy` 的 OAuth 回调均为官方 hosted callback + 粘贴授权码，本地与远端 SSH 统一可用；Codex 原生支持同机浏览器 `chatgpt` 与跨机 `chatgptDeviceCode`），此前拒绝“界面触发登录”的核心顾虑（远端 localhost 回调不可用）已不成立。
- 非敏感的 agent 运行时开关（如 `claude.warmStart`/`progressSummaries`、`agy.sandbox`/`telemetry`）目前混在手写的 `config.json` 中，改一次必须手改文件并重启 daemon。

## Decision

在 Settings 中设立 **Harness** 分组（动态列出当前连接环境的 harnesses：`Claude`、`Codex`、`Antigravity` 等，吸收并移除原 `Defaults` tab），按“**账号订阅登录 + 热生效运行时选项 + 只读宿主诊断**”三条边界落地，取代 CYCL-80 的纯只读决定：

1. **认证边界与 L1 安全契约（仅订阅账号登录/登出，不做 API Key UI）**：
   - Claude、Codex、Antigravity 在界面内支持触发订阅账号的 Sign in / Sign out，以及展示账号身份与套餐用量（Codex 支持主动查询 `account/rateLimits/read`，Claude 展示 daemon 持有的 `_cycle/plan_usage`，`agy` 仅展示带 `observedAt` 的可用档位并严格区分 `signed_in` / `signed_out` / `auth_unknown`）。
   - **长期凭证（OAuth access/refresh token、API key）永不上 L1、永不进前端与埋点**。hosted-callback 模式（Claude / agy）中用户粘贴的一次性授权码视为短期凭证，经 `_cycle/agent_auth/submit` **仅在内存短暂透传**给登录子进程 stdin，永不落盘、不进 session JSONL、不进 `daemon.log` / 错误对象 / crash report。
   - `flowId` 绑定 `(connection, agent, flowId)`、单次提交即失效、10 分钟 TTL；单 agent 互斥（并发拒绝 `auth_in_progress`）；连接断开或 daemon 退出时自动终止登录子进程；错误仅返回固定错误码，不透传原始 stderr/URL/路径。主进程打开任何授权链接前均经 `openableAuthorizationUrl` 校验。对 `agy` 保持“绝不读取/解析/转发 token 文件”的硬红线。
   - **登录模式协商**：遵循 Cycle “daemon 不感知本地/远程传输”的原则，由 daemon 声明支持的模式及 `requiresLocalLoopback` 标记，桌面主进程 `ConnectionManager` 按连接类型（`local` vs `remote`）选择默认模式，UI 不硬编码传输或 agent 判断，daemon 入口对请求的模式做能力强校验。
   - **本轮不在 UI 提供 API Key / Base URL 配置**；多 provider 与 API Key 配置留到接入 `pi` 时统一设计。若用户已在 `config.json` 的 `env` 中手写了密钥，界面仅以独立只读字段 `viaEnv` 展示变量名（从不返回值）。
2. **托管目录与原生配置边界**：
   - 只管理 Cycle 托管的 agent 配置，不读写 agent 原生配置文件（`CLAUDE.md`、`settings.json`、`config.toml`），`Plugins` 保留在 Connectors 页。
   - 不在 UI 提供切换到宿主 `~/.claude` / `~/.codex` / `~/.gemini` 已有登录的选项；隔离目录仍默认 `<dataDir>/<id>`，手改 `config.json` 时只读标为自定义。
3. **可编辑（热生效）vs 只读（宿主诊断）及生命周期规则**：
   - **可编辑且免重启热生效**：每个 agent 的会话默认项（`mode`/`model`/`effort`，存 `<dataDir>/agent-defaults.json`）以及非敏感运行时行为开关（`claude` 的 `warmStart`/`maxWarm`/`progressSummaries`、`agy` 的 `sandbox`/`telemetry`），通过封闭版本化 runtime schema 表达并独立存 `<dataDir>/agent-settings.json`（局部 patch、显式 `null` unset、乐观锁 `expectedRevision`、损坏文件不静默覆写，绝不改写手写的 `config.json`）。
   - **明确生效时机与 warm pool reconciliation**：`claude.warmStart`（关时立即回收未发言预热进程，开时不回补旧空会话）与 `claude.maxWarm`（调低时立即 FIFO 回收超出上限的未发言预热进程）为 `immediate`；`progressSummaries` / `agy.sandbox` / `agy.telemetry` 为 `next_process_launch`；`config.json` 全部字段为 `daemon_restart`。
   - **Sign out 与运行中 session**：登出不强杀正在运行的 session，但立即回收该 agent 所有未发言的旧账号预热进程并清空内存 `planUsage` 与 `tier`；同一 agent 的登录/登出操作串行互斥。
   - **只读诊断（来自 `config.json` 与运行态）**：二进制来源/路径/版本、`agy.executable`、`configDir`/`home` 自定义状态、`allowEnv` 与 `env` 变量名（绝不返回值）、`config.json` 语法错误与 mtime 变更需重启提示。

## Alternatives considered

- **维持 CYCL-80 纯只读，只在界面显示状态与 `cycle login` 命令**：多 agent 后用户在三个 harness 间切换、查看套餐用量与登录/登出仍需反复切终端，体验割裂；且实测三家 OAuth 均可安全打通本机与远端，无需保留这一不便。未选。
- **由 daemon 自行判断本地或远端以选择登录模式**：与 Cycle “环境是客户端概念、daemon 只看到 unix socket、协议与传输分离”的既有架构冲突（远端带桌面环境的机器上 daemon 无法知道对端是否同机）。改为 daemon 声明 `signInModes` + `requiresLocalLoopback`、`ConnectionManager` 按连接类型选模式、daemon 强校验。
- **本轮一并在 UI 支持 API Key / Base URL（类 Connector 单向写入）**：在 Claude、Codex、Antigravity 上以订阅登录为主，且三家 API Key 落地机制差异大（Codex 需写入 `auth.json`、`agy` 需额外调用 ACP `authenticate`），强行在此阶段引入会把“长期凭证上线路”的例外扩大并过早定型 provider 抽象。决定延后到引入多 provider 的 `pi` 时统一处理。
- **在 UI 中直接编辑并写回 `config.json`**：`config.json` 为人手维护的文件，直接写回易冲突丢格式，且当前需重启 daemon 才能生效。改为只读诊断 `config.json`，将 UI 可编辑的运行时开关放入独立的 `<dataDir>/agent-settings.json` 并按乐观锁与热加载机制生效。
- **提供一键复用本机 `~/.claude` / `~/.codex` / `~/.gemini` 登录**：会模糊 Cycle 独立托管目录的隔离边界，负责人明确决定不支持。

## Consequences

- **收益**：三个 agent 获得一致的 Settings → Harness 入口，账号状态、套餐用量、会话默认项、行为开关与诊断信息集中在一处；本机与远端 SSH 都能在界面内完成订阅登录；改行为开关不再需要重启 daemon；长期凭证与 `agy` token 红线完整保留，一次性授权码、并发写入与热回收边界清晰可测。
- **代价与限制**：
  - 引入新的 L1 方法族（`_cycle/agent_setup/*`、`_cycle/agent_auth/*`）与独立配置文件 `<dataDir>/agent-settings.json`，实现前须先更新 `docs/protocol.md`（并说明与 ACP `auth/*` 的边界）以及按 `agentSetup` 能力位做好旧 daemon 降级。
  - 三家底层能力仍有差异：Claude 套餐用量目前仅能在完成一次会话后被动采集；`agy` 无原生 `auth status` 命令与额度接口，需依赖 `agy models` 探测登录态并在会话中观测档位。
  - **未验证项**：真实 OAuth 账号授权完整闭环（粘贴授权码、Codex Device Code 轮询、各家实际返回的 `email`/`planType`/`tier` 字段）以及 Codex 短生命周期认证 `app-server` 与运行中 session 共享同一 `$CODEX_HOME` 时的并发锁表现，均需在实现阶段用隔离目录实测验证。

## Related

- [docs/harness-settings.md](../../docs/harness-settings.md)：完整设计方案与分阶段实现计划。
- [Claude 的 config.json 在界面里只显示状态,修改留在 daemon 所在的机器上](2026-11-22-claude-config-status-not-values.md)：本决定取代的旧笔记。
- [每个 agent 在 config.json 里是顶层的一段，命令行按 agent id 走](2026-11-23-each-agent-is-a-top-level-config-section.md)：`config.json` 分段结构与 `HARNESSES` 注册表约定（继续沿用）。
- [agy terms, external binary distribution, and telemetry default](2026-11-23-agy-terms-distribution-and-telemetry.md)：`agy` 不打包二进制、默认不关闭遥测及绝不触碰 token 的红线（继续沿用）。
- [Plan usage belongs to the account on the daemon's machine, not to a session](2026-11-20-plan-usage-is-the-accounts.md)：套餐用量归属 daemon 账号的既有模型（继续沿用）。
