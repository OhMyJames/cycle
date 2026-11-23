# Agent Note: 会话里 agent 的 Markdown 怎么画、怎么流、链接怎么开

Status: accepted
Date: 2026-11-22
Basis: CYCL-53(及子任务 CYCL-69/70/71)，2026-11-22 会话；对照 old-cycle(`OhMyJames/old-cycle`,本地 `cycle_v2`)的 `packages/ui/src/content/markdown.tsx`、`stream-mend.ts`、`styles.css` 的 `.cycle-markdown`、`.agents/notes/2026-11-08-mermaid-svg-in-the-page.md`,以及提交 acd38e37、bf5ef1ae、33da7ee8、b03c8f31、914788c1 的说明。

## Problem

agent 的回复用 Streamdown 2.8 加 Shiki 画。高亮、复制、HTML 与链接的过滤早就有了，但在画廊里实测(`markdown*` 场景)还有几处会让人读着难受，或者看着跳:

- 一条回复流完的那一刻,`mode` 从 `streaming` 换成 `static`,Streamdown 换了一棵树：整条回复重新挂载，每个代码块重新上色，所以会闪一下。
- 已经完成的代码块被 Streamdown 默认的 `codeBlockMaxHeight: 400` 截住，在对话的滚动里面又套了一层滚动。流式时没有这个上限，所以流完的时候块会突然变矮约 580px。表格也有 `tableMaxHeight: 300`。
- 打开会话后，跟随底部只在 blocks 变化时执行一次。之后高亮加载完、代码块(Streamdown 给它设了 `content-visibility: auto`)量出真实高度，内容又长高了，于是停在离底部 232px 的地方。
- 半截表格在流式时把 `|` 和 `---` 原样露出来。末尾孤零零的 `**` 也会闪一下。
- 版式问题：标题用的是 Streamdown 的 30/24/20px,不在 DESIGN.md 的四档字阶里。有序列表的编号在列表里面，无序列表的圆点在外面，两种对不齐。任务列表同时画了圆点和勾选框。引用是斜体。表格单元格继承了消息的 `overflow-wrap: anywhere`,被挤成 "mid- / turn"。没有语言的代码块留着一个空的标题栏。相对链接后面拼了 " [blocked]"。
- 外部链接点一下就直接打开。链接的文字和实际地址可以不一样，而这些文字是 agent 写的。

## Decision

从 old-cycle 只取规则和理由，没有搬它的实现。具体规则:

