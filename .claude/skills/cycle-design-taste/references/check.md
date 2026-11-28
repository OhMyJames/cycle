# 检查

按从便宜到贵的顺序。每一步的目的是找出"看起来没问题但其实有问题"的地方。

## 1. 门禁(每次)

```bash
bun run check        # 边界、css、类型、lint、单元测试、DOM 测试,十几秒
```

注意门禁会校验 `DESIGN.md` 与 `packages/ui/src/styles/` 下样式里的 `--cycle-*` 令牌双向完全一致;lint 有任何 warning 都会失败(`--error-on-warnings`)。新的界面状态要在界面测试里有一条(`packages/ui/test/browser/app.browser.tsx`,在无界面的 Chromium 里跑,`bun run test:browser`;假桥接在 `test/fake-bridge.ts`)。

## 2. 文案和 i18n

门禁里有 i18n 的棘轮:`bun .claude/skills/cycle-design-taste/scripts/scan-copy.mjs --i18n`。它数每个文件里还写在标记里的界面文字,和 `scripts/i18n-baseline.json` 比,只许减少。把存量搬进目录后用 `--update` 降低基线。

### 文案扫描

```bash
bun .claude/skills/cycle-design-taste/scripts/scan-copy.mjs            # 默认扫 packages/ui/src/react
bun .claude/skills/cycle-design-taste/scripts/scan-copy.mjs path/a.tsx # 指定文件或目录
```

它读 JSX 文本和 `title`、`aria-label`、`placeholder`、`alt`、`label` 里的字符串,命中空话、套话、美德词、感叹号、表情、破折号。
不为通过它而改写:命中的词如果是字面意思(例如真的在说 "harness"),在这一行说明理由,而不是把句子改坏。
它查不出"没说事实"和"用了旧词 `host`"的文案,那要自己按 `references/copy.md` 读。

## 3. 状态画廊

`bun packages/ui/gallery/shoot.ts` 用真实组件和假数据截图,默认覆盖浅色、深色和 1200×800;要加拍最小窗口宽度,传 `--sizes 1200x800,720x480`。在无界面的 Chromium 里截(Playwright,2 倍像素,不开窗口、不抢焦点;第一次运行前装一次浏览器:`bun run test:browser` 会顺带装上)。可传场景名缩小范围,改布局或交互时用两个 `--out` 目录保留同条件的前后图。打开相关截图,按改变的路径实际操作。新增界面状态在 `packages/ui/gallery/scenarios.ts` 里补场景。截图体积大时加 `--crop <选择器|x,y,w,h>`、`--format webp`、`--max-width 960`(输出文件名带 `.crop`)。详见 `DESIGN.md` 附录 A。

画廊检查根页面的横向和纵向溢出、控制台错误和指定的键盘焦点。项目分组与大量会话场景还检查初始列表能完整显示第一条会话。代码块和历史区各自的内部滚动是正常的。

## 4. 在真实窗口里看

门禁看不到颜色、间距、溢出、对齐。要看真东西:

- **端到端**:`bun run test:integration web`(根目录;会先 build)在无界面的 Chromium 里打开构建出的页面,后面是真的 daemon,走一遍连接、新建、发消息、批准、重载。
- **真实模型的运行**:`CYCLE_REAL_MODEL_TOKEN=… bun run test:real`(在 `apps/desktop` 下,先在根目录 build);
  `SHOT_TO=/路径.png` 把页面截图存下来。用法见 `docs/desktop.md`。
- **在 Mac 上**:打包出来的应用(`bun run build`,或从发布里下载)是用户真正看到的东西,窗口装饰、字体、深色模式以它为准。

看的时候:

1. **浅色和深色**各一遍(令牌用 `light-dark()`,跟随系统;在 Mac 上切系统外观,或在 Electron 里用 `nativeTheme.themeSource` 强制)。
2. **窗口大小**:默认 1200×800 和最小 720×480。检查第一条需要处理的会话能看全,窄窗口下输入框工具条不溢出/不重叠,打开和收起侧栏后主区仍可用且有恢复按钮,长历史滚动时标题和输入区留在窗口内。
3. **极端数据**(`references/states.md` 末尾):长路径优先保留尾部,长标题末尾淡出,不撑破布局。
4. **键盘与弹窗**:用真实按键检查改变的路径。焦点环看得见、不被裁掉;表单弹窗支持自动聚焦与 Enter 提交;破坏性确认主按钮为 `destructive` 且焦点在 Cancel;Esc 逐层关闭并归还焦点;`⌘Return` 在有权限卡时即使光标在输入框也可用;中文 IME 选词回车不误发送。
5. **流式中**:发一条会产生长输出或连续工具调用的消息,看页面是否跳动、滚动是否只在用户在底部时跟随、工具展开状态是否保持。
6. **缩放**:系统字体放大一档时布局仍然成立。

## 5. 复杂留给系统(每次改交互时过一遍)

对照 `DESIGN.md` 的"复杂留给系统,不留给用户"八条,逐条回答改动有没有违反:

- 有没有让用户做系统本可判断的选择?此刻用不到的东西有没有出现?
- 同一动作在各处的名字和路径一致吗?按下去有回应、再按能收回吗?
- 会不会打断用户正在做的事?会丢东西的操作是否难误碰、常用的是否一步到位?
- 不看文档,界面自己说得清状态和下一步吗?

动效的变化清点方法见 `references/motion.md`。

## 判定与交付

- **缺陷**会妨碍完成任务、导致误操作、丢失内容,或使键盘和无障碍路径失效。给出可复现的状态,为能稳定复现的条件加对应的 DOM 或画廊检查。
- **打磨**包括措辞、密度、交互线索或视觉分量。按它对当前任务的影响判断。扫描器的命中要用实际状态复核,例如用 Tab 判断分隔条的焦点,并记录误报理由。
- 交付时说明改了什么、验证了哪些尺寸、主题和关键操作、实测结果及剩余缺口。画廊使用假桥接,真实 IPC、SSH、模型和 VoiceOver 各有自己的验证范围。

前后图目前由人工比对。窗口装饰、原生菜单和系统辅助功能在 macOS 上验证。
