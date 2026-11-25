# 三端工具事件特型展示调研与方案（CYC-309）

> 本调研在 [CYC-308]（修复三端工具调用基础展示异常）之后开展，不直接改 UI 实现，也不以某个 agent 的偶然字段硬编码特判。数据来自本地真实会话 JSONL 抽样（Claude 49 类、Codex 19 类、agy 24 类工具事件）与三端适配器源码对照（`harness/claude/src/`、`harness/codex/src/`、`harness/agy/src/`、`docs/protocol.md`、`docs/conversation-content.md`）。

## 一、核心结论

1. **展示差异的根因不是 UI 能力不足，而是 L2→L1 结构化字段不齐。**
   Cycle 的 UI 渲染层（`packages/ui/src/model/facts.ts`、`blocks.ts`、`react/tool.tsx`）已经具备按 ACP 标准字段 + `_meta["cycle/toolResult"]` 统一渲染命令、编辑 Diff、读写行号、搜索命中、网页状态与链接、子 agent、计划的能力，但目前只有 Claude 填齐了大部分结构化结果，Codex 和 agy 在多处只发纯文本 `content` 或 `title`。
2. **统一原则：以 ACP 字段与 `_meta["cycle/toolResult"]` 驱动，禁止按 agent 名称分支。**
   同一类动作（执行命令、读/改文件、搜索、MCP、子 agent、计划）在三端收敛到同一套 L1 字段与同一种展示；某个 agent 暂不提供某字段时，按固定降级链回退，不靠猜工具名兜底。
3. **最高性价比的下一步投入在 Codex `fileChange` 结构化 Diff、三端 MCP 统一标题/入参摘要、以及 agy 文件读取行号与搜索计数。**

---

## 二、三端工具事件字段对照表

符号说明：`✓` 已提供；`△` 仅部分/纯文本提供；`✗` 当前未提供；`—` 该 agent 无对应原生能力。

