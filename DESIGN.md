# DESIGN.md

Cycle 界面的设计系统：**这个应用长什么样、为什么**，作为界面实现的**单一事实源**。给人和 coding agent 读。

> **结构说明（2026-11-19 v2 升级）**：本文按五层设计工程体系组织：**1. 色彩体系 → 2. 样式与材质体系 → 3. 组件体系 → 4. 设计范式 → 5. 语义决策体系**，后附状态画廊、代码配色、i18n 与实现追踪。本轮参考 Rare UI 的设计语言升级了纯净中性灰表面、国际安全橙单点强调、`Open Runde + Inter + Geist Mono` 本地三字体排版、同心圆润圆角与 Apple 硬件微高光材质，并补齐了 Tailwind v4 `@theme inline` 映射以无缝兼容 Rare UI / shadcn 组件。
>
> - 执行流程、检查清单与自检脚本见 [`.claude/skills/cycle-design-taste`](.claude/skills/cycle-design-taste/SKILL.md)。
> - 控件工程边界与无障碍底线见 [`packages/ui/AGENTS.md`](packages/ui/AGENTS.md)。
> - 核心交互的背景取舍见 `.agents/notes/` 与 `docs/decisions/`。

## 定位与原则

**安静而精密的工具。** 一个人每天开几个小时：盯着 agent 干活、批准它的操作、回看它做了什么。用户的注意力应该在 agent 正在做的事上；界面本身退后却有质感——一旦需要操作或出现问题，立刻以清晰克制的信号抓住视线。

- 纯净中性灰打底，**一个国际安全橙强调色**（`#FC4C01` / `#CF3D00`），只用来表示“这里可以操作”和“正在发生”。
- 状态用**形状 + 颜色 + 文字**，不单独依赖颜色。
- 层次靠**留白、纯净明度差、微高光硬件描边（`--cycle-edge-hardware`）与克制投影**，浮层与主输入框带精细层次阴影。
- **圆润亲和的同心圆角**：内圆角 = 外圆角 − 内边距，胶囊与大圆角容器消解暗黑界面的冷硬感，同时保持桌面工具的信息密度。
- 没有冗余渐变（应用图标除外）、大面积毛玻璃、霓虹发光或装饰图案；仅允许 1px 顶部受光硬件微高光增强触感。
- 对话是主角：内容列居中、限制行宽；侧栏与头部退后。
- 参照感觉：Rare UI 的精致亲和与工业橙焦点、Apple 硬件的受光边缘、Linear 的克制、Zed 的密度。

---

## 第 1 层：色彩体系（Color Tokens）

全部颜色用 `light-dark()`。默认跟随系统深浅色；设置页的 Theme 可以指定浅色或深色（CYCL-79），做法是主进程设 `nativeTheme.themeSource`，样式里仍然只有 `light-dark()` 和 `prefers-color-scheme`，不为主题另写一套选择器。组件只引用语义名（`--cycle-*` 与重映射后的 `--ui-*`），不写散落十六进制值。

### 1.1 中性表面、边框与文字（纯净中性灰）

参考 Rare UI 与 Apple 硬件中性灰体系重调，在暗色下避免纯黑 OLED 晕影的同时保持深邃质感，在浅色下以纯白画布配 Apple 标志性冷浅灰 `#F5F5F7` 侧栏。`app.css` 将 ui-sdk 与 Tailwind v4 `@theme inline` 的语义令牌统一映射到它们。

| 令牌                        | 用途                                                     | 浅色      | 深色      |
| --------------------------- | -------------------------------------------------------- | --------- | --------- |
| `--cycle-surface-workspace` | 对话和主区底色                                           | `#ffffff` | `#0a0a0a` |
| `--cycle-surface-sidebar`   | 侧栏和窗口底色                                           | `#f5f5f7` | `#050505` |
| `--cycle-surface-raised`    | 浮层与卡片底色（菜单、权限卡、代码卡片、输入框、对话框） | `#ffffff` | `#141414` |
| `--cycle-surface-message`   | 用户气泡、行内代码、表头色带与下沉填充块（`--ui-muted`） | `#f2f2f4` | `#1b1b1c` |
| `--cycle-surface-hover`     | 行和控件的悬停                                           | `#ececef` | `#222224` |
| `--cycle-surface-selected`  | 选中和按下（选中的会话行等）                             | `#e4e4e8` | `#2b2b2e` |
| `--cycle-border-subtle`     | 列表、卡片内部行与行的轻分隔                             | `#ededf0` | `#1f1f22` |
| `--cycle-border-default`    | 卡片、浮层、分隔线（`--ui-border`）                      | `#e2e2e6` | `#2c2c30` |
| `--cycle-ink`               | 正文、标题                                               | `#141414` | `#f5f5f7` |
| `--cycle-ink-secondary`     | 标签、侧栏平时行、图标                                   | `#454549` | `#c7c7cc` |
| `--cycle-ink-muted`         | 元信息、时间、路径、占位（`--ui-muted-foreground`）      | `#636369` | `#98989f` |
| `--cycle-ink-disabled`      | 仅用于禁用控件，不承载关键信息                           | `#8a8a92` | `#6e6e75` |
| `--cycle-ink-code`          | 回复里的行内代码文字（链接里的代码随链接色）             | `#b4371f` | `#fb8b73` |
| `--cycle-link`              | 回复里的链接，浅下划线，悬停加深                         | `#1d4ed8` | `#60a5fa` |

对比度底线：

- **四档文字**：浅色下对 workspace 为 `18.4 / 9.5 / 6.0 / 3.4:1`；深色下为 `18.2 / 11.8 / 6.9 / 3.9:1`。
- **`ink-muted` 在所有表面上 ≥ 4.5:1**（包括选中行：浅色 4.71、深色 4.92）。
- **控件边框不用 `border-default`**：`border-default` 只做轻分隔；输入控件与描边按钮边界用 `--cycle-input-border`（未聚焦时深浅色下均 ≥ 3.3:1）。

### 1.2 强调色与功能色

| 令牌                        | 用途                                     | 浅色      | 深色      | 对比度（对画布 / 字对底）               |
| --------------------------- | ---------------------------------------- | --------- | --------- | --------------------------------------- |
| `--cycle-accent`            | 主要操作、选中焦点、正在工作             | `#c93b00` | `#fc4c01` | 5.11（浅）/ 5.82（深）（对侧栏 4.69）   |
| `--cycle-accent-foreground` | 强调色底上的文字与图标                   | `#ffffff` | `#ffffff` | 5.11（浅）/ 3.40（深，600 字重+高光边） |
| `--cycle-attention`         | 等待批准（Needs you）、警告、高风险提示  | `#8a5a00` | `#f5b82e` | 5.93（悬停 5.03）/ 11.10                |
| `--cycle-success`           | 已连接、完成、diff 新增                  | `#1a7f37` | `#30d158` | 5.08 / 9.79                             |
| `--ui-destructive`          | 失败、断线、不可逆删除、diff 删除        | `#c4343b` | `#e87872` | 5.38 / 6.94                             |
| `--cycle-input-border`      | 输入框等需要可识别边界的控件边框         | `#8b8b93` | `#63636a` | 3.34 / 3.32（均 ≥ 3:1）                 |
| `--cycle-focus-ring`        | 键盘焦点环（中性银灰，不抢安全橙主操作） | `#6b6b75` | `#8e8e98` | 4.16–5.27 / 4.35–6.28                   |

约束：

- **色相清晰分离**：主强调色为 Rare UI 标志性**国际安全橙**（暗色 `#FC4C01`，浅色按 AA 对比度微调为 `#C93B00`，确保在 `#F5F5F7` 侧栏上仍 ≥ 4.5:1）；警示色 `--cycle-attention` 采用**琥珀金黄**（`#8A5A00` / `#F5B82E`），避免与安全橙冲突；成功采用 Apple HIG 翡翠绿，错误在暗色下采用低饱和柔和珊瑚红 `#E87872`（避免纯红在黑底产生色散晕光与视觉压迫）。**不新增色相**。
- **功能色柔化填充**：出错块（如回合失败 `turn-end`）采用 `8%` 功能色底 + `40%` 功能色描边（`color-mix`），文本选中态 `::selection` 使用 `22%` 强调色柔化底。
- **克制的中性焦点环**：统一采用中性银灰 `1.5px solid var(--cycle-focus-ring)`（深浅色在所有表面上均 ≥ 4.1:1），避免高亮橙色线框抢走主操作焦点或造成割裂感；输入框将焦点环贴边（`outline-offset: -1px`）并叠柔化外光晕 `--cycle-focus-halo` 消除双层边框空隙；主输入框例外：只加深边框并托起一点阴影（`--cycle-focus-composer`），没有焦点环、光晕或第二层边框；侧栏列表行已选中态保持无边框纯底色胶囊（`--cycle-surface-selected`），未选中行键盘聚焦时使用内贴 `1.5px` `--cycle-focus-ring`。ui-sdk 默认的 `--ui-ring`（浅色下仅 1.29:1）禁止用于焦点指示。

