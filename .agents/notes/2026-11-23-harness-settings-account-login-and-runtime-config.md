# Agent Note: Settings 中以 Harness 分组承载多 agent 订阅账号登录、用量与热生效运行时配置

Status: accepted
Date: 2026-11-23
Basis: 负责人 2026-11-23 在多 agent（Claude、Codex、Antigravity）配置设计讨论中的拍板（Settings 增加 Harness 分组与各 agent 子 tab、上半区账号与用量、下半区部分可编辑部分只读、三家本轮只做订阅账号登录并将 API key 留给后续 pi、不做切换到宿主 `~/.claude`/`~/.codex`/`~/.gemini` 登录、只管 Cycle 托管配置），2026-11-23 在隔离临时目录（非 TTY 管道）中对锁定二进制 `claude 2.1.327`、`codex 0.171.0`、`agy 1.5.15` 的只读 CLI/RPC 实测探测，以及 PR #131 两轮评审后负责人确认采纳的收敛方案。完整设计方案见 [docs/harness-settings.md](../../docs/harness-settings.md)。已在 PR #149 实现（CYCL-227–237）。

## Problem

[2026-11-22-claude-config-status-not-values.md](2026-11-22-claude-config-status-not-values.md)（CYCL-80）仅针对单个 Claude，要求界面完全只读、入口挂在 Environments 下，且所有登录与配置改动都回到 daemon 所在机器手动执行。接入 Codex 与 Antigravity（`agy`）后，这套边界出现三类明显缺口：

- Settings 里只有平铺的 `Defaults` 页管理会话默认项（`mode`/`model`/`effort`），用户看不到各 agent 的登录状态、套餐用量、安装/版本问题，也无法在界面完成日常订阅登录与登出。
- 实测发现三家 agent 的订阅登录机制都能在不把长期凭证暴露给前端的前提下由 daemon 驱动（Claude 与 `agy` 的 OAuth 回调均为官方 hosted callback + 粘贴授权码，本地与远端 SSH 统一可用；Codex 原生支持同机浏览器 `chatgpt` 与跨机 `chatgptDeviceCode`），此前拒绝“界面触发登录”的核心顾虑（远端 localhost 回调不可用）已不成立。
- 非敏感的 agent 运行时开关（如 `claude.warmStart`/`progressSummaries`、`agy.sandbox`/`telemetry`）目前混在手写的 `config.json` 中，改一次必须手改文件并重启 daemon。

## Decision

在 Settings 中设立 **Harness** 分组（内置已知 harnesses 固定占位保持导航稳定，吸收并移除原 `Defaults` tab），按“**账号订阅登录 + 热生效运行时选项 + 只读宿主诊断**”三条边界落地，**部分取代** CYCL-80（具体取代与保留边界见 `Related`）：

1. **认证边界与 L1 安全契约（仅订阅账号登录/登出，不做 API Key UI）**：
   - Claude、Codex、Antigravity 在界面内支持触发订阅账号的 Sign in / Sign out，以及展示账号身份与套餐用量（Codex 支持主动查询 `account/rateLimits/read`，Claude 展示 daemon 持有的 `_cycle/plan_usage`，`agy` 仅展示带 `tierObservedAt` 的可用档位并严格区分 `signed_in` / `signed_out` / `auth_unknown`）。
   - **长期凭证（OAuth access/refresh token、API key）永不上 L1、永不进前端与埋点**。
   - **显式登记“第二个例外”**：hosted-callback 模式（Claude / agy 的 `"code"` 模式）中用户粘贴的一次性授权码是短期凭证，经页面 → 主进程 → L1（`_cycle/agent_auth/submit`）送到 daemon，是 `docs/desktop.md` 中“connector 是凭证上线路唯一例外”之外的**第二个有意例外**（且与 Connector 不同：Connector 授权码走本机回环不经过页面，此处经过页面输入框）。对应缓解措施：授权码仅在内存短暂透传给子进程 stdin、永不落盘/不进 session JSONL/不进日志与错误对象；受 PKCE 绑定；`flowId` 绑定 `(connectionId, agent, flowId)`、单次提交即消费、10 分钟 TTL；单 agent 互斥；断线或 daemon 退出自动终止子进程；桌面端硬编码内置按 agent 的授权域名白名单（绝不由 daemon 声明），同时校验 `authorizationUrl` 与 `verificationUrl`，且弹窗展示域名由用户主动点击打开，不静默自动 `openExternal`。
   - 永远保留复制 `cycle login <agent>` 命令作为 stdout 解析失败或超时的兜底路径；对 `agy` 保持“绝不读取/解析/转发 token 文件”的硬红线。
   - **登录模式协商**：遵循 Cycle “daemon 不感知本地/远程传输”的原则，由 daemon 声明有序的 `signInModes` 及 `requiresLocalLoopback` 标记，桌面主进程 `ConnectionManager` 按连接类型（`local` vs `remote`）选择默认模式，UI 不硬编码传输或 agent 判断，daemon 入口强校验。
   - **本轮不在 UI 提供 API Key / Base URL 配置**；多 provider 与 API Key 配置留到接入 `pi` 时统一设计。若用户已在 `config.json` 的 `env` 中手写了密钥，界面仅以独立只读字段 `viaEnv` 展示变量名（从不返回值）。