1. **始终用 Streamdown 的 streaming 模式。** 结束不结束只决定 `isAnimating` 和 `parseIncompleteMarkdown`,不换树。流完之后，同一个代码块和标题还是原来的 DOM 节点。DOM 测试和画廊 `markdown-stream` 对此都有断言。
2. **流式时只补末尾**(`packages/ui/src/markdown-mend.ts`,规则出自 old-cycle 的 `stream-mend.ts`):表格的表头行要等分隔行开始写了才显示，写到一半的分隔行补成完整的一行;末尾没有后续文字的 `**`、`` ` ``、`~~`、`_` 先不显示。在未闭合的代码围栏里一概不动，已经结束的回复也不动。
3. **代码块没有高度上限，长块由我们自己折叠。** 超过 `FOLD_OVER`(30)行的块，如果第一次画出来时就是完整的(重读历史、打开会话),先显示前 `FOLD_TO`(12)行，末尾淡出，下面放 `Show all N lines`。只要所在的回复还在写，块就不折叠(哪怕它是一批里整块到达的，或者会话重开后重新挂载的);在屏幕上流着写出来的块一直保持完整，只提供 `Show fewer lines`。这样一条回复的结尾不会在读者眼前缩回去。Copy 永远复制整块。old-cycle 从来不折叠(`max-height: none`),我们因为 CYCL-53 要求做了折叠，但守住它"不跳"的前提。
4. **跟随底部时，内容长高也继续跟。** 对话里每个子块挂 ResizeObserver,只在读者已经在底部时把视图拉回底部。读者自己按了对话里的控件(展开代码块、展开工具)之后 600ms 内的长高算读者的，视图不动，等读者自己回到底部再继续跟随。observer 整个视图只建一个，新增和移除的块用 MutationObserver 跟进。往上读的时候一律不动(old-cycle 914788c1 用同一个思路处理"上方的 Markdown 渲染完成")。
5. **版式**:标题用四档字阶(h1/h2 为 title,其余为 body,统一字重 600)。两种列表的编号和圆点都悬在文字外侧，嵌套列表收紧。任务列表用勾选框代替圆点。引用不用斜体，左边一条 2px 线(old-cycle 同样)。表格单元格按词换行、`text-wrap: pretty`、最小宽度 6rem,表头不换行，单元格里的长路径可以在任意处断开。没有语言的代码块不画标题栏,Copy 浮在右上角(old-cycle 33da7ee8)。
6. **链接**:仍然只有 http、https、mailto 是链接(页面检查一次,main 的 `setWindowOpenHandler` 再检查一次)。点击、中键点击都先弹出 `ConfirmDialog`,显示完整地址，确认后才由 main 交给系统浏览器或邮件程序(main 的白名单同样是 http、https、mailto;此前 main 只认 http(s),mailto 链接点了没有反应)。拖选链接文字不算点击。消息里的链接和网页搜索结果的链接用同一个 `AgentLink`。相对链接只显示文字，不加 "[blocked]"。
7. **数学公式和 Mermaid 不做。** old-cycle 也没做数学;Mermaid 它做了，但需要一整套 SVG 白名单清洗和懒加载。我们的回复里很少出现，先不引入。

## Alternatives considered

- **保留 `static` 模式，只在完成后重新高亮时做淡入**:闪烁的根源是整棵树换掉，淡入只能把闪烁拉长，所以放弃。
- **保留 Streamdown 的 400px 内滚动作为"折叠"**:那是在滚动里再套滚动，滚轮会被卡在代码块里，而且流完时会突然变矮，所以放弃。
- **流完以后再把长块折叠起来**:会让读者正在看的结尾缩回去，正好违反"不跳",所以放弃。
- **用 Streamdown 自带的 `linkSafety` 弹窗**:它有自己的 Tailwind 样式，用的不是我们的 `ConfirmDialog`,焦点、按钮变体和文案都对不上，所以放弃。
- **按 old-cycle 后来的做法，在内置 Browser 面板里打开网页**:Browser 面板属于 CYCL-100,还没有做。等它落地后再决定是否改成在面板里打开。

## Consequences

- 已经结束的回复也会经过 streaming 模式的分块。结尾若有未闭合的标记，会原样显示，不会被补全。
- 每次点外部链接都要多点一次确认。还没有"不再询问"或 Shift 跳过，等使用数据(`message_link_opened`、`tool_link_opened`)出来再看。
- 埋点新增 `message_link_opened`、`code_block_expanded`,都不带内容。
- 不适用于我们的 old-cycle 规则：它只给"挂载时 ≤200 字"的回复做淡入(`FIRST_BATCH`)、在回放完成前显示占位，以及 `turnAnchor="bottom"`。这些都是因为 agent 每次都从头重放历史。我们的 daemon 自己存 JSONL,快照一次给全，不需要这些。
- 文件路径链接跳到 Files 面板的事随 CYCL-92 做，这里只保证它们不再显示 "[blocked]"。
- 验收样例在 `packages/ui/test/markdown-samples.ts`,DOM 测试(`markdown.dom.tsx`)和画廊(`markdown`、`markdown-top`、`markdown-stream`、`markdown-streaming`、`markdown-link`)都用它。`markdown` 和 `markdown-stream` 在真实 Electron 里断言：视图停在底部，块不重画，颜色不掉。

## Related

- 第 7 条里 Mermaid 的部分已由 [Mermaid 以图片显示](2026-11-22-mermaid-diagrams-as-images.md) 取代(2026-11-22);数学公式仍不做。
- "不适用"里的逐字淡入后来改为采用，理由不同，见 [流式回复逐字淡入](2026-11-22-streaming-reply-fades-in.md)。