---

## 第 2 层：样式与材质体系（Style & Surface Tokens）

### 2.1 排版（Typography）

直接采用 **Rare UI 同款三套开源字体（SIL OFL-1.1）**，通过 `@fontsource/*` 纯本地 WOFF2 打包并由 `packages/ui/scripts/build-css.ts` 同步输出至样式旁 `fonts/` 目录，**零外网请求**，完全遵守 Electron CSP（`font-src 'self' data:`）：

- **展示与交互触点字体 `--cycle-font-display`（`Open Runde`）**：带圆角的几何无衬线（`400 / 500 / 600 / 700`），通过显式字重区间映射使 `--cycle-weight: 420` 准确命中 Regular；用于按钮、触发器、会话头部标题、弹窗标题、空状态标题、工作区切换器、侧栏分组标签、权限卡标题与空白页引导。标题配紧字距 `--cycle-tracking-display`（`-0.015em`）。
- **正文与密集信息字体 `--ui-font-sans`（`Inter Variable`）**：可变无衬线（开启 `cv02, cv03, cv04, cv11` 光学字形特性与抗锯齿渲染），用于对话正文、Markdown、输入框、会话列表与工具说明，保证长时间阅读清晰舒适。
- **等宽字体 `--ui-font-mono`（`Geist Mono Variable`）**：仅用于代码、命令、路径、diff、id、系统错误原话。
- **中文 PingFang 字重映射**：PingFang SC 为固定字重档，`420` 会落到 Medium 导致中文全粗。`app.css` 保留 `Cycle PingFang`（4 个 `@font-face` + `local()`）把 Light/Regular/Medium/Semibold 映射到 1–349 / 350–449 / 450–549 / 550+，排在 `PingFang SC` 前面。
- **字阶（仅四档，根字号 16px）**：

| 档位    | 大小令牌             | 行高令牌                | 真实值              | 用在                                    |
| ------- | -------------------- | ----------------------- | ------------------- | --------------------------------------- |
| `meta`  | `--cycle-text-meta`  | `--cycle-leading-meta`  | 12px / 1.5 (18px)   | 状态文字、用量、按键提示、路径、时间    |
| `ui`    | `--cycle-text-ui`    | `--cycle-leading-ui`    | 13px / 1.46 (19px)  | 按钮、侧栏、表单、工具行（ui-sdk 基准） |
| `body`  | `--cycle-text-body`  | `--cycle-leading-body`  | 14px / 1.5 (21px)   | 对话正文、输入框正文                    |
| `title` | `--cycle-text-title` | `--cycle-leading-title` | 16px / 1.4 (22.4px) | 对话框标题、空状态标题、大区块标题      |

- **字重与数字**：常规字重为 `--cycle-weight`（浅色 `420`，深色 `400`，避免浅字在深底显粗）；其余仅用 `500` 和 `600`（`600` 用于标题、实心主按钮、`Needs you` / `Unread` 加重）。灰字保持常规字重。数字（用量、百分比、版本、价格）用 `tabular-nums`。

### 2.2 间距、尺度与同心圆角

- **间距**：4px 网格（`--ui-spacing`），常规布局间距取 1、2、3、4、6、8 倍（为满足同心圆角嵌套 `内圆角 = 外圆角 − 内边距`，容器内边距允许使用 `6px / 10px / 14px` 半档）；基本间距 `--cycle-gap` 为 `0.75rem`（12px），turn 之间 `--cycle-gap-turn` 为 `2rem`（32px）。
- **内容列**：对话、权限区、输入框、空白页条件区共用同一条居中列宽：`--cycle-measure`（`48rem`，约 72 字符），水平内边距由 `--cycle-column-pad` 算出。
- **圆角（同心阶梯，内圆角 = 外圆角 − 内边距；CYCL-75 起主输入框与卡片同为 16px，气泡 14px）**：
  - `--cycle-radius-sm`（`6px`）：徽标、计划勾框、行内代码、按键胶囊、缩略图
  - `--ui-radius`（`10px`）：控件、按钮、侧栏行、菜单项、输入框控件、工具展开块
  - `--cycle-radius-card`（`16px`）：菜单与候选列表（`padding: 6px` 内嵌 `10px` 项）、工具/代码/表格/连接器卡片、权限卡
  - `--cycle-radius-message`（`14px`）：用户消息气泡（一行高时是圆角矩形，不是胶囊）
  - `--cycle-radius-composer`（`16px`）：主输入框外框，单行 46px 高（含边框）时是圆角矩形而不是胶囊；`padding: 6px` 内嵌 `10px` 控件（CYCL-75，负责人：胶囊不精致）
  - `--cycle-radius-pill`（`9999px`）：全圆胶囊（`Send` / `Stop`、`Queue`、`SettingChip`、`Earlier`、`option-tag`）

### 2.3 硬件微高光、阴影、遮罩与动效令牌

- **硬件微高光描边（参考 Rare UI `.border-apple`）**：
  - `--cycle-edge-composer`：主输入框专用，只保留 1px 顶部受光，不叠全周内描边，免得与边框成两条线；`--cycle-focus-composer`：主输入框聚焦时比平时稍深的托起阴影，配合加深的边框，代替光晕和外圈线（负责人：只加深边框和一点阴影，不要两层边框）；高对比模式下边框用全强度 `input-border`（CYCL-75，负责人要求更精致）。
  - `--cycle-edge-hardware`：1px 顶部受光内高光 + 极淡全周内描边（暗色下叠加底部暗边），赋予卡片、浮层、输入框与描边按钮阳极氧化铝般的立体触感；同时提供 `.border-apple` 兼容工具类供 Rare UI 组件复用。
  - `--cycle-edge-accent`：安全橙实心按钮的顶部微高光与底部压边（`inset 0 1px 0 rgb(255 255 255 / 28%)`），让主操作自带按压实体感。
- **阴影与遮罩**：`--cycle-shadow-composer`（主输入框轻量托起）、`--cycle-shadow-popover`（菜单、权限卡、候选列表）、`--cycle-shadow-dialog`（对话框、搜索面板）、`--cycle-scrim`（模态遮罩）。深色模式下阴影更深，配合 `--cycle-edge-hardware` 与更亮一档的 `surface-raised` 区分层次。
- **长文末尾淡出**：`--cycle-fade-end`（末尾 `1.5rem` 线性透明遮罩），通过滚动驱动动画只在实际溢出时触发，`prefers-reduced-motion` 下仍保持静态显示。
- **动效（三档时长 + 统一曲线）**：
  - 曲线：`--cycle-ease`（`cubic-bezier(0.2, 0.8, 0.2, 1)`）
  - `--cycle-motion-state`（`100ms`）：悬停底色、按钮/操作显隐
  - `--cycle-motion-disclosure`（`160ms`）：展开/收起箭头旋转与面板过渡
  - `--cycle-motion-enter`（`200ms`）：浮层、横幅、对话框进入
  - `prefers-reduced-motion: reduce` 下所有过渡与动画静止（除 `--cycle-fade-end`）。

### 2.4 材质样式整合（Surface Styles）

所有界面容器必须归属于以下材质预设之一，不再在局部各自组合边框与阴影：

| 材质名             | 底色                                  | 边框与边缘高光                                                                                                                                                                | 圆角                             | 阴影                      | 适用对象                                                |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------- | ------------------------------------------------------- |
| `Surface/Base`     | `workspace` / `sidebar`               | 无                                                                                                                                                                            | 0                                | 无                        | 主区、侧栏背景                                          |
| `Surface/Ghost`    | 透明（悬停 `hover`，选中 `selected`） | 无                                                                                                                                                                            | 10px (`--ui-radius`) 或 `pill`   | 无                        | 侧栏行、动作行、工具单行/折叠头、设置芯片               |
| `Surface/Sunken`   | `surface-message`                     | 用户气泡用 `border-default` + `--cycle-edge-hardware`，内嵌无边                                                                                                               | 6 / 10 / 14px                    | 无                        | 用户消息气泡、工具输入输出、行内代码、按键胶囊          |
| `Surface/Card`     | `surface-raised`                      | `1px border-default` + `--cycle-edge-hardware`                                                                                                                                | 16px (`--cycle-radius-card`)     | 无                        | 代码块卡片、连接器列表                                  |
| `Surface/Popover`  | `surface-raised`                      | `1px border-default` + `--cycle-edge-hardware`（权限卡顶边 3px `attention`）                                                                                                  | 16px (`--cycle-radius-card`)     | `--cycle-shadow-popover`  | 下拉菜单、`Select` 列表、`PickerMenu`、`PermissionCard` |
| `Surface/Dialog`   | `surface-raised`                      | `1px border-default` + `--cycle-edge-hardware`                                                                                                                                | 16px (`--cycle-radius-card`)     | `--cycle-shadow-dialog`   | 模态对话框、确认框、`⌘K` 搜索面板                       |
| `Surface/Composer` | `surface-raised`                      | `1px border-default` + `--cycle-edge-composer`（只有顶部微光，无内描边）；聚焦时边框加深一档（`input-border` 60%），再托起一点阴影 `--cycle-focus-composer`；始终只有一层边框 | 16px (`--cycle-radius-composer`) | `--cycle-shadow-composer` | 主输入框整块                                            |