2. **托管目录与原生配置边界**：
   - 只管理 Cycle 托管的 agent 配置，不读写 agent 原生配置文件（`CLAUDE.md`、`settings.json`、`config.toml`），`Plugins` 保留在 Connectors 页。
   - 不在 UI 提供切换到宿主 `~/.claude` / `~/.codex` / `~/.gemini` 已有登录的选项；隔离目录仍默认 `<dataDir>/<id>`，手改 `config.json` 时只读标为自定义。
3. **可编辑（热生效）vs 只读（宿主诊断）及生命周期规则**：
   - **可编辑且免重启热生效**：会话默认项（`mode`/`model`/`effort`，存 `<dataDir>/agent-defaults.json`）与非敏感运行时行为开关（`claude` 的 `warmStart`/`maxWarm`/`progressSummaries`、`agy` 的 `sandbox`/`telemetry`，独立存 `<dataDir>/agent-settings.json`）。
   - **复用 §10 `configSchema` 的封闭版本化子集**：运行时开关不另造独立表单模型，而是复用现有 `configSchema` JSON Schema 风格（带上 `title`/`description`，客户端有 i18n 翻译时优先用本地文案，并复用 `_meta["cycle/danger"]`），同时在协议侧用 Zod 限定为 `schemaVersion: 1` 的封闭类型集合（`boolean`、有界 `integer`、固定 `string` `oneOf`，加 `_meta["cycle/enabledWhen"]` 与 `_meta["cycle/applyScope"]`），UI 对未知类型降级为只读。
   - **并发与生效时机**：`_cycle/agent_setup/set_runtime` 采用局部 patch + 传 `null` 显式 unset + **per-agent** 乐观锁 `expectedRevision`，损坏文件不静默覆写；`claude.warmStart`/`maxWarm` 变更立即执行 warm pool reconciliation（`immediate`）；`progressSummaries`、`agy.sandbox`、`agy.telemetry` 及 Sign out 后的空闲已发言 session 均复用 `daemon.ts` 既有的 `#restartIfStale` 机制（`next_idle_restart`），`processAgent` 改为每次 `launch()` 动态求值 `env`；`config.json` 全部字段保持 `daemon_restart`。
   - **Sign out 与运行中 session**：登出不强杀正在运行的 session，立即回收旧账号未发言预热进程，将空闲已发言 session 标为 `stale` 经 `#restartIfStale` 重置，清空内存 `planUsage`、`tierObservedAt` 与探测缓存；同一 agent 的登录/登出操作串行互斥。
   - **只读诊断（来自 `config.json` 与运行态）**：二进制来源/路径/版本、`agy.executable`、`configDir`/`home` 自定义状态、`allowEnv` 与 `env` 变量名（绝不返回值）、`config.json` 语法错误与 mtime 变更重启提示。

## Alternatives considered

- **维持 CYCL-80 纯只读，只在界面显示状态与 `cycle login` 命令**：多 agent 后用户在三个 harness 间切换、查看套餐用量与登录/登出仍需反复切终端，体验割裂；且实测三家 OAuth 均可安全打通本机与远端，无需保留这一不便。未选。
- **沿用 `openableAuthorizationUrl` 放行任意 https 地址并自动 `openExternal`**：URL 来自远端 daemon 子进程 stdout，下一步还要粘贴授权码，放行任意 https 存在钓鱼风险。改为桌面端内置按 agent 域名白名单 + 弹窗展示域名由用户点击打开。
- **由 daemon 自行判断本地或远端以选择登录模式**：与 Cycle “环境是客户端概念、daemon 只看到 unix socket、协议与传输分离”的既有架构冲突。改为 daemon 声明 `signInModes` + `requiresLocalLoopback`、`ConnectionManager` 按连接类型选模式、daemon 强校验。
- **为运行时开关另造一套独立于 `configSchema` 的 `RuntimeField` 渲染器**：需要长期维护两套表单渲染与错误校验机制，且去掉 daemon `title`/`description` 会让未来新 agent 在客户端发版前退回原始 key。改为复用 §10 `configSchema` 的封闭版本化子集。
- **本轮一并在 UI 支持 API Key / Base URL（类 Connector 单向写入）**：三家当前以订阅登录为主，且 API Key 落地机制各异，过早引入会扩大长期凭证上线路的例外。延后到接入多 provider 的 `pi` 时统一处理。
- **在 UI 中直接编辑并写回 `config.json`**：`config.json` 为人手维护的文件，直接写回易冲突丢格式且需重启 daemon。改为只读诊断 `config.json`，将 UI 可编辑的运行时开关放入独立的 `<dataDir>/agent-settings.json`。
- **提供一键复用本机 `~/.claude` / `~/.codex` / `~/.gemini` 登录**：会模糊 Cycle 独立托管目录的隔离边界，负责人明确决定不支持。

