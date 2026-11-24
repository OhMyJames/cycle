---
name: cycle-design-taste
description: >-
  Cycle 自己的界面品味。做、改、评审 Cycle 的界面(packages/ui、apps/desktop 的渲染进程)时使用:布局、间距、颜色、
  文案、空/加载/错误/断线状态、动效、图标、键盘与焦点、深浅色。也在用户说界面"通用""像 AI 做的""不好用""不顺手"时使用。
  它规定这个应用怎样看起来、读起来、动起来;ui-sdk 怎么用,看 ui-sdk skill。
---

# Cycle 的界面品味

Cycle 是一个人每天开几个小时的工具:盯着 agent 干活、批准它的操作、回看它做了什么。所以界面的标准是
**安静、清楚、密度合适、键盘能走完**,不是"好看的页面"。这里没有首屏、没有营销区块、没有装饰。

一句话的判断标准:用户的注意力应该在 agent 在做什么上,界面本身不该被注意到,除非它出了问题,那时它要立刻说清楚
出了什么问题、该做什么。

> 这份 skill 负责**怎么写和怎么审**;Cycle 的五层设计系统定义在根目录 `DESIGN.md`(1. 色彩体系 → 2. 样式与材质体系 → 3. 组件体系 → 4. 设计范式 → 5. 语义决策体系)。
> 检查流程参考了 [Hallmark 的 app scope](https://github.com/Nutlope/hallmark/blob/04977e15f3dfd6ee4b74c887dac3eb52665d6c92/skills/hallmark/references/flow.md#L49-L65) 和改版前后核对的方法。设计系统本身以 `DESIGN.md` 为准。

## 开始之前

1. 读根目录 `DESIGN.md`:确认第 1–2 层的令牌与材质、第 3 层已有的组件与变体、第 4 层对应任务的设计范式、第 5 层的语义决策树与 Do/Don't;
   再读 `packages/ui/AGENTS.md`、`docs/desktop.md` 的界面部分,以及 ui-sdk skill(`packages/ui/.claude/skills/ui-sdk`)。
2. 读 `packages/ui/src/styles/`(`app.css` 按顺序导入各领域的分片):现有的 `data-slot` / `data-kind`、材质与令牌就是这个系统,新东西接在它后面,不另起一套。
3. 动手前用三行写清:**谁在什么时候用这块**(例如"agent 在等批准,用户从别的窗口切回来");**它有哪些状态**(`references/states.md`);**套用 `DESIGN.md` 第 4 层的哪个范式、为什么这样动**(没有理由就不动)。

## 硬规则

这十条压过其余所有内容。

1. **只用第 1–2 层的令牌与材质。** 只引用 `DESIGN.md` 的 `--cycle-*` 和重映射后的 `--ui-*`(门禁检查 `DESIGN.md` 与样式里的 `--cycle-*` 一致:增删令牌必须两边同步)。容器必须归属 `DESIGN.md` §2.4 的预设材质之一(卡片/浮层统一叠 `--cycle-edge-hardware` 硬件微高光,主输入框用只有顶部微光的 `--cycle-edge-composer`);输入控件的边用 `--cycle-input-border`(≥ 3:1),不用 `--cycle-border-default`(仅做轻分隔)。圆角六档圆润同心,间距取 `4px` 倍数。不写散落十六进制色、不加新色相、不加冗余渐变/大面积毛玻璃/霓虹发光装饰。全部用 `light-dark()` 跟随系统深浅色。
2. **一个排版与尺度系统。** 根字号 16px,只使用 `DESIGN.md` §2.1 的四档字阶(`meta`/`ui`/`body`/`title`,另有一档 `display` 只给新会话页的引导语)和三档字重(`--cycle-weight`/500/600);使用本地打包的 Rare UI 三字体(`Open Runde` 展示与交互触点、`Inter Variable` 正文与密集信息、`Geist Mono Variable` 代码/命令/路径/id/系统错误原话),零外网请求。不新增字号、不新增圆角值、不新增间距值。
3. **复用第 3 层组件与第 4 层范式,样式写在 `packages/ui/src/styles/` 对应领域的分片里。** 优先复用 `ui-sdk` 原语加 `DESIGN.md` 第 3 层约定的变体与公共件(`Menu`、`Popover`、`Tip`)(`solid`/`destructive`/`outline`/`ghost`/`round`/`queue`)及 `Banner`/`ConfirmDialog` 等基础件,不自行重复造一套弹窗或通知条。常规业务组件样式收口在样式分片里,不写行内样式;Tailwind `@theme inline` 语义类服务 Streamdown 与按规范接入的 Rare UI 兼容组件。ui-sdk 的 `Collapsible`、`Command` 等会覆盖 `data-slot`,给它们写样式用 `data-kind` 或 `data-palette`。
4. **状态要齐。** 每块界面都要覆盖:空、加载、出错、断线、内容很长、数量很多(`references/states.md`)。出错时写清三件事:发生了什么、等宽可选的系统原话、下一步行动按钮;空状态必须给出出口(如就地的 `New session` 或排查引导),不能只丢一句话。
5. **文案平实与 i18n。** 按钮是动词加对象("Allow once"、"Delete session");不用感叹号、表情、空话、破折号;统一用 `location`(界面标题 "Work in",不用 `host`;`environment` 留给准备配置)。源语言是 `en-US`,界面文字进 `packages/ui/src/messages/en-US.ts`,组件用 `t("key")`(`references/copy.md`)。
6. **动效只为说明变化。** 三档时长:状态 `100ms`、展开 `160ms`、出现 `200ms`(`--cycle-motion-*`),只动 `transform` 和 `opacity`,曲线 `--cycle-ease`,不弹跳;流式文字不让布局跳;`prefers-reduced-motion` 下全部静止(`references/motion.md`)。
7. **图标一套。** 用 iconmcp 线性图标(16 单位网格,集中放在 `packages/ui/src/react/icons.tsx`),`currentColor`,不画仿品;仅图标的按钮用 `Tip` 命名,它同时是提示和读屏名字(`references/icons.md`)。
8. **键盘、IME 与表单规范。** 每个动作都能不用鼠标完成;焦点环统一 `1.5px solid var(--cycle-focus-ring)`(输入控件贴边叠 `--cycle-focus-halo`,禁用 ui-sdk 默认 `--ui-ring`)。处理 Enter 必须调用 `@ui-sdk/core` 的 `isComposing(event)` 防止中文输入法误发。表单弹窗必须用 `<form>` 支持回车提交并自动聚焦首项;破坏性确认主按钮必须用 `destructive` 变体且默认焦点落 `Cancel`。
9. **对齐、截断与权重决策(见 `DESIGN.md` 第 5 层)。** 主工作区同一视图至多一个 `solid` 主动作;不可逆删除用 `destructive`。长标题/名称末尾淡出(`--cycle-fade-end`),长路径优先保留尾部信息,代码块/表格独立横向滚动。设置控件保留轻量交互线索,危险模式(如免确认)明确警示。
10. **不信任内容,也不假装有内容。** agent 输出不可信(`docs/desktop.md`),渲染必须走安全清洗路径(禁用原始 HTML 与外链图片加载);不放假头像、假数据、占位统计或营销话术。

## 怎么做

1. **读。** 对照 `DESIGN.md` 1–5 层与 `references/states.md`,确认要复用哪个组件变体和设计范式。
2. **先写文案。** 列出这块界面会出现的每一个字(标题、按钮、空状态、错误、确认),按 `references/copy.md` 过一遍并写入 `en-US.ts`,再写代码。
3. **做。** 在 `packages/ui/src/react` 里写组件,样式加进对应领域的分片(侧栏 `sidebar.css`、对话 `conversation.css`、输入框 `composer.css` 等)。先用最坏数据(200 字符标题、长无空格路径、断线、800 个会话)调对布局,再调正常状态。
4. **查。** 按 [验收指南](references/check.md) 跑门禁、文案扫描、状态画廊与真实窗口检查。改变现有交互或布局时,用相同状态、尺寸和主题对照前后。
5. **报告。** 区分影响操作的缺陷和体验打磨,给出复现状态、证据和改动结果,说明实际覆盖范围和剩余缺口。

## 清单

- 所有颜色与材质来自 `DESIGN.md` 第 1–2 层令牌;深浅色都看过。
- 没有新增散落字号、圆角、间距、行内样式或未走 `@theme inline` 语义令牌的 Tailwind 裸色值类。
- 复用了第 3 层变体与第 4 层范式(表单回车/首项聚焦、破坏性 `destructive` 确认、空状态出口、折叠恢复入口)。
- 六种状态(空、加载、出错、断线、长内容、多内容)齐全且布局不溢出。
- 按钮为"动词加对象",术语一致(`location` / "Work in"),`scan-copy.mjs` 与 i18n 棘轮通过。
- 仅图标按钮有名字;键盘从头走到尾;中文 IME `isComposing` 正确;焦点环不被裁掉。
- 动效不超过 200ms、尊重 reduced motion;流式输出时页面不跳。
- agent 输出经过已有的清洗路径;没有新加载外部资源。
- 眼睛看一遍:这块界面像是同一个人做的吗?