### 2.5 Rare UI / shadcn 令牌桥接（Tailwind v4 `@theme inline`）

为兼容 Streamdown 与后续引入的 Rare UI 组件，`packages/ui/src/styles/app.css` 在 `@theme inline` 中将标准 shadcn/Rare UI 语义变量完整桥接到 Cycle 令牌：

- **色彩**：`bg-background` / `bg-card` / `bg-popover` / `bg-muted` / `bg-secondary` / `bg-accent`（悬停柔化面）/ `bg-primary`（安全橙 `--cycle-accent`）/ `bg-destructive` / `bg-sidebar*` / `border-border` / `border-input` / `ring-ring`。
- **字体**：`font-sans`（Inter Variable）、`font-runde` / `font-display`（Open Runde）、`font-mono`（Geist Mono Variable）。
- **圆角与质感**：`rounded-sm`（6px）至 `rounded-2xl`（16px）对齐同心阶梯（`lg`、`xl`、`2xl` 现在都是 16px），并提供 `.border-apple` 工具类直连 `--cycle-edge-hardware`。

后续引入任何 Rare UI 组件时，只需清理其中的硬编码色值（改为引用上述语义类），即可自动跟随 Cycle 的系统明暗主题与无障碍对比度。

---

## 第 3 层：组件体系（Components & Variants）

基础控件优先使用 `@ui-sdk/react` 并映射为 Cycle 样式；业务通用件收口在 `packages/ui/src/react/`。**注意 ui-sdk 坑点**：`Collapsible`、`Command` 等会覆盖传给它的 `data-slot`，写样式优先用 `data-kind` 或 `data-palette`。