## Consequences

- **收益**：三个 agent 获得稳定、一致的 Settings → Harness 入口，账号状态、套餐用量、会话默认项、热生效行为开关与宿主诊断集中在一处；本机与远端 SSH 都能在界面内完成订阅登录并保留复制命令兜底；改行为开关和登出后进程状态均可通过 warm pool reconciliation 与 `#restartIfStale` 干净收敛；长期凭证与 `agy` token 红线完整保留。
- **代价与限制**：
  - 引入新的 L1 方法族（`_cycle/agent_setup/*`、`_cycle/agent_auth/*`，错误码遵循 JSON-RPC 数字 `code` + `data.reason` 约定）与 `<dataDir>/agent-settings.json`，实施前需更新 `docs/protocol.md`、`docs/desktop.md`（登记第二个例外），并按 `agentSetup` 能力位做好旧 daemon 降级。
  - 三家底层能力仍有差异：Claude 套餐用量目前仅能在完成一次会话后被动采集；`agy` 无原生 `auth status` 命令与额度接口，需依赖 `agy models` 探测登录态并在会话中观测档位。
  - **前置实测项（登录上线前必须验证）**：
    1. Claude 在 macOS 上 `claude auth login` / `logout` 的凭证落点（系统钥匙串 vs `<dataDir>/claude`）、与宿主 `~/.claude` 的真实隔离性、以及后台/桌面端拉起的 daemon 访问钥匙串是否弹窗；
    2. Codex 短生命周期认证 `app-server` 与运行中 session 共享同一 `$CODEX_HOME` 时的并发锁表现，以及 `chatgptDeviceCode` 实际验证域名；
    3. Antigravity 在无钥匙串隔离 `HOME` 下 `agy models` 的真实耗时（避开已知 ~5s 钥匙串回退等待），以及真实账号下的完整 OAuth 闭环。

## Related

- [docs/harness-settings.md](../../docs/harness-settings.md)：完整设计方案与分阶段实现计划（按只读诊断 → 热生效开关 → Codex/Claude/agy 逐家登录的顺序落地）。
- [Claude 的 config.json 在界面里只显示状态,修改留在 daemon 所在的机器上](2026-11-22-claude-config-status-not-values.md)：本决定**部分取代**该笔记。**取代部分**：入口从 Environments 迁至 Settings → Harness 分组、允许界面内触发订阅账号登录与登出（附 hosted-callback 一次性授权码的第二个例外）、允许在 UI 编辑非敏感运行时行为开关（经独立的 `agent-settings.json` 热生效）。**继续有效部分**：`config.json` 仍不在 UI 编辑、只读状态只返回变量名绝不返回值、变量名不进埋点、`mtime` 变更仅作提示、重启沿用 `cycle stop --wait/--force` 确认、本轮不在 UI 写入 API Key。
- [Connector 是 Cycle 的公共能力](2026-11-19-connectors-behind-a-daemon-gateway.md)：凭证上线路的第一个例外，以及它与本决定中 hosted-callback 一次性授权码路径的差异。
- [每个 agent 在 config.json 里是顶层的一段，命令行按 agent id 走](2026-11-23-each-agent-is-a-top-level-config-section.md)：`config.json` 分段结构与 `HARNESSES` 注册表约定（继续沿用）。
- [agy terms, external binary distribution, and telemetry default](2026-11-23-agy-terms-distribution-and-telemetry.md)：`agy` 不打包二进制、默认不关闭遥测及绝不触碰 token 的红线（继续沿用）。
- [Plan usage belongs to the account on the daemon's machine, not to a session](2026-11-20-plan-usage-is-the-accounts.md)：套餐用量归属 daemon 账号的既有模型（继续沿用）。