| 维度 / 能力          | ACP / Cycle 目标字段                                           | Claude（`harness/claude`）                                                    | Codex（`harness/codex`）                                                                                       | agy（`harness/agy`）                                                                     |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 工具名与分类         | `name` / `kind` / `title`                                      | ✓ `Bash`/`Read`/`Edit`/`Grep` 等；MCP 设 `title: "server · tool"`             | ✓ `exec_command`/`Edit files`/`server/tool`；MCP 尚未统一 `·` 标题                                             | ✓ `run_command`/`read_file`/`edit_file`/`mcp_*`；`title` 多为命令或 `"Run <tool>"`       |
| 状态与耗时           | `status` + `_meta["cycle/ts"]` / `durationMs`                  | ✓ `pending`→`in_progress`→终态；无独立耗时字段                                | ✓ `in_progress`→终态；原生有 `durationMs`（未进 L1）                                                           | ✓ `pending`/`in_progress`→终态；无独立耗时字段                                           |
| Shell 命令与目录     | `rawInput.command`、`rawInput.cwd`、`rawInput.description`     | ✓ `command`、`description`、`timeout`、`run_in_background`                    | ✓（CYC-308 补齐 `command`/`cwd`；命令带 `/bin/zsh -lc` 包装）                                                  | ✓（CYC-308 将 `CommandLine`/`Cwd` 规范化为 `command`/`cwd`；带 `toolSummary`）           |
| 命令退出码 / 异常    | `_meta["cycle/toolResult"].run`                                | ✓ `interrupted`、`timedOutMs`、`background`、`exitCode`（非 0）               | ✓（CYC-308 补齐 `exitCode`）；无 `timedOutMs`/`background`                                                     | ✓ `exitCode`（来自 `rawOutput.exit_code`）；无中断/超时细分                              |
| stdout / stderr 分流 | `content[]` + `_meta["cycle/stream"]`                          | ✓ 区分 `stdout`/`stderr`                                                      | △ `aggregatedOutput` 合并输出，不区分流                                                                        | △ `output` 合并输出，不区分流                                                            |
| 文件读取             | `rawInput.file_path`、`locations`、`_meta.toolResult.read`     | ✓ 路径 + `locations` + `startLine`/`numLines`/`totalLines`                    | △ 主要经 Shell `cat`/`sed`（无独立 Read 工具）                                                                 | ✓ 路径（CYC-308 规范化）+ `locations`；✗ 未填 `toolResult.read` 行数                     |
| 文件编辑与 Diff      | `content[type="diff"]`、`locations`、`_meta.toolResult.edit`   | ✓ 完整 `git_patch` + `locations` + `additions`/`deletions`/`created`/`staged` | △ `fileChange` 仅发纯文本 `diffOf()`（CYC-308 补 `locations`），未发 ACP `diff` 块与增删计数，进不了 Diff 面板 | ✓ ACP `diff` 块 + `locations` + `additions`/`deletions`/`created`                        |
| 搜索（代码 / 文件）  | `rawInput.pattern`/`query`、`_meta.toolResult.search`          | ✓ `Glob`/`Grep` 完整 `files`/`matches`/`lines`/`more`                         | △ 主要经 Shell `rg`/`find`（CYC-308 拆壳后可识别为搜索/列举），`webSearch` 已补 `rawInput.query`               | △ `search_web` 仅 `query`；本地搜索多走 `run_command` 或专用工具，缺 `toolResult.search` |
| Web Fetch / 链接     | `rawInput.url`、`resource_link`、`_meta.toolResult.fetch`      | ✓ HTTP `status`、`bytes`、`resource_link`                                     | △ `webSearch` 仅 `query`，无结构化链接列表                                                                     | △ `search_web` 无 `resource_link` 与 `fetch` 指标                                        |
| MCP / connector      | `title`（`server · tool`）、`rawInput`、`content`（文本/图片） | ✓ `server · tool` 标题 + `rawInput` + 文本/图片                               | △（CYC-308 补齐 `rawInput: arguments`）；标题为 `server/tool`；结果 JSON.stringify 原文                        | △ `rawInput` 完整；标题为 `"Run mcp_<server>_<tool>"`；常缺 `content`（部分返回在内部）  |
| 计划 / 任务列表      | `plan_update`（调用本身标记 `kind: "think"` 隐藏）             | ✓ `TodoWrite`/`TaskCreate`/`TaskUpdate`                                       | ✓ `turn/plan/updated`                                                                                          | ✓ `update_steps`（`StepsPlans` 翻译）                                                    |
| 子 agent             | `subagent_update` + `_cycle/child_update`                      | ✓ 完整进度卡片与嵌套子对话                                                    | ✓ `subAgentActivity`/`collabAgentToolCall` + 子线程更新                                                        | △ `invoke_subagent` 仅普通工具行（标题 `Sub-agent: <Role>`），无独立子对话卡片           |
| 审批 / 提问          | `session/request_permission`、`elicitation/create`             | ✓ 权限卡 + 提问表单（`AskUserQuestion`）                                      | ✓ 权限卡 + 表单（`request_user_input`）                                                                        | ✓ 权限卡 + `elicitation`                                                                 |
| 思考 / 压缩          | `agent_thought(_chunk)`、`compaction_update`                   | ✓ 普通模式隐藏思考，详细模式折叠框；压缩单行                                  | ✓ 同左                                                                                                         | ✓ 思考同左；暂无 `compaction_update`                                                     |

---

## 三、字段归属：ACP 原生 vs Cycle 扩展

| 归属                                  | 字段                                                                                                                        | 适用信息                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **ACP v2 原生字段**                   | `name`、`title`、`kind`、`status`、`rawInput`、`rawOutput`、`locations`、`content`（`text`/`image`/`diff`/`resource_link`） | 工具动作、目标（命令/路径/查询/URL）、文件位置、结构化补丁、输出文本/图片/链接                                    |
| **Cycle `_meta["cycle/toolResult"]`** | `{ edit, read, search, fetch, run }`（仅数字与布尔，**严禁内容文本**）                                                      | 增删行数、创建/暂存标记、读取起止行/总行数、搜索文件数/命中数/截断标记、HTTP 状态码/字节数、退出码/中断/超时/后台 |
| **Cycle `_meta["cycle/stream"]`**     | `"stderr"`                                                                                                                  | 区分命令错误输出块与标准输出块                                                                                    |
| **Cycle 专用 update**                 | `plan_update`、`subagent_update`、`_cycle/child_update`、`_cycle/task_update`                                               | 计划清单、子 agent 状态与子对话、后台任务列表                                                                     |

**原则**：凡是 ACP 已有对应语义的字段（如 `diff`、`locations`、`resource_link`、`rawInput`），优先在各 harness 适配层填齐 ACP 字段，不新增重复扩展；仅数量/布尔摘要放入 `_meta["cycle/toolResult"]`。

---

## 四、特型展示候选清单（按价值排序）