| 组件                     | 来源                                                                                | 允许变体 / 状态                                                                                             | 映射材质与规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                 | `@ui-sdk/react/button`                                                              | `solid`、`destructive`、`outline`、`ghost`、`data-kind="round"`、`data-kind="queue"`                        | `solid` 用 `--cycle-accent`；破坏性操作用 `destructive`（`--ui-destructive`）；`outline` 为默认描边按钮；`ghost` 无底无边（`Surface/Ghost`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Menu`                   | `@ui-sdk/react/menu`                                                                | 普通项、`destructive`、勾选项、单选组（`MenuRadioGroup`）、分组标题、分隔线                                 | 全应用一种菜单（CYCL-65）：`Surface/Popover`，行高 28px、`ui` 字号，悬停与键盘高亮直接着色、不做滑动；勾选与单选的对勾一律放在行尾、用 `accent`；分组标题 `meta` 字号淡色；选项可带名字、标签与一行说明（`OptionLabel`）。出现 200ms、收起 100ms。键盘、焦点归还、点外关闭都用 SDK 的，不自己写 `role="menu"`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Popover`                | `@ui-sdk/react/popover`                                                             | 只读详情（`initialFocus="content"`）、含表单                                                                | 与 `Menu` 同一 `Surface/Popover`；用 `aria-labelledby` 指向弹层里的标题。首个用户是 context 环的详情（`context-details.tsx`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Tip`                    | 自建（`tip.tsx`，包 `@ui-sdk/react/tooltip`）                                       | 带或不带快捷键（`shortcut="mod+b"`）                                                                        | 只有图标的控件用 `Tip` 命名：它同时是读屏的名字，控件本身不再写 `aria-label` 或 `title`；用 `render` 包任何触发器（按钮、菜单或弹层的），不改其行为。小号 `Surface/Popover`、`meta` 字号，100ms 淡入，在一排按钮间移动时即时跟随。截断文字的全称仍用 `title`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SplitLayout`            | 自建（`split-layout.tsx`，包 `@ui-sdk/react/resizable`）                            | 两栏（侧栏 + 对话区）、三栏（加右侧面板）                                                                   | 窗口的三栏同在一个分栏组：侧栏 200–360px（默认 256）、对话区最小 400px、右侧面板最小 280px（默认 400）。两条分隔条行为相同（拖动、方向键、Home/End、Enter 与双击折叠再恢复）。窗口变窄时，面板开着的话对话区先保持 480px，面板先压到最小，再自动折叠侧栏（变宽后恢复），最后才把对话区压到 400px；没有面板时只在对话区不足 400px 时折叠侧栏。面板从不覆盖对话区。依据见 `.agents/notes/2026-11-21-right-panel-layout.md`                                                                                                                                                                                                                                                                                                  |
| `PageLayout`             | 自建（`page-layout.tsx`，包 `@ui-sdk/react/tabs` 竖排）                             | 分区选中、悬停、键盘焦点；`PageGroup` / `PageRows` / `PageRow`                                              | 整窗页面的框架（§4.7）：导航在 `surface-sidebar` 上，分区内容在 `Surface/Base`，成组的行是一张 `Surface/Card`；方向键切换分区，只挂载当前分区                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PanelTabs`              | 自建（`panel-tabs.tsx`，包 `@ui-sdk/react/tabs`）                                   | 选中、悬停、键盘焦点                                                                                        | 面板的标签条：高 42px 与对话区头部对齐，`ui` 字号，选中为 `surface-selected` 底；方向键切换；只挂载当前标签的内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Files`                  | 自建（`files.tsx`）                                                                 | 文件树、文件预览、加载、出错（带原话与 Retry）、环境未连接、daemon 太旧                                     | 右侧面板的 Files 标签（CYCL-92）：头部写所在位置（根目录名，或从尾部保留的文件路径）和"重新读取"；树一次读一层，行高 28px、按所在文件夹缩进 1rem，被 git 忽略的和打不开的条目变淡不隐藏；点文件时预览替换文件树（树只隐藏，返回时原样），代码走对话的 Markdown 高亮（过大的纯文本不上色），Markdown 渲染，图片按宽度缩放，其他类型明说没有预览；文本分块读，末尾给"Show more"。对话里读过或改过的文件（工具行展开后的"Show in Files"）和 @ 提及的文件（可点的提及片）都能打开到这里                                                                                                                                                                                                                                       |
| `Diff`                   | 自建（`diff.tsx`）                                                                  | 本会话 / 工作区两个视图、空、加载、出错（带原话与 Retry）、不在 git 仓库、仓库未被信任、提交前              | 右侧面板的 Diff 标签（CYCL-95）：daemon 能比较时顶部是 `SegmentedControl`（本会话、工作区），否则只有本会话。每个视图先用一行淡色说明自己的范围（本会话只含 agent 用文件工具做的编辑，不含命令造成的改动；工作区对比最近一次提交）。本会话按轮次分节，最近的在前，节头是那一轮的提问（末尾淡出）与 `+a −d`；文件行像工具行一样安静，路径从开头截断、保留文件名，展开是和工具行同样的 diff，下面有"Show in conversation"回到那次调用。工作区的文件行带状态词（added/modified/deleted/untracked、binary），展开时才向 daemon 要补丁，未删除的文件可"Show in Files"。没有可比较的原因写清并指出下一步                                                                                                                        |
| `StateBlock`             | 自建（`state-block.tsx`）                                                           | `empty` / `loading` / `error` / `away`；`page`（整块区域，居中或靠左）/ `inline`（列表、面板、对话框里）    | 内容所在处的空、加载、出错、断线一律用它（CYCL-67）：只有有意义时才带图标（加载转圈、出错红圈、断线注意色三角），一行标题、可选一行说明、系统原话单独成等宽可选块（不拼进句子）、至多一个 `outline` 动作。出错是 `alert`，加载与断线是 `status` 并标 `aria-busy`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Banner`                 | 自建（`app.tsx` / `update.tsx` / `analytics.tsx`）                                  | `data-severity="info" \| "warning" \| "error"`                                                              | 全宽底栏 + `3px` 左侧语义竖条 + 16px 图标 + 单句事实 + 至多 1 个操作按钮 + `Dismiss`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `StatusDot` & `Badge`    | 自建（`status.tsx` / `workspace-switcher.tsx`）                                     | 点：`solid`、`pulse`、`square`、`ring`、`cross`；角标：`needs-you` / `running` / `background` / `unread`    | 颜色 + 形状双通道：Working=accent 脉动圆点，Needs you=attention 实心方块，Background=accent 空心环，Unread=accent 实心圆点，Connected=success 圆点，Reconnecting=attention 空心环，Not connected=danger 叉                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SettingChip`            | 自建（`setting-chips.tsx`，交互受 Rare UI `Model Picker` 启发）                     | 正常、`data-unset`（`Not set`）、危险权限态（盾牌警示色）                                                   | 位于输入区下方无边框工具栏：左侧权限模式带盾牌图标（高危态用 `--cycle-attention`），右侧依次是 Model 芯片（正文色）和 Effort 芯片（淡色，`default` 时写 Default effort），各开各的菜单。每个芯片就是一个 `Menu`（单选组，见下行），不另写弹出层：列表一眼可读，不带过滤；芯片上按 ↓/↑ 或 Enter 打开并落在首项，鼠标打开时方向键从首项开始；对勾标出会话已有的值（请求在途时标出最后一次的选择），芯片本身只显示会话已有的值。菜单不是模态的：开着一个时点另一个芯片，直接换成那个。Model 与 Effort 菜单只列名字（说明在悬停标题里）；Effort 只列该模型支持的档位，`default` 不单列：写在 Medium 后面（Medium (default)），Model 菜单里写在它指向的型号后面（如 Opus 5.5 (default)），模型不支持 effort 时没有 Effort 芯片 |
| `StepLine`               | 自建（`inline-ai-status.tsx` + `turn.tsx`，视觉受 Rare UI `Inline AI Status` 启发） | `thinking` / `working` / `tool` / `approval`                                                                | 单行实时状态：图标平滑切换 + 仅基于 `opacity` 的柔和呼吸脉动（`approval` 静默显示琥珀金）+ 位于 live region 外的 `tabular-nums` 耗时秒表（≥ 1s 显现），`prefers-reduced-motion` 下静止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PlanList`               | 自建（`plan.tsx`，移植自 Rare UI `Task list`，保留版权与出处）                      | `pending`（虚线环）/ `in_progress`（橙色虚线环缓转）/ `completed`（橙色实心圆打勾、划线、移到未完成的下面） | 按 Cycle 的密度画：不用卡片，一行一条，在输入框托盘里与上方那行同字号（`meta`）；agent 标记完成时依次打勾、划线，再下移（各 ≤200ms，去掉原组件的弹跳与抖动）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ToolRow` & `WorkCard`   | 自建（`tool.tsx` / `turn.tsx`）                                                     | `pending` / `in_progress` / `completed` / `failed` / `cancelled`                                            | 单次调用为 `ToolRow`；连续两次以上聚合为 `WorkCard`（垂直细线串联子行）；左边一列：在跑为转圈、失败为红叉；完成后为类型图标（读=文件、改=铅笔、搜=放大镜、命令=终端、网页=地球、子 agent=小机器人，14px `--cycle-ink-disabled`，悬停 `--cycle-ink-muted`），其他类型和类型混合的工作卡为 5px 灰点（CYCL-130，决定笔记 [`2026-11-23-finished-calls-lead-with-their-kind`](.agents/notes/2026-11-23-finished-calls-lead-with-their-kind.md)）；失败行整行红色并写明 `failed`、默认展开；展开区的命令 / 输出 / 错误各为一块 `Surface/Sunken`，带小标题与 `Copy`                                                                                                                                                              |
| `Plan` & `PlanStrip`     | 自建（`plan.tsx`）                                                                  | `pending` / `in_progress` / `completed`                                                                     | 列表画法见 `PlanList`；对话里是一行 `Plan · 1 of 3 done`（排成工具行，点开是列表）；有未完成项时输入框上方一条 `Surface/Card` 细条 `1/3 + 正在做的那项`，全部完成即消失                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `FormCard`               | 自建（`form.tsx`）                                                                  | `disabled`、必填未填、含画不了的必填字段                                                                    | 与 `PermissionCard` 同位同材质，**顶边 3px 用 `accent`**（是提问，不是警示）；问题：大写淡色小标题 + 加粗问题 + 整行可点的选项（圆点单选 / 方框多选，选中为 accent 边 + 8% 底）+ 一行 `Other`；问题区卡内滚动，`Answer`（`solid`）/ `Skip`（`outline`）/ `Dismiss`（`ghost`）固定在底                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PermissionCard`         | 自建（`permission.tsx`）                                                            | `disabled`                                                                                                  | `Surface/Popover` + 3px 顶部 `attention` 边条；标题 + 可滚动等宽命令区（最多 8 行）+ `Allow once`（`solid`，标出快捷键）+ 其他 `outline` + 最右 `ghost` `Dismiss`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Dialog` / `AlertDialog` | `@ui-sdk/react` + `dialogs.tsx`                                                     | 表单弹窗 / 信息弹窗 / 破坏性确认弹窗                                                                        | `Surface/Dialog` + `--cycle-scrim`；非破坏性支持 Esc 关闭并将焦点还回触发源                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Icons`                  | `icons.tsx`（iconmcp 线性 16 单位网格）                                             | `size` 16（控件内）/ 20（空状态），`1.5px` 描边，`currentColor`                                             | 集中维护，禁止内联 SVG；仅图标按钮必须用 `Tip` 命名（见上）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 第 4 层：设计范式（Patterns）

新增功能或调整页面时，必须优先套用以下最小任务范式，不在局部另起交互逻辑：

### 4.1 窗口与侧栏导航范式

- **窗口尺寸**：默认 `1200×800`，最小 `720×480`。窗口是一个分栏组（`SplitLayout`）：侧栏、对话区（最小 400px），以及打开时的右侧面板（CYCL-89/90）。
- **macOS 标题栏**：`titleBarStyle: "hiddenInset"`，红绿灯位于侧栏左上角；侧栏折叠时主区头部自动留出左侧避让（`5.5rem`）且可拖动。
- **侧栏三段结构**（默认 `256px`，可拖动 `200–360px` 并记忆，`⌘B` 或按钮折叠）：
  - **顶段（固定）**：`New`（`⌘N`）与 `Search`（`⌘K`）`ghost` 行（可访问名称仍是 New session / Search sessions）、`Connectors` 入口、紧贴列表的 `WorkspaceSwitcher` + 环境 `"…"` 菜单；如有断线/重连环境，在此展示两行状态块（状态点+名称+`Retry` / 最多三行原因）。
  - **中段（独立滚动，保底 `10rem`）**：当前选中 workspace 的会话列表，分组顺序固定为 **`Needs you` → `Running` → `Today` → `Yesterday` → `Earlier`**（本地日界线，按 `updatedAt` 排序）；每项目默认展示 20 条（有状态标记或当前打开的永远展示），底部附 `Show N more sessions`（切换 workspace/环境时重置）与 `Show archived`。窗口极矮时改为整栏滚动，确保底部不裁切。
  - **会话行**：左侧状态点（等你、在跑、未读），中间标题（放不下末尾淡出），行尾是会话最后变化的相对时间（`updatedAt`，`session-time.tsx`）：`meta` 字号、淡色、等宽数字，`Intl.RelativeTimeFormat` 按界面语言写（`5m ago` / `5分钟前`，不到一天写小时，一周内写天，再早写日期 `Nov 3` / `11月3日`，跨年带年份）；悬停给完整的本地日期时间（`<time title>`）。全页共用一个每分钟走一次的时钟，只重画时间，不重画列表。旧 daemon 不给 `updatedAt` 时不显示。
  - **底段（固定）**：当前版本号、更新状态、与进入设置页的图标按钮（`Settings`，`⌘,`）。
- **折叠恢复**：展开时 `SidebarIcon` 开关在侧栏顶行右端（与主区头部同高，Mac 上与红绿灯同行），不放进主区；折叠后它出现在主区头部，确保无需快捷键也能用鼠标打开侧栏。按钮与 `⌘B` 折叠/展开时侧栏宽度以 `--cycle-motion-disclosure` 滑动（拖动、窗口缩放时不动）。

### 4.2 会话切换与工作区范式

- **一次一个 workspace**：一个 workspace = `(environmentId, cwd)`。Switcher 按环境分组（本机在前，仅一个环境时不显示分组头），远程环境带 `ServerIcon` 与可访问名称；同名目录在不同环境或同环境多级重名时自动补全前缀/环境名区分。
- **跨区提醒**：Switcher 右侧方块角标显示**其他 workspace** 中最紧急一类的计数（优先级：`needs-you > running > background > unread`），完整分布写入 `aria-label`。
- **断线态**：断线环境的会话列表灰显并附 tooltip 说明原因；已打开过有缓存的会话仍可阅读并编辑草稿（断线横幅提示“重连后恢复”），无法新开未读会话。

### 4.3 新建空白会话与文件夹信任范式

- **先写后建**：点击 `New session` 打开居中的 `BlankConversationView`，直到发出第一条消息才依次调用 `session/new` 与 `session/prompt`，未发出前不污染侧栏。
- **草稿保留**：空白页草稿使用独立持久键（`BLANK_KEY`），切换环境或目录时不丢失已输入文字；若创建 session 失败，消息退回空白框并保留焦点；若 session 已建好但发送失败，打开该 session 并把消息退回该 session 的草稿框。
- **文件夹信任前置**：发出首条消息前，若目标目录未做过信任决定且 daemon 支持 `trust` 能力，阻塞弹出 `Trust this folder?`（展示真实路径与风险说明），提供 `Back` / `Start without trusting` / `Trust and start`。

### 4.4 对话阅读、流式输出与输入范式

- **头部**：固定 `42px` 一行，无底线，左侧会话标题（`13px / 600`，`Open Runde`）+ 等宽路径（路径优先保留末尾项目名），右侧 `"…"` 菜单（`Rename` / `Archive` / `Delete`）。
- **就地重命名**：会话标题不开弹窗，就地变成输入框（`rename-field.tsx`）：点头部标题或菜单 `Rename`，侧栏的行双击或 `F2`（环境不在线的行不行）。打开时全选原标题；`Enter`（先问 `isComposing`，中文输入法确认词时不算）或离开输入框保存，`Esc` 放弃并恢复；空的或没改不发请求。保存后立即显示新标题，等列表跟上；失败时标题恢复原样，原因就地显示（头部在标题后，侧栏在行内标题下），几秒后消失。按键结束时焦点回到标题或行。
- **Turn 切块与对话内容规则（CYCL-14，详见 [docs/conversation-content.md](docs/conversation-content.md)）**：
  - 按 daemon 日志的 `stopReason` 切分 turn（`--cycle-gap-turn` 隔开问题起止）；思考是否显示由会话的展示模式决定（会话设置里的“展示模式”，按会话存在本机，默认“普通”）：普通不显示思考，输出中由 StepLine 写“思考中…”；详细则把思考原文直接显示在发生的位置，按 Markdown 引用的样式（左边线）、斜体、次要文字颜色，走与回复同一条清洗路径；思考框最多 8 行高，超出在框内滚动（不折叠，滚到头后滚轮继续带动对话），有更多内容的那一侧边缘淡出（滚动驱动的遮罩，左边引用线不淡），可滚动时键盘能聚焦，焦点环画在引用框上；写的时候跟着最新内容，读者往上翻了就停在原处（CYCL-132，负责人定）；没有文字的思考（旧会话里 Claude Code 没给思考原文）不显示；思考不打断连续工具流，有文字的思考显示时 StepLine 不再重复写“思考中”；未正常结束的 turn 拎出末尾失败工具并附原因块（`turn-end`）。
  - **工具行不用图标，左列只放状态**：完成为 5px 灰点（`--cycle-ink-disabled`，纯装饰，读屏给状态词），在跑为旋转线，失败为红叉；一段调用展开后细竖线串联各点。
  - **有 `description` 优先展示**：Bash / Monitor / Agent 的单行短说明（≤ 160 字）用正文字体居前，后跟淡灰等宽命令/路径，放不下时先让摘要再让说明并在末尾淡出；没有时用“动词 + 摘要”。StepLine 与进行中卡片同步遵循。
  - **`@` 提及不画两遍**：用户消息中带 `cycle/mention` 的 `resource_link` 当正文中仍含 `@path` 时不重复渲染；其余链接渲染为 `[名字]`。提及的是另一个 session（`cycle://session/`）时，正文里的 `@标题` 画成带对话图标的 `mention-chip`，正文已不含它时也单独画出 chip。
  - **文件工具（Edit / Write / Read / Glob / Grep）**：按 ACP `diff` 与 `_meta["cycle/toolResult"]`（协议 §9）渲染、不硬编码工具名——Edit 仅显示本次调用的增删计数（`+2 −1`，新建为 `Created +N`），展开显示带行号与浅绿/浅红底的 diff（省去首段 `@@`，段间 `⋯`，上限 400 行，不再重复输入 JSON，过大或空文件给出明确提示）；Read 写出行范围/总行数（含读取图片直接展示）；Glob/Grep 写出文件数与匹配数/行数（截断时带 `+`）；输入中仅含行上已显示的字段时展开不再重复。
  - **命令（Bash / Monitor）**：行上只在没照常跑完时多写一句（`interrupted`、`exited with code 2`、`ran past 2 min, now in the background`、`in the background`）；有退出码含义（`returnCodeInterpretation`）时显示模型看到的原文。展开为三块：命令（不再是输入 JSON）、输出、错误（另一块，标题为红；来自 `_meta["cycle/stream"]: "stderr"`），各带 `Copy`（经 main 的 `copyText`，页面无剪贴板权限，失败不显示 `Copied`）。长输出只显示末 40 行，上方 `Show N earlier lines`；超过 20,000 字时保留末尾。
  - **子 agent 挂在它的 Agent 行上**：只在调用本身未结束时转圈（转到后台的之后不转，只写文字：它的结束可能永远不来），写 `in the background · using Grep`；结束写 `done · 4 steps · 1m 3s`，失败为红字。
  - **压缩上下文是一行**（同 notice）：`Compacting the context…` → `Context compacted`。
  - **agent 的 Markdown（CYCL-53，决定笔记 [`2026-11-22-conversation-markdown-rules`](.agents/notes/2026-11-22-conversation-markdown-rules.md)）**：回复的块之间统一 12px（CYCL-125，对齐 old-cycle），块自身不再带外边距；标题落在四档字阶（h1/h2 为 `title`，其余为 `body`，均 600）；行内代码为 `ui` 字号、`--cycle-ink-code` 色、浅底；链接 `--cycle-link` 加浅下划线；代码块正文为 `ui` 字号，有语言时标题栏下一条轻分隔线；表格不画卡片，表头一条圆角色带（`surface-message`），行间 `border-subtle` 细线，过宽时在自身内横向滚动；分隔线为 `border-subtle`；有序、无序列表的标记都悬在文字外侧，任务列表以勾选框代替圆点；引用不用斜体，左侧 2px 线；表格单元格按词换行、最小 6rem，表头不换行；无语言的代码块不画标题栏，Copy 浮在右上角。代码块不设高度上限：超过 30 行且第一次画出来就完整的块只显示前 12 行，末尾淡出，下方是 `Show all N lines`；在屏幕上流着写出来的块保持完整。流式时一条回复不换树（始终 streaming 模式），从开头看着写的回复新字逐字淡入（160ms，积压不超过 200ms，减少动态效果时不淡入，CYCL-126），半截表格和末尾孤立的标记先不显示；跟随底部时，内容晚到的长高也跟着。外部链接点击后先确认，确认框显示完整地址；相对链接只显示文字。
  - **计划**：见第 3 层 `Plan & PlanStrip`；agent 自己的事务（ACP `kind` 为 `think`：改计划的 TodoWrite、TaskCreate、TaskUpdate，SDK 查可用工具的 ToolSearch）不成行，进行中也不，失败的照常；只读计划的（TaskGet、TaskList）照常成行。提出的计划（输入有 `plan`，如 ExitPlanMode）动词为 `Proposed a plan`，展开为 Markdown 正文；提问（输入有 `questions`）动词为 `Asked`，摘要为问题。均按输入的形状判断，不看工具名。
  - **Web、MCP 与其余工具**：WebFetch 写状态码与大小（`404 · 1.5 kB`，4xx/5xx 为红字）；WebSearch 展开为模型的话加结果列表（标题是强调色链接，只放行 http/https/mailto，由主进程交给系统浏览器打开；后跟淡色站点名；长标题换行）。MCP 工具用 agent 给的 `title`（`server · tool`），页面不解析工具名；页面不认识的工具，摘要取输入里第一行短文字（≤ 120 字、单行）。
  - **工具折叠状态保持**：连续工具调用从 1 个变为 2 个以上时保留用户已手动展开的状态；展开态下的长输入/输出与代理消息支持快捷复制。
  - **消息的 Copy**：人发的消息和已结束回合的回复下方各有一个仅图标的 Copy（`Tip` 命名，悬停或焦点在内时显出，`--cycle-motion-state` 淡入；位置始终留着，显隐不挪动内容）。回复的 Copy 只在回合最后一条有文字的 agent 消息下出现一次，复制这一回合 agent 写的全部文字（Markdown 原文，段间空行）；回合进行中不出现。代码块的 Copy 也是我们自己画的、经 main 的 `copyText`（Streamdown 自带的写页面剪贴板，页面没有这个权限）。按下后图标变勾、名字变 `Copied` 约 1.5 秒，读屏同时被告知，不弹 toast。
  - **失败后重新发送（CYCL-48）**：三种失败三种反馈。**turn 失败**（`stopReason: "error"`：API 报错、额度、认证、agent 退出、daemon 停止）在回合尾的红色原因后给两个小按钮，只在最后一个 turn、这一 turn 里有人说过话、之后没有新内容时出现：`Try again`（outline）把这一 turn 的消息（文字、图片、`@` 提及，插话也在内，合成一条）原样作为新的 `session/prompt` 一键发出；`Edit message`（ghost，次要）不直接发，而是把消息放回输入框最前面、输入框取得焦点，由人核对、可改，再像普通消息一样发出。两条路都照常重新询问权限，不沿用之前的批准。`Try again` 在断线或 agent 正在工作时禁用，并在按钮下方用 meta 字号写明原因（`Connect to the environment to try again.` / `The agent is working. Try again once it stops.`），按钮用 `aria-describedby` 指向它；发不出去时消息退回输入框，不丢。这一 turn 里已经开始过会改东西的工具（ACP `kind` 为 `execute`/`edit`/`delete`/`move`，没离开 `pending` 的不算）时，两个按钮都先弹确认说明用过哪些、再发可能再做一遍，焦点在 `Cancel`，主按钮与触发它的按钮同名（`Try again` / `Put the message back`），用 `solid` 而非 `destructive`（再发不是删除）。**工具本身失败**留在工具行。**agent 自己重试请求**（`notice` 带 `_meta["cycle/retry"]`）不成行，只在它是进行中 turn 的最后一项时让 StepLine 写 `The request failed, trying again (2 of 10)…`，turn 有了新内容就消失；不给任何按钮。
  - **提问是表单**：agent 的提问（`AskUserQuestion`、MCP 的 elicitation）以 `FormCard` 出现在权限区；只发回填了的字段（main 再按 schema 的字段过滤）；什么都没填、`required` 字段未填、数字不合 schema（非整数、超出 `minimum`/`maximum`）时 `Send answers` 不可点；一个字段都画不了或必填字段画不了时写明只能跳过。
  - **StepLine**：turn 进行中且未开始输出文本时，在末尾展示实时步骤行（等待批准 / 思考中 / 运行中的工具摘要），防止“静默卡死感”。步骤行的文字防闪烁（CYCL-129，规则取自 old-cycle）：换一个步骤至少等 150ms，正在显示的至少停 650ms，一闪而过的工具不会出现；等待批准和 turn 结束立即生效。计时从页面第一次看到这个步骤算起，按步骤记住，所以行重新画出来时接着计；正在运行的工具行自己也显示计时（满 1 秒才出现）。
  - **消息时间**：用户消息写发送时间，turn 结束时最后一条回复写完成时间（各自日志记录的 `cycle/ts`，协议 §5）。`meta` 字号、muted 色的相对时间（`3 minutes ago` / `3分钟前`，一周后写日期），和 Copy 同在消息下方那一行（用户消息的在 Copy 左边，回复的在右边），随这一行在指针移到这一块上或键盘焦点到它时显出（`--cycle-motion-state`）；回复的时间只在 turn 结束后出现，`Tip` 给完整的本地日期时间。时间未知（旧 daemon）时什么都不画，不拿收到的时刻代替。
