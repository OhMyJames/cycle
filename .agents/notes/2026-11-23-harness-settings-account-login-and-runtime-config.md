# Agent Note: Settings 中以 Harness 分组承载多 agent 订阅账号登录、用量与热生效运行时配置

Status: accepted
Date: 2026-11-23
Basis: 负责人 2026-11-23 在多 agent（Claude、Codex、Antigravity）配置设计讨论中的拍板（Settings 增加 Harness 分组与各 agent 子 tab、上半区账号与用量、下半区部分可编辑部分只读、三家本轮只做订阅账号登录并将 API key 留给后续 pi、不做切换到宿主 `~/.claude`/`~/.codex`/`~/.gemini` 登录、只管 Cycle 托管配置），以及 2026-11-23 在隔离临时目录中对锁定二进制 `claude 2.1.327`、`codex 0.171.0`、`agy 1.5.15` 的只读 CLI/RPC 实测探测。完整设计方案见 [docs/harness-settings.md](../../docs/harness-settings.md)。尚未开始代码实现与测试。
Supersedes: [Claude 的 config.json 在界面里只显示状态,修改留在 daemon 所在的机器上](2026-11-22-claude-config-status-not-values.md)

## Problem

CYCL-80 的旧决定仅针对单个 Claude，且要求界面完全只读、所有登录与配置改动都回到 daemon 所在机器手动执行。接入 Codex 与 Antigravity（`agy`）后，这套边界出现三类明显缺口：

- Settings 里只有平铺的 `Defaults` 页管理会话默认项（`mode`/`model`/`effort`），用户看不到各 agent 的登录状态、套餐用量、安装/版本问题，也无法在界面完成日常订阅登录与登出。
- 实测发现三家 agent 的订阅登录机制都能在不把 token 暴露给前端的前提下由 daemon 驱动（Claude 与 `agy` 的 OAuth 回调均为官方 hosted callback + 粘贴授权码，本地与远端 SSH 统一可用；Codex 原生支持本机浏览器 `chatgpt` 与远端 `chatgptDeviceCode`），此前拒绝“界面触发登录”的核心顾虑（远端 localhost 回调不可用）已不成立。
- 非敏感的 agent 运行时开关（如 `claude.warmStart`/`progressSummaries`、`agy.sandbox`/`telemetry`）目前混在手写的 `config.json` 中，改一次必须手改文件并重启 daemon。

## Decision

在 Settings 中设立 **Harness** 分组（动态列出当前连接环境的 harnesses：`Claude`、`Codex`、`Antigravity` 等，吸收并移除原 `Defaults` tab），按“**账号订阅登录 + 热生效运行时选项 + 只读宿主诊断**”三条边界落地，取代 CYCL-80 的纯只读决定：

1. **认证边界（仅订阅账号登录/登出，不做 API Key UI）**：
   - Claude、Codex、Antigravity 在界面内支持触发订阅账号的 Sign in / Sign out，以及展示账号身份与套餐用量（Codex 支持主动查询 `account/rateLimits/read`，Claude 展示 daemon 持有的 `_cycle/plan_usage`，`agy` 仅展示可用档位）。
   - 任何 OAuth token 或 API key 仍永不上 L1 线路、永不进入前端与埋点；L1 仅传递经 `openableAuthorizationUrl` 校验的授权 URL / Device Code 以及 hosted-callback 的一次性授权码。对 `agy` 保持“绝不读取/解析/转发 token 文件”的硬红线。
   - **本轮不在 UI 提供 API Key / Base URL 配置**；多 provider 与 API Key 配置留到接入 `pi` 时统一设计。若用户已在 `config.json` 的 `env` 中手写了密钥，界面只读展示变量名（从不返回值）。
2. **托管目录与原生配置边界**：
   - 只管理 Cycle 托管的 agent 配置，不读写 agent 原生配置文件（`CLAUDE.md`、`settings.json`、`config.toml`），`Plugins` 保留在 Connectors 页。
   - 不在 UI 提供切换到宿主 `~/.claude` / `~/.codex` / `~/.gemini` 已有登录的选项；隔离目录仍默认 `<dataDir>/<id>`，手改 `config.json` 时只读标为自定义。