| 优先级 | 类别                                | 特型展示内容                                                                                                                                       | 收益                                                               | 复杂度 | 前置依赖                                                                  |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------- |
| **P0** | **Codex 文件编辑结构化 Diff**       | `fileChange` 改为输出 ACP `diff` content + `_meta["cycle/toolResult"].edit`（增删行数、新建/删除/移动），接入会话 Diff 面板与 `Show in Diff` 跳转  | 极高（Codex 编辑目前无法统计 +/-、进不了 Diff Tab）                | 中     | `harness/codex/src/items.ts` 解析 `FileUpdateChange` 生成 `git_patch`     |
| **P0** | **Shell 命令统一体验**              | 统一命令摘要、拆壳语义分类（`rg`/`cat`/`ls`）、耗时/非 0 退出码、失败高亮、连续分组                                                                | 极高（高频动作；核心修复已在 CYC-308 落地，后续可补 `durationMs`） | 低     | CYC-308 已完成基础；耗时需决定是否进 `toolResult.run.durationMs`          |
| **P1** | **MCP / Connector 统一呈现**        | 三端统一标题格式 `server · tool`（去掉 `Run mcp_...` 噪音）、行摘要取关键参数（标题/编号/查询）、失败错误高亮、结果友好格式化（避免单行转义 JSON） | 高（Plan/GitHub/自定义 MCP 使用频率仅次于 Shell）                  | 低–中  | `harness/codex` 与 `harness/agy` 规范化 MCP `title` 与 `content` 文本提取 |
| **P1** | **agy 读取与搜索计数**              | `read_file` 填 `_meta["cycle/toolResult"].read`（`StartLine`/`EndLine` 已有）；搜索类工具填 `toolResult.search`；补全 `Show in Files` 跳转         | 中高（让 agy 读写行与 Claude 体验对齐）                            | 低     | `harness/agy/src/translate.ts` 读取 `rawInput`/`rawOutput` 行号信息       |
| **P1** | **Codex / agy 命令耗时与 cwd 展示** | 展开后的命令块标题栏在运行较久（如 ≥ 2s）时显示耗时，非会话根目录时显示相对 `cwd`                                                                  | 中（定位慢命令与多 worktree 场景很实用）                           | 低     | 协议增加 `toolResult.run.durationMs?`（可选数字，不涉及内容）             |
| **P2** | **agy 子 agent 卡片对齐**           | `invoke_subagent` 接入 `subagent_update` 状态与摘要，与 Claude/Codex 子 agent 卡片收敛                                                             | 中                                                                 | 高     | 依赖 `agy acp` 暴露子 agent 生命周期事件                                  |
| **P2** | **Web Search / Fetch 富结果**       | Codex / agy 的网页搜索结果输出 `resource_link` 列表，复用 UI 已有的安全外链卡片                                                                    | 中低                                                               | 中     | 取决于各 agent 是否在协议层返回结构化 URL                                 |
| **P2** | **审批 / 提问回放增强**             | 已回答的 `AskUserQuestion` / `request_user_input` 在展开区以问答对呈现而非原始 JSON                                                                | 低–中                                                              | 低     | UI 已有 `questionsOf()`，补回答配对渲染即可                               |
| **P3** | **思考 / 压缩时间线**               | 保持默认隐藏正文（仅步骤行显示 `Thinking…` 与单行 `Context compacted`），详细模式下折叠滚动；不默认展开                                            | 维持克制（符合 DESIGN.md 注意力原则）                              | 低     | 现状已满足，仅需确保各端发齐 `compaction_update`                          |

---

## 五、统一展示逻辑规范

### 1. 三层信息密度

- **默认单行（行内扫描）**：`[动词或目的句]` + `[单行等宽摘要]` + `[关键数量/状态指标]` + `[运行中计时或失败态]`。不放图标噪音，默认收起。
- **分组卡片（连续工作折叠）**：同一 stretch 内 ≥ 2 个工具调用折叠成一张卡片（如 `Ran 5 commands`、`Read 3 files and edited 1 file`）；正常结束的回合在最终回复前整体折成一行 `Worked for Ns`。
- **展开详情（按需排查）**：仅展示默认行尚未说清的内容——命令块（可复制 + 结束态）+ 额外参数（不重复命令）+ Diff 视图 / 跳转按钮 + 裁剪后的输出（stdout / stderr 分区）+ 链接/图片。

### 2. 单行 vs 分组规则