- **长会话窗口与滚动锚定**：
  - 初次仅渲染最后 60 块；向上滚动至距顶 `< 800px` 或点击 `Show earlier` 时向上增量加载 60 块，通过首块位移修正保持视口不跳动；页面内存中记住最近 50 个会话的阅读锚点；离末尾超过 240px 时，视口底部（输入框正上方）浮出圆形 `Back to bottom`（向下箭头，`Tip` 命名；sticky、零高度占位，出现与消失都不挪动内容；`--cycle-motion-enter` 淡入）；离开期间末尾来了新内容时右上角加强调色圆点，名字随之说明；点击平滑滚回末尾（减少动效时直接跳），途中又有内容到达则滚动结束后补到真正的末尾，焦点留在对话里。
- **Composer 三段式与排队/插话**：
  - **上方拓展区（`composer-extensions`）**：无内容时不占高度；有内容时作为略内缩的衔接托盘停靠于输入区顶边，每类拓展严格占一行并由细线分隔（活跃 `PlanStrip`、排队消息 `queued`、离线/阻塞状态、拖拽提示、附件报错）。
  - **中间输入区（`composer-box`）**：克制微边（`--cycle-border-default`）+ 顶部硬件高光；聚焦时只把边框向 `--cycle-input-border` 加深一档、托起一点阴影（`--cycle-focus-composer`），不叠光晕、不画外圈线和内描边（CYCL-75：输入框一天里大部分时间都有焦点，焦点只是提示）；高对比模式下用 `--cycle-input-border`，强制色模式下用系统 `Highlight` 轮廓。圆角统一用 `--cycle-radius-composer`（16px）：一行（46px，含边框）和展开后都是同一个圆角矩形，两种状态之间不跳变。默认单行（左 `+` 添加附件[仅声明 `image` 能力时显示]、中 Lexical Markdown 输入框、右侧动作：空闲时一个圆形发送按钮，空态中性柔灰、有内容亮安全橙；运行时 Queue / Send now / Stop 并排在同一行，不因按钮多而变高）；只有输入超出一行、出现换行或添加附件时才展开为三行布局（附件卡片在上、2 行内容区、底部动作栏），且不闪烁回弹。`/` 与 `@` 的候选菜单以整个输入框为宽（不是输入格），长文件名末尾省略，目录提示最多占 40%；`@` 后文件夹里什么都没有时明说。
  - **下方工具区（`composer-tools`）**：框外无边框紧凑一行；左侧放置权限模式芯片（带盾牌图标；完整会话设置收进头部 `"…"` 菜单），右侧放置 Model 芯片、Effort 芯片与 Fluid UI 风格弹性 `ContextMeter` 用量环（欠阻尼弹簧同步弧线与百分比，满额轻膨；它是按钮，点开一个 `Popover`，与模型、权限的菜单同一种 `Surface/Popover`（`context-details.tsx`），像 `/context` 一样直接列数字：总量与比例、分段条、每部分一行（强调色由深到浅的单一色相，压缩预留用墨色，剩余留空），再列自动压缩点、费用与压缩次数，全部 `meta` 字号、等宽数字，不写说明；只有无数据、压缩中、压缩前三种状态写一行字；订阅账号时底部再列 Plan usage（每个限额一行比例与重置时间加细条，平时墨色，快到用注意色，到了用危险色）；压缩后未更新时底圈改虚线、弧线变淡）。
  - **发送与草稿**：文本草稿持久化到 `localStorage`（按环境+会话键隔离），图片、附加的文件与 `@` 链接保持在内存；附加的文本文件和 PDF（agent 声明 `embeddedContext` 时）在输入框里是带文件名、大小和移除按钮的小片，发出后在对话里只是带文件名的小片，内容从不渲染；发送失败或被退回时自动放回输入框前端，不丢内容。
  - **命令与提及**：行首 `/` 触发 agent 命令候选；`@` 触发工作区文件搜索，发送时附带 `resource_link`；daemon 支持时同一菜单另有 Sessions 一组（同一 environment 的其他 session，最近在前），两组时各带小标题。

