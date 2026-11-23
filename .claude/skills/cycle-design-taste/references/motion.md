# 动效

Cycle 里的动效只做一件事:让一个变化被看见。没有理由的动效删掉。内容在不动的时候也必须是完整的。

## 实际采用的动效

| 什么 | 怎么动 | 令牌与时长 |
|---|---|---|
| 按钮、可点行、操作浮现 | 底色或透明度过渡(如代码块 Copy、工具展开箭头) | `--cycle-motion-state` (100ms) |
| 焦点环 | 不做过渡,焦点环直接出现 | 0 |
| 展开收起 | 展开箭头旋转与面板状态切换 | `--cycle-motion-disclosure` (160ms) |
| 对话框、菜单、横幅 | 出现时轻量淡入(内容不变位时不额外抖动) | `--cycle-motion-enter` (200ms) |
| "Working" 的状态点 | 缓慢脉动 | 循环 1.6s linear / ease-in-out |
| 新消息和流式文字 | 文字直接追加,不做逐字动画;仅在用户在底部时跟随滚动 | 无 |
| 列表增删 | 不做动画 | 无 |
| 侧栏收起/展开(按钮、⌘B) | 侧栏宽度滑动;拖动与窗口缩放时不动。唯一允许动宽度的地方:只动 transform 时对话区会一下跳宽,看不出侧栏去了哪 | `--cycle-motion-disclosure` (160ms) |
| 右侧面板打开/关闭 | 面板的栏一次占好宽度,内容从右边 `0.5rem` 处滑入并淡入;关闭时原路淡出,结束后栏才拿走。不动宽度:动宽度会让对话区逐帧重排、面板里的终端逐帧重算行列(CYCL-213) | `--cycle-motion-disclosure` (160ms) |
| 右侧面板换标签 | 新标签的内容淡入,旧的立即隐藏(不叠在一起) | `--cycle-motion-state` (100ms) |

## 不可以

- 弹跳、回弹、过冲、闪光、发光、装饰性微动画。
- 动 `width`、`height`、`top`、`left`、`margin`、`padding`(侧栏收起是唯一例外,见上表)。只动 `transform`、`opacity` 和悬停 `background-color` / `color`。
- 滚动触发的出现动画、视差、滚动劫持。
- 流式输出时让页面跳动:代码块、表格、图片占位在出现时保持稳定结构,只往下长。
- 超过 200ms 的界面过渡(循环的状态点与等待旋转线除外)。
- 打字机效果。agent 的输出已经够慢了。

## 数值与令牌

- 三档时长全部集中定义在 `packages/ui/src/styles/app.css`,其他规则只引用变量,不写散落数字:
  - `--cycle-motion-state`: `100ms`
  - `--cycle-motion-disclosure`: `160ms`
  - `--cycle-motion-enter`: `200ms`
  - 统一曲线:`--cycle-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`)
- **不要保留未被引用的死令牌**:定义了 `--cycle-motion-enter` 就应真正用于弹窗/浮层/横幅的进入过渡。

## 减少动效

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

这是整个应用唯一允许 `!important` 的地方(仅 `app.css` 中的 `--cycle-fade-end` 滚动静态遮罩作为例外保留)。减少动效下,状态点不脉动,改靠形状与语义文字表达,不能因为动效没了而丢信息。

## 每个动效写一行理由

新增任何动效前先写清理由(例如:"横幅淡入:避免突然闪烁";"展开箭头旋转:明确当前折叠状态")。写不出来就不要做。