3. **可编辑（热生效）vs 只读（宿主诊断）**：
   - **可编辑且免重启热生效**：每个 agent 的会话默认项（`mode`/`model`/`effort`，存 `<dataDir>/agent-defaults.json`）以及非敏感运行时行为开关（`claude` 的 `warmStart`/`maxWarm`/`progressSummaries`、`agy` 的 `sandbox`/`telemetry`，独立存 `<dataDir>/agent-settings.json`，不改写手写的 `config.json`，新会话立即生效、不打断运行中的会话）。
   - **只读诊断（来自 `config.json` 与运行态）**：二进制来源/路径/版本、`agy.executable`、`configDir`/`home` 自定义状态、`allowEnv` 与 `env` 变量名（绝不返回值）、`config.json` 语法错误与 mtime 变更需重启提示。

## Alternatives considered

- **维持 CYCL-80 纯只读，只在界面显示状态与 `cycle login` 命令**：多 agent 后用户在三个 harness 间切换、查看套餐用量与登录/登出仍需反复切终端，体验割裂；且实测三家 OAuth 均可安全打通本机与远端，无需保留这一不便。未选。
- **本轮一并在 UI 支持 API Key / Base URL（类 Connector 单向写入）**：在 Claude、Codex、Antigravity 上以订阅登录为主，且三家 API Key 落地机制差异大（Codex 需写入 `auth.json`、`agy` 需额外调用 ACP `authenticate`），强行在此阶段引入会把“凭证上线路”的例外扩大并过早定型 provider 抽象。决定延后到引入多 provider 的 `pi` 时统一处理。
- **在 UI 中直接编辑并写回 `config.json`**：`config.json` 为人手维护的文件，直接写回易冲突丢格式，且当前需重启 daemon 才能生效。改为只读诊断 `config.json`，将 UI 可编辑的运行时开关放入独立的 `<dataDir>/agent-settings.json` 并在启动子进程时热读取。
- **提供一键复用本机 `~/.claude` / `~/.codex` / `~/.gemini` 登录**：会模糊 Cycle 独立托管目录的隔离边界，负责人明确决定不支持。

## Consequences

- **收益**：三个 agent 获得一致的 Settings → Harness 入口，账号状态、套餐用量、会话默认项、行为开关与诊断信息集中在一处；本机与远端 SSH 都能在界面内完成订阅登录；改行为开关不再需要重启 daemon；凭证与 `agy` token 红线完整保留。
- **代价与限制**：
  - 引入新的 L1 方法族（`_cycle/agent_setup/*`、`_cycle/agent_auth/*`）与独立配置文件 `<dataDir>/agent-settings.json`，需在实现前更新 `docs/protocol.md` 并对旧 daemon 按 `agentSetup` 能力位做平滑降级。
  - 三家底层能力仍有差异：Claude 套餐用量目前仅能在完成一次会话后被动采集；`agy` 无原生 `auth status` 命令与额度接口，需依赖 `agy models` 探测登录态并在会话中观测档位。
  - **未验证项**：真实 OAuth 账号授权完整闭环（粘贴授权码、Codex Device Code 轮询、各家实际返回的 `email`/`planType`/`tier` 字段）在本次只读探测中未用真实账号执行，需在实现阶段用隔离目录实测验证。

## Related

- [docs/harness-settings.md](../../docs/harness-settings.md)：完整设计方案与分阶段实现计划。
- [Claude 的 config.json 在界面里只显示状态,修改留在 daemon 所在的机器上](2026-11-22-claude-config-status-not-values.md)：本决定取代的旧笔记。
- [每个 agent 在 config.json 里是顶层的一段，命令行按 agent id 走](2026-11-23-each-agent-is-a-top-level-config-section.md)：`config.json` 分段结构与 `HARNESSES` 注册表约定（继续沿用）。
- [agy terms, external binary distribution, and telemetry default](2026-11-23-agy-terms-distribution-and-telemetry.md)：`agy` 不打包二进制、默认不关闭遥测及绝不触碰 token 的红线（继续沿用）。
- [Plan usage belongs to the account on the daemon's machine, not to a session](2026-11-20-plan-usage-is-the-accounts.md)：套餐用量归属 daemon 账号的既有模型（继续沿用）。