### 4.5 表单弹窗与破坏性确认范式

- **表单弹窗（添加/编辑环境、添加连接器、Agent 默认设置）**：
  - 必须包裹 `<form onSubmit>`，支持在输入框内按 `Enter` 提交；
  - 打开时自动聚焦首个有效输入字段；
  - 底部操作行右对齐，**取消在左，主确认按钮在右**；提交中禁用按钮并就地展示失败原因。
- **破坏性确认弹窗（删除会话、移除连接器、移除远端环境、升级应用/Daemon 中断提示）**：
  - 必须经由 `AlertDialog` 确认；
  - 不可逆删除/移除操作的主确认按钮必须使用 `destructive` 语义样式（禁止使用 `solid` 强调色主按钮），且按钮文案采用“动词 + 对象”（如 `Delete session`、`Remove environment`）；
  - 打开时默认焦点落在 `Cancel` 上，防止连续两次回车误删。

### 4.6 空、加载、断线与错误反馈范式

- 每一块界面必须完整覆盖 **空、加载、出错、断线/重连、超长内容、超多数量** 六态。
- **错误三要素**：发生了什么 + 原样等宽可选择的系统/远端原因 + 下一步操作按钮（`Connect again` / `Try again` / 编辑配置 / 重读）。用 `StateBlock`，不再手搭。错误发生就地展示，不依赖会自动消失的 toast。
- **空状态有出口**：任何空状态（无会话、无环境、无可用 agent）都不能只有一句静态描述，必须写明原因/下一步并就地提供直接动作按钮（如 `New session` 或连接/排查指引）。

