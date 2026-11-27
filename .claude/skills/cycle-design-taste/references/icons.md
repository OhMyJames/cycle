# 图标

一套线性图标,来自 iconmcp(原创图标库,16 单位网格,线性、实心、双色三种样式)。不画仿品,不混用别的图标集。

## 怎么取

iconmcp 已装为 MCP(`claude mcp add --transport http iconmcp https://iconmcp.com/mcp`)。流程:

1. `search_icons`:按"这个图标要表达什么"搜,例如 `new session`、`archive`、`send message`、`stop`、`warning`。
2. `get_icon`:取 SVG 或 React 组件。界面里的图标用 **outline**,`size` 16 或 20,`stroke` 1.25 到 1.5,`color` 不传(继承 `currentColor`)。
3. 找不到合适的才 `request_icon`;图标有明显问题用 `report_icon`。

当前会话如果没有加载这个 MCP 的工具,重启 Claude Code,或者直接对 `https://iconmcp.com/mcp` 发 MCP 的 HTTP 请求(它是无状态的)。

## 放在哪里、怎么用

- 集中放在 `packages/ui/src/react/icons.tsx`,一个图标一个组件,统一的 props:`size`、`className` 以外不开放;
  `aria-hidden="true"`,`focusable="false"`。不在各组件里粘贴 SVG。
- 只有图标的按钮:包在 `Tip`(`packages/ui/src/react/tip.tsx`)里,`label` 写动作("Archive session"),有快捷键时给 `shortcut`。`Tip` 既是悬停和聚焦时的提示,也是读屏的名字,按钮自己不再写 `aria-label` 或 `title`。
- 图标旁边有文字时,图标是装饰,不重复说明。
- 同一个意思永远同一个图标;同一个图标不表示两个意思。
- 状态不只靠颜色:断线、出错、等待各有不同的形状或文字。
- 品牌标志(比如将来在主机上显示的系统)用它真实的标志,不自己画;现在没有这个需求。

## 应用图标

`apps/desktop/assets/icon.svg` 是源文件(iconmcp 的 `agent-loop`,放在靛蓝渐变的圆角方块上),
`bun run scripts/icon.ts`(在 `apps/desktop` 下)生成 `icon.icns`。改了 SVG 就重新生成并一起提交。
