# Agent Note: 右侧面板显示什么，只在面板自己的标签条里选

Status: accepted
Date: 2026-11-28
Basis: 2026-11-28 负责人看过现状分析后选定（"全部都做"，并明确"和分支比较可以先不做"）；此前的结构见[右侧面板的布局](2026-11-21-right-panel-layout.md)。

## Problem

会话头部有 Overview、Files、Diff、Terminal 四个按钮，面板里又有同名标签：两套导航做同一件事。三个视图各有一套头部（Files 是根目录名加刷新，Diff 是分段控件加两行说明，再加一行"Against commit"），行高和内边距都不同；Diff 展开后是缩进的卡片，Files 的文件是对话里折叠成 12 行的代码块。面板读起来像三个不相干的东西。

## Decision

- **头部只留一个开关面板的按钮**（`⌘\` 不变）。显示哪个标签只在面板的标签条里选：三个视图默认都在条里；每个标签可以关，关掉的从条末 `+` 菜单加回，菜单里还有 New terminal；关掉最后一个标签等于收起面板。`CLOSED` 的默认标签因此从只有 Overview 变成三个视图；已存的旧状态原样保留。
- **每个标签同一个骨架**：标签条下一行工具条（`PanelBar`，左边说看的是什么，右边是图标动作），内容铺满面板宽度，不套卡片。
- **路径**一律目录淡、文件名正文色，放不下时截目录、留文件名（`PathLabel`）。Diff 的状态用 git 的字母，modified 不显示。
- **Overview** 没内容的区块合并成末尾每块一行，仍然说明原因，不省略。

## Alternatives considered

- **保留头部的各标签按钮**：打开某个标签少一次点击（面板关着时）。没选：同一件事两处入口，头部在 720px 窗口里要挤六个按钮；视图默认都在标签条里之后，多出的只是打开面板那一下。
- **Diff 和分支比较**（HEAD → origin/main，参考截图里的做法）：daemon 现在只比较 HEAD，要先改 `docs/protocol.md` 和 daemon。负责人说先不做，没有排期。
- **文件树和内容左右并排**：面板默认 400px、最小 280px，放不下；要先有"放大面板"才有意义。没做。
- **彩色的文件类型图标**：DESIGN.md 只允许一套线性图标，没有引入第二套。

## Consequences

- 埋点：`side_panel_toggled` 的 `via: "tab_button"` 和 `terminal_opened` 的 `via: "header"` 不再发出，枚举值留着（页面热更新会发给旧应用，旧应用仍按自己的字典校验）；新增 `side_panel_tab_closed`、`diff_all_toggled`、`diff_wrap_toggled`、`files_found`、`files_folder_revealed`。
- Files 的改动标记多一次 `workspaceStatus` 请求（每轮一次，只在 daemon 能比较时）。
- "全部展开"一次最多开 100 个文件，补丁一次最多向 daemon 要 4 个（每个是一个 git 进程，目标机器 2 核）。两个数都是估的，没在真实的大仓库里量过。

## Related

- [右侧面板的布局](2026-11-21-right-panel-layout.md)：位置、宽度、折叠、按会话记住，仍然有效；其中"标签条"一节由本笔记补充。
- [Files 和 Diff 的数据来源](2026-11-22-files-and-diff-sources.md)：两个视图各自覆盖什么，没有变。