### 4.7 整窗页面范式（设置页，CYCL-56）

- **什么时候用**：属于应用、不属于某个会话的一组设置或管理界面（Settings，之后的 Connectors）。单个对象的增改仍用表单弹窗（§4.5），开在页面上面。
- **版式**（`PageLayout`）：页面占整个窗口。原侧栏的位置、同一 `surface-sidebar` 底色、固定 `16rem` 宽：顶部一行 `Back to sessions`（行尾写 `Esc`），其下是页名（`meta` 淡色）和分区导航；分区是侧栏行的样子（28px 高，选中为 `surface-selected`）。右侧是分区内容，与对话同一条居中列宽（`--cycle-measure`），列首是分区名（`title` 字阶，42px 高，与会话头部对齐，macOS 上可拖动窗口）。
- **分区内容**：`PageGroup`（可选的小标题、一行说明、右上至多一个作用于整组的 `outline` 动作）里放 `PageRows`（一张 `Surface/Card`，行间细线）；每行 `PageRow` 左边是名字和一行 `meta` 说明，右边是控件（开关、选择器、按钮、行尾菜单），系统原话单独一块等宽放在行下。需要整块表单时用 `page-form`（最宽 `24rem`）。即时生效的设置用开关或选择器，不放保存按钮；要一起提交的表单才有一个 `solid` 的保存，成功后在按钮旁写一个词。
- **只读清单**：快捷键分区是行的列表，行尾是按键帽（`Surface/Sunken`，`meta` 字号，一键一帽），没有可操作的控件。
- **进出**：`⌘,` 或侧栏底部按钮进入，焦点落在当前分区的导航项上；`Esc`、返回行或再按 `⌘,` 离开，焦点回到打开它的按钮。页面上面开着弹窗或菜单时 `Esc` 只关它们。会话在页面下保持原样，不重新加载。再次进入回到上次的分区。
- **状态**：全局错误条在页面顶部同样显示；分区自己的空、加载、出错、断线用 `StateBlock`（`inline`，靠左）。

### 4.8 命令面板与全局搜索范式

- `⌘K` 打开跨环境、跨 workspace 的会话搜索（匹配标题、文件夹、agent、环境名，含已归档会话），底部附新建会话快捷入口；全文内容搜索预留在 daemon 侧扩展。

---

## 第 5 层：语义决策体系（Decision Trees & Do / Don't）

### 5.1 什么时候用什么组件 / 反馈层？

```text
需要打断用户或获得明确授权？
├─ 是，且为不可逆破坏或中断正在运行的任务 ──▶ AlertDialog（ConfirmDialog，destructive 主按钮，焦点落 Cancel）
├─ 是，agent 等待单次/永久工具权限批准   ──▶ PermissionCard（吸附在输入框上方，不遮挡最近对话）
├─ 是，agent 提出问题要人回答（表单）     ──▶ FormCard（同一位置，accent 顶边，可 Skip）
└─ 否，不阻断当前编辑：
   ├─ 属于全局/环境/应用级状态（断线、更新、版本过旧、全局错误） ──▶ 顶部 Banner（带左竖条，不自动消失）
   ├─ 属于某个输入或列表项的校验/执行失败（附件超限、连接器报错） ──▶ 就地 inline alert / hint
   └─ 属于用户未注视的后台会话状态变化（Needs you / 完成 / 异常退出） ──▶ 系统桌面通知 + 侧栏/Switcher 角标
```

### 5.2 截断与溢出策略（区分文本语义）

| 内容类型                                              | 策略                                                                                         | 理由                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **会话标题、环境名、连接器名、工具动词摘要**          | 单行，超长时末尾渐隐（`--cycle-fade-end`）+ `title` 悬停全称                                 | 最具辨识度的字词在开头                                         |
| **文件路径（头部 `session-where`、连接器地址/命令）** | 优先保留尾部目录/文件名（中间省略或左端截断）+ `title` 悬停完整路径                          | 路径最有区别度的仓库名和文件名在末尾，末尾淡出反而抹掉关键信息 |
| **代码块、表格、命令输入输出、错误原话**              | 代码块/表格独立横向滚动；错误原话与路径 `overflow-wrap: anywhere` 换行且 `user-select: text` | 绝不撑破 48rem 内容列或触发根页面横向滚动                      |

### 5.3 动作权重 Do / Don't

- **Do**：主工作区同一视图内至多保留一个 `solid` 主操作（`Send` 或 `Allow once`）；次要按钮用 `outline`；工具栏、行内、导航类用 `ghost`。
- **Do**：空状态允许提供一个明确的引导按钮（`outline` 或轻量主动作），让用户就地开始，而不必四处找入口。
- **Do**：模态确认弹窗的取消在左、主动作在右；不可逆删除用 `destructive`，常规确认/保存用 `solid`。
- **Don't**：不要把危险设置（如免确认权限模式）画成毫无区别的普通灰字；必须有明确的警示色标记。
- **Don't**：不要隐藏设置芯片的所有交互线索；保持无边框的安静感的同时，保留轻量悬停底色或极淡下拉指示。

### 5.4 键盘与焦点规范（Do / Don't）