- 同一 turn 中，消息（user/agent）、计划（plan）、通知（notice）、子 agent 卡片、代码评审卡片会切断 stretch；`thought` 和 `retry` notice 不切断。
- `kind: "think"` 且未失败的调用（计划更新、内部工具检索）不单独成行，避免刷屏；失败时照常展示。
- 仅 1 个调用时直接画单行；≥ 2 个调用合并为工作卡，卡片汇总计数与展开后的明细活动类型严格一致（例如纯搜索/读文件/列目录命令按语义计入 `Searched` / `Read` / `Listed`）。
- 若 turn 非正常结束（`error`/`cancelled`/`max_tokens`），最后一个 stretch 中失败的调用单独抽出卡片下方，突出中断原因。

### 3. 摘要优先级链（无 agent 名称特判）

1. **Agent 目的句**（`rawInput.description`，单行 ≤ 160 字，且仅限明确语义为"操作说明"的执行/监视/子任务工具）：整行只显示目的句，具体命令移入 tooltip、读屏与展开块。
2. **命令语义标签**（`commandLabelOf`）：对无目的句的纯只读命令（支持拆壳 `/bin/zsh -lc`）自动归类为 `Searched 'pat' in dir` / `Read a.ts` / `Listed src`。
3. **结构化目标字段**：按 `command` → `file_path`/`notebook_path`/`path` → `pattern` → `url` → `query` 取首个非空字符串。
4. **位置字段**：`locations[0].path`（多文件显示 `<first> +N`）。
5. **通用短文本**：提问列表首问或 `rawInput` 中首个单行短文本（≤ 120 字）。
6. **ACP `title` 降级**：仅当活动类型不是 `other`（动词为通用词 `Ran`/`Read`/`Edited`/`Searched`/`Fetched`）且 `title` 不等于 `name`/`"Tool"` 时回落到 `title`，避免与 `other` 类型的动词重复。

### 4. 状态与失败表达

- **进行中**：动词用进行时（`Running` / `Reading` / `Editing`）+ 实时耗时；`pending` 显式写 `pending`。
- **成功**：动词用过去时（`Ran` / `Read` / `Edited`）；`exitCode === 0` 不额外打印 `"exited with code 0"` 噪音，展开后命令头标 `Succeeded`。
- **失败 / 取消**：文字状态 + 语义危险色（形状+颜色+文字，符合 DESIGN.md）；命令非 0 退出码行内显示 `exited with code N`，stderr 区块标危险色，输出保留尾部（错误信息通常在末尾）。
- **后台 / 超时 / 中断**：由 `_meta["cycle/toolResult"].run` 的 `background` / `timedOutMs` / `interrupted` 驱动对应文案。

### 5. 长输出截断与降级

- **适配器侧**：命令输出保留尾部（`outputTail`，100K 字符上限，避免切在 emoji 代理对中间）；命令标题与 MCP 返回保留头部（`outputHead`）；多文件 Diff 按文件预算逐个裁剪，超限列文件名或计数。
- **UI 侧**：默认展示输出末 40 行，点击展开全文（单块上限 20,000 字符）；解析 16 色 ANSI 并按主题校准 4.5:1 对比度，复制时输出纯文本。
- **降级**：任何缺失的结构化字段只导致对应特型信息不显示，绝不报错、不丢行、不按 agent 名称写分支。

### 6. 埋点边界（红线）

- 工具展示相关埋点只能上报**交互行为与枚举/计数**（如 `diff_shown_from_conversation`、`file_shown_from_conversation`），**绝不得**上报命令文本、文件路径、搜索词、MCP 参数、工具输出、错误原文或自定义工具名。

---

## 六、分阶段实施方案（建议拆分的后续 Workitem）

1. **Phase 1（高优先，补齐编辑与 MCP 一致性）**
   - Workitem 1A：`Codex fileChange 输出 ACP diff 内容与增删计数，接入会话 Diff 面板`（改动集中在 `harness/codex/src/items.ts` 及单测）。
   - Workitem 1B：`统一 Codex / agy 的 MCP 工具标题（server · tool）与结果文本提取`（去掉 `Run mcp_...` 与转义 JSON 噪音）。
2. **Phase 2（中优先，补齐读/搜事实指标与命令上下文）**
   - Workitem 2A：`agy read_file 补齐 _meta["cycle/toolResult"].read 行数范围`（复用 UI 现有行号渲染）。
   - Workitem 2B：`协议与 UI 支持 toolResult.run.durationMs 与非根目录 cwd 展开展示`。
3. **Phase 3（低优先，富交互增强）**
   - Workitem 3A：`Web Search / Fetch 链接列表接入三端 resource_link`。
   - Workitem 3B：`审批/提问类工具展开区按问答对展示（替代原始 JSON）`。
   - Workitem 3C：跟进 `agy acp` 子 agent 协议能力，具备后对齐 `subagent_update`。
