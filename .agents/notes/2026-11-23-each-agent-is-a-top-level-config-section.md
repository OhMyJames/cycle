# Agent Note: 每个 agent 在 config.json 里是顶层的一段，命令行按 agent id 走

Status: accepted
Date: 2026-11-23
Basis: CYCL-155(多 agent 打底，CYCL-152 Codex、CYCL-153 agy、CYCL-154 pi 的前置)。负责人 2026-11-23 的回答："config.json 先按照你提议的来，如果未来要拆分，咱们后面单独起一个 issue 来做拆分"、"命令行我同意按照你的逻辑来"、"打包带哪些二进制 同意你的逻辑"。

## Problem

接入第二个 agent 之前，`config.json` 只有 `claude` 一段，命令行只有 `cycle login` 和 `cycle claude <args>`,都只认 Claude。这两样是用户手写和记住的东西：已经装好的机器上有写着 `claude` 段的配置文件，文档和习惯里有 `cycle login`。新 agent 的配置和登录放在哪，决定了这些已有的东西要不要跟着改。

## Decision

- **配置**:每个 agent 在 `config.json` 里有自己的顶层一段，键就是 agent 的 id(`claude`,以后是 `codex` 等),和 `terminal`、`idle`、`log` 同级。已有的 `claude` 段原样保留，不迁移。段的 schema 写在 `apps/daemon/src/config.ts` 里，测试检查每个 harness 的 id 都有对应的段。
- **命令行**:`cycle login [agent]`,不写 agent 时是 Claude(注册表里第一个有命令行的);`cycle <agent id> <args>` 用 daemon 给那个 agent 的环境跑它自己的二进制，`cycle claude …` 因此不变。`cycle adapter <agent id>` 按 id 分发。agent 的 id 同时是它的适配器子命令、配置段的键和命令名，定义在一处(`apps/daemon/src/harness.ts` 的 `Harness`,清单在 `harnesses.ts`)。
- **打包**:带哪些二进制是一张清单(harness 的 `binary`,构建时的来源在 `apps/daemon/scripts/binaries.ts`,桌面端的在 `layout.ts` 的 `AGENT_BINS`,根目录的测试保证两边一致)。这次只有 Claude 的;Codex、agy、pi 带不带各自的二进制，由它们的调研(CYCL-156、157、158)决定。
- **预热上限**:原先 daemon 全局的上限读的是 `claude.maxWarm`,改成 agent 定义上的 `maxAhead`(daemon 的全局选项 `maxAheadAgents` 删掉了),只数这个 agent 自己的 session。只有 Claude 时行为不变。

## Alternatives considered

- **统一挪到 `agents.<id>`**:结构更整齐，agent 的段和 daemon 自己的段分开，不会撞名。但已有的配置文件都要迁移，或者 daemon 要长期同时读两种写法。负责人选了保留顶层，需要拆分时另起 issue。
- **`cycle login` 必须写 agent**:多个 agent 时更明确，但会让现有文档和已经记住的命令失效，换来的只是少一个默认值。没有选。

## Consequences

- agent 的 id 不能和 daemon 自己的配置段(`terminal`、`idle`、`log`)或命令(`serve`、`proxy`、`status`、`stop`、`logs`、`login`、`version`、`adapter`)重名。现在没有检查，靠加 harness 时注意；真撞上时那个 agent 的命令不可达。
- `cycle login` 后面的第一个词(不以 `-` 开头的)是 agent 名：这个构建里没有的名字会报错退出，不会被当成参数传给 Claude 的登录命令。以 `-` 开头的选项照旧传下去。Claude 的 `auth login` 没有位置参数，目前没有冲突;以后哪个 agent 的登录需要位置参数，写在 agent 名后面(`cycle login pi <provider>`)。
- 以后要挪到 `agents.<id>`,需要一次带兼容读取的迁移，另起 issue。