| 按键                               | 动作与适用范围                                                                                                            | 边界条件                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `⌘N` / `Ctrl+N`                    | 打开空白新会话                                                                                                            | 至少有一个已连接环境时可用                                                                                         |
| `⌘K` / `Ctrl+K`                    | 打开跨环境会话搜索                                                                                                        | 全局可用                                                                                                           |
| `⌘,` / `Ctrl+,`                    | 打开/关闭设置页                                                                                                           | 全局可用；有模态对话框时让位；设置页打开时其余全局快捷键里只有 `⌘N`、`⌘K` 生效                                     |
| `⌘B` / `Ctrl+B`                    | 展开/折叠侧栏                                                                                                             | 全局可用（主区头部同步提供可点击图标按钮）                                                                         |
| `⌘\` / `Ctrl+\`                    | 打开/关闭当前会话的右侧面板                                                                                               | 有打开的会话时可用（会话头部右侧同步提供图标按钮）；有模态对话框时让位                                             |
| `⌘L` / `Ctrl+L`                    | 聚焦主输入框                                                                                                              | 当前有打开会话或空白会话时可用                                                                                     |
| `⌘[` / `⌘]`                        | 上一个 / 下一个会话                                                                                                       | 严格按侧栏可见列表顺序，自动跳过断线且未加载的会话                                                                 |
| `⌘.` / `Ctrl+.`                    | 停止当前正在运行的回合                                                                                                    | 仅当前环境已连接且 `activity !== "idle"` 时                                                                        |
| `⌘Return`                          | 批准当前第一张权限卡的 `Allow once`                                                                                       | **即使焦点在输入框中也应生效**（输入框不使用 `⌘Return` 发送/换行），仅在存在模态对话框时让位                       |
| `Enter` / `⌘Enter` / `Shift+Enter` | 发送（运行中可插话时插话，否则排队） / 运行中排队、空闲时发送（权限待答时归权限卡的 Allow once） / 换行（`Alt+Enter` 同） | **必须先检查 `@ui-sdk/core` 的 `isComposing(event)`**，禁止用原生 `event.isComposing`，确保中文 IME 选词回车不误发 |
| `Esc`                              | 逐层关闭：候选菜单 → 模态对话框（焦点归还触发处）→ 设置页                                                                 | 在纯输入状态且无弹窗/菜单时不清空草稿                                                                              |
| `↑` / `↓`                          | 光标在首/末块时召回历史发送消息；候选菜单打开时切换候选项                                                                 | 候选菜单优先消费上下键                                                                                             |

---

## 附录 A：状态画廊（Visual Regression）

```bash
bun packages/ui/gallery/shoot.ts                                  # 所有场景，浅色和深色，1200x800 和 720x480
bun packages/ui/gallery/shoot.ts permission --themes dark         # 指定场景和主题
bun packages/ui/gallery/shoot.ts --sizes 1200x800,720x480 --all   # 指定尺寸，列出每张
```

画廊在无界面的 Chromium 中运行（Playwright，每张图一个新的浏览器上下文，2 倍像素，不开窗口、不抢焦点），检查根页面溢出、控制台错误、焦点环、列表首项可见性与输入框边界对比度。在浏览器中预览：`bun packages/ui/gallery/build.ts`，再 `bun scripts/serve-dir.ts packages/ui/gallery/dist`，打开它给出的地址（加 `?s=<场景>` 或 `?s=tokens`）；直接打开文件不行，模块脚本不从 file:// 加载。

核心场景（定义在 `packages/ui/gallery/scenarios.ts`）：`tokens`、`empty`、`empty-conversation`、`conversation`、`streaming`、`permission`、`permission-queue`、`turn-error`、`turn-error-changed`、`turn-error-resent`、`turn-retrying`、`parallel`、`reconnected`、`history-0.3.4`（CYCL-50 的对照样例：并行调用、断线续接、旧历史回放）、`host-down`、`host-reconnecting`、`session-reconnecting`、`many-sessions`、`update-available`、`update-failed`、`daemon-old`、`new-session`、`dialog-add-host`、`dialog-agent-defaults`、`long`、`long-back`、`session-focus`、`turns`、`files`（文件工具的 diff 与计数）、`work`（命令输出与错误、子 agent、压缩、计划条）、`ask`（提问表单）、`web`（搜索结果链接、抓取失败、MCP 与未知工具）、`markdown` / `markdown-top` / `markdown-stream` / `markdown-streaming` / `markdown-link`（CYCL-53 的对照样例：长回答的版式与折叠、逐批流式时视图停在底部且块不重画、链接确认）等。

## 附录 B：代码配色（Shiki）

代码块由 `@streamdown/code`（Shiki JS 正则引擎，无需 WASM，CSP 不变）按需分包高亮。用户在设置页 `Appearance → Code colours` 中选择（即时生效，下方示例代码随之变化）：

| 选择                 | 浅色 / 深色主题                                            | 最低文字对比度（浅 / 深） | 低于 4.5:1 的文字色个数（浅 / 深） |
| -------------------- | ---------------------------------------------------------- | ------------------------- | ---------------------------------- |
| GitHub（默认）       | `github-light-default` / `github-dark-default`             | 4.55 / 6.44               | 0 / 0                              |
| GitHub high contrast | `github-light-high-contrast` / `github-dark-high-contrast` | 5.04 / 9.34               | 0 / 0                              |
| VS Code              | `light-plus` / `dark-plus`                                 | 3.54 / 3.65               | 1 / 1                              |
| One                  | `one-light` / `one-dark-pro`                               | 2.58 / 3.27               | 6 / 2                              |
| Catppuccin           | `catppuccin-latte` / `catppuccin-mocha`                    | 2.62 / 7.01               | 12 / 0                             |

默认两套主题全部文字色均通过 WCAG AA（4.5:1）。

## 附录 C：语言、文案与 i18n（decision 0012）

- **语言**：界面有 English 和简体中文（CYCL-79），在设置页 General 里选，默认跟随系统；每种语言用它自己的名字列出。中文目录是 `packages/ui/src/messages/zh-CN.ts`，键与 en-US 相同（类型检查缺漏），缺的键回退到 en-US。中文文案同样写事实、不用感叹号和空话；`agent`、`Cycle`、`MCP`、`OAuth`、`ssh` 和按键名不译。
- **源语言为 `en-US`**（句首大写，其余小写，不用 Title Case、感叹号、emoji、破折号或空话），新界面文字全部写入 `packages/ui/src/messages/en-US.ts`，组件使用 `t("key")`；门禁棘轮 `scan-copy.mjs --i18n` 只减不增。
- **整句与复数**：变化参数用 `{placeholder}`，数量用复数消息，数字/日期/单位用 `Intl`（`t.number` / `t.date`）。
- **术语统一**：统一用 `environment`（不用 `host`）、`session`、`agent`、`turn`、`permission`。
- **不翻译的数据**：agent 输出、daemon/ssh 错误原话、命令、路径、版本号。
- **版式弹性**：预留约 40% 的翻译变长空间；将来支持 RTL 时需把 `padding-left` 等迁为逻辑属性（`padding-inline-start`）。

## 附录 D：桌面端通知规则

- 窗口不在前台时，主进程在每次读取会话列表后通过纯函数 `attentionOf(之前, 现在)` 对状态差发系统通知：_Waiting for your answer_（`requires_action`）、_Waiting for your next message_（从运行/等待变为 idle，或首次出现的未读已完成会话）、_The agent stopped unexpectedly_（运行/等待变为 stopped，静默释放的空闲会话不报）。
- 断线重连后只报 `requires_action`，不误报历史完成或释放。点击通知激活应用并聚焦对应会话；若环境已断开或会话已删除则静默忽略。

## 附录 E：当前实现状态与已知待办（单一追踪清单）

以下为当前设计规范已明确、但代码尚待补齐或真机尚未验证的项目（按 P0–P3 分级追踪）：

### P0：代码缺陷与关键防呆修复

- [x] **中文 IME 与 `@` 提及替换修复**：`markdown-input.tsx` 改用 `@ui-sdk/core` 的 `isComposing(event)`，并修复 `replaceBeforeCaret` 在非 TextNode 边界时的替换行为。
- [x] **全局 `⌘Return` 批准权限**：去掉 `app.tsx` 中 `⌘Return` 的 `typing === null` 限制（仅模态弹窗开启时让位），并在 `Allow once` 按钮展示 `⌘↩` 提示。
- [x] **macOS 折叠侧栏红绿灯避让与恢复按钮**：为折叠态下的主区顶部横幅与空状态补齐红绿灯避让空间，并在主区头部接入 `SidebarIcon` 恢复/折叠入口。
- [x] **弹窗提交失败防丢 & ID 碰撞修复**：`saveEnvironment` / `renameSession` 失败时保留弹窗并就地展示原因（不关闭清空）；修复 `EnvironmentDialog` `id` 碰撞；`ConfirmDialog` 异步动作等待期间禁用防重；显式补齐 `connectors.tsx` 表单内非提交按钮的 `type="button"`。
- [x] **Hooks 依赖与渲染性能修复**：补齐 `app.tsx` 键盘监听 `useEffect` 依赖、优化 `conversation.tsx` 滚底触发、`SearchDialog` 关闭时跳过全量分组计算；修复 `composer.tsx` 拖放子元素触发 `dragleave` 闪烁并提示不支持的非图片文件。
- [x] **Banner 与 KeyHints 窄屏修复**：`app.tsx` 警告横幅文本包入 `<span>`；`key-hints` 在窄屏下避免折行后第二行被 `overflow: hidden` 腰斩。

### P1：落实第 3–5 层核心体验规范

- [x] **破坏性与表单弹窗规范化**：`ConfirmDialog` 破坏性操作改用 `destructive` 按钮变体；移除远端环境增加二次确认并补充编辑远端环境能力；`EnvironmentDialog` / `RenameDialog` 包裹 `<form>` 支持回车提交、打开自动聚焦首项、所有弹窗底部按钮统一右对齐（取消在左、主动作在右）。
- [x] **空状态与无 Agent 引导**：主区空状态提供就地引导按钮；无可用 agent 时说明可能原因（凭证/安装）并给出排查与重检按钮。
- [x] **第 3 层基础组件与材质/动效收口**：补充 `UpdateBanner` 临时关闭、`Button[data-variant="destructive"]` 约定；将 `--cycle-motion-enter`（200ms）实际接入弹窗/浮层/横幅出现过渡，清理死 CSS `[data-slot="session-main"]`。（注：`Banner` / `EmptyBlock` 抽取与功能色柔化令牌统一可在后续重构中继续收口。）
- [x] **路径截断与危险设置芯片**：路径类文本（头部 `session-where`、连接器路径）改为优先保留尾部的截断方式；`SettingChips` 补充轻量下拉线索与免确认模式的警示色（协议 `_meta["cycle/danger"]`）。

### P2：对话流与日常工作流质感打磨

- [ ] **对话内高频操作**：空白会话转正式会话时平滑衔接。
- [ ] **工具调用与侧栏辨识度**：连续工具从 1 个升格为多个时保留手动展开态；会话行补充未发送草稿标（相对时间已做，见 §4.1）；切换 workspace/环境时重置 `showAll`。
- [ ] **窄视口与缓存治理**：720×480 下 `composer-toolbar` 折行/紧凑适配；为 `store.views` 增加 LRU 上限，为 `selectSession` 加并发加载保护。
- [x] **存量 i18n 迁移**：JSX、对话框、更新提示、连接状态词和 store 的报错都已迁入 `packages/ui/src/messages/en-US.ts`（CYCL-68）。

### P3：跨层能力与真机未验证项

- [ ] **macOS 真机验收**：`hiddenInset` 红绿灯与拖动区域、自定义原生应用菜单与系统快捷键冲突、系统通知与点击唤起（需签名）、中文输入法实测、SF 字体实际行高与长会话帧率。
- [ ] **协议/后端协同项**：利用 `config_option_update` 补齐 agent 主动改设置的 UI 回显、工具执行耗时计时（需 daemon 记录开始时间）、会话内容全文搜索（daemon 侧）、多窗口与 VoiceOver 完整审查。
