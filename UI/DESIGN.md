# DESIGN.md — claude1 桌面端设计系统

本文是**唯一视觉真理来源**。两个平台工程的 `src/styles/tokens.css` 必须由此生成；组件写法
以本文的规范为准，不允许各视图自创色值、间距或圆角。

## 1. 设计立场

界面服务于一件事：**让多渠道/多模型的真实状态一眼可读，让出错时看到人话**。

参考坐标：

- **Cursor**——窄图标侧栏 + 无重标题栏 + 高信息密度 + `⌘K` 中心命令面板；卡片不靠边框靠背景
  层次分隔；hover 只做 4% 白叠加这种极轻反馈；深色为默认。
- **Codex**——克制的灰阶，accent 只在真正需要行动时出现；状态用「小圆点 + 一行文字」而不是
  彩色徽章满屏；等宽字体承载所有技术标识（模型名、id、token 数）；大量留白让长列表可扫读。
- **本项目 TUI**（`docs/design-references/local-private-claude1-ui-concept-v1.png`）——近黑底、
  青色高亮条、紫色渐变 logo。桌面端继承青色作 accent、紫色作思考/推理语义色。

由此推出三条硬规则：

1. **深色是默认**，浅色是完整的第二套，不是"凑一个"。两套都必须自查对比度 ≥ 4.5:1。
2. **颜色只用来表达语义**，不用来装饰。中性灰阶承担 90% 的界面。
3. **数字和标识符一律等宽**。渠道名、模型 id、token 计数、降级码、端口号，全部 mono。

## 2. Token

### 2.1 颜色（深色，`:root`）

```css
--bg-base:        #101116;   /* 窗口底 */
--bg-surface:     #17181e;   /* 面板、卡片 */
--bg-elevated:    #1f212a;   /* 浮层、下拉、命令面板 */
--bg-inset:       #0b0c10;   /* 输入框、代码块（凹陷） */
--bg-hover:       rgba(255,255,255,.05);
--bg-active:      rgba(255,255,255,.08);
--bg-selected:    rgba(62,214,227,.20);
--bg-selected-table: rgba(62,214,227,.08); /* 高密度表格当前行，主标识仍是左侧 accent 条 */
--bg-selected-table-solid: #142126;  /* 上一行叠在 --bg-base 上的不透明等价色，供 sticky 操作列用（§4.1.1） */

--border-subtle:  #232530;   /* 默认分隔线 */
--border-default: #2e313d;   /* 卡片、输入框描边 */
--border-strong:  #414654;   /* focus 前的强调描边 */

--text-primary:   #ececf1;
--text-secondary: #a9abb6;
--text-tertiary:  #828490;   /* 仅用于 ≥12px 的辅助文字；对 surface 4.77 / base 5.07 */
--text-inverse:   #131316;

--accent:         #3ed6e3;   /* 青，主行动色（亮饱和，不低调） */
--accent-hover:   #6fe7ef;
--accent-press:   #2fc0cc;
--accent-muted:   rgba(62,214,227,.18);
--accent-text:    #8fe6ee;   /* 青字用于深底，保证对比度 */
--accent-gradient: linear-gradient(135deg,#3ed6e3 0%,#3f8cff 100%);  /* 品牌渐变：主按钮 */
--accent-glow:    rgba(62,214,227,.30);  /* primary 的外发光阴影 */

--violet:         #b57bee;   /* 思考 / reasoning / effort */
--violet-muted:   rgba(181,123,238,.14);

--success:        #3fb950;
--success-muted:  rgba(63,185,80,.14);
--warn:           #d29922;   /* 降级 = 琥珀，全局统一 */
--warn-muted:     rgba(210,153,34,.14);
--danger:         #f85149;
--danger-muted:   rgba(248,81,73,.14);
```

### 2.2 颜色（浅色，`[data-theme="light"]`）

```css
--bg-base:        #f3f4f6;
--bg-surface:     #fbfbfc;   /* 不是纯白：留出 elevated 用 #ffffff 的层次预算 */
--bg-elevated:    #ffffff;
--bg-inset:       #eef0f2;
--bg-hover:       rgba(0,0,0,.04);
--bg-active:      rgba(0,0,0,.07);
--bg-selected:    rgba(10,157,176,.11);
--bg-selected-table: rgba(10,157,176,.07);
--bg-selected-table-solid: #e3eef1;  /* 同上，over #f3f4f6 的不透明等价色（§4.1.1） */

--border-subtle:  #dfe1e6;
--border-default: #d2d4db;
--border-strong:  #b7bac4;

--text-primary:   #18181b;
--text-secondary: #55555f;
--text-tertiary:  #6c6e78;   /* 对 base 4.61 / surface 4.91 */
--text-inverse:   #ffffff;

--accent:         #0a9db0;
--accent-hover:   #088a9c;
--accent-press:   #067584;
--accent-muted:   rgba(10,157,176,.14);
--accent-text:    #06707f;
--accent-gradient: linear-gradient(135deg,#0a9db0 0%,#2563eb 100%);
--accent-glow:    rgba(10,157,176,.28);

--violet:         #7c4dbf;
--violet-muted:   rgba(124,77,191,.10);

--success:        #1a7f37;
--success-muted:  rgba(26,127,55,.10);
--warn:           #9a6700;
--warn-muted:     rgba(154,103,0,.10);
--danger:         #cf222e;
--danger-muted:   rgba(207,34,46,.10);
```

主题切换写 `document.documentElement.dataset.theme`，三态：`system` / `dark` / `light`。
`system` 时不写属性，由 `@media (prefers-color-scheme: light)` 内的 `:root:not([data-theme="dark"])`
接管——**深色定义在裸 `:root`，浅色在 media 与 `[data-theme="light"]` 两处重复定义**，
保证系统态与手动态都正确。

### 2.2.1 层次的承重结构（实测基线，2026-08-20）

四层背景之间的对比度**故意很小**，改之前先读完本节：

| 层对 | 深色实测 | 业界对照 |
| --- | --- | --- |
| base ↔ surface | 1.06 | VSCode Dark+ 1.09、GitHub Dark 1.09 |
| surface ↔ elevated | 1.10 | GitHub surface↔overlay 1.07 |
| base ↔ elevated | 1.18 | Linear 近似 1.11 |

也就是说**本项目的背景层次与业界深色工具处在同一区间**，不是缺陷。深色主题里把背景层拉到
1.25 以上会让 surface 明显发灰，反而离参考坐标更远。

层次真正的承重件是**边框 + 阴影**，而这里才是缺口。实测 token 使用密度：

- `--border-subtle`（对 surface 1.16）被用了 **49** 次
- `--border-default`（对 surface 1.37，与 GitHub Dark 的 1.42 基本持平）只用了 **18** 次
- 阴影三档合计只用了 **11** 次（sm 3 / md 3 / lg 5）

即：卡片与表格容器普遍选了最弱的 `--border-subtle` 来划结构，而值本身够用的
`--border-default` 被冷落，阴影几乎缺席。**结论——要改的是组件里的 token 选择，不是 token 的值。**

由此定下一条硬规则：

> **独立容器**（卡片、面板、浮层、输入框、表格外框）用 `--border-default`；
> `--border-subtle` 只用于**容器内部**的行间分隔线。浮层必须同时带 `--shadow-md` 或 `--shadow-lg`。

**执行结果（2026-08-20 第二批）**：9 处独立容器外轮廓归位，`var()` 声明口径下
`--border-subtle` 45→36、`--border-default` 15→24，倒挂修正。涉及 Card、CodeBlock、
channels `.toolbar`、doctor 两处列表框、slots 面板、KpiRow 两处、settings `PathRow` 取值框。

本轮暴露两处**规则未覆盖**的缺口（第 2 条已在第三批解决，第 1 条仍未决策，不要顺手改）：

1. **外壳条带的分界线**——`Sidebar` 的 `border-right`、`ViewHeader` 的 `border-bottom`、
   `StatusBar` 的 `border-top`。它们在 `App.tsx` 的结构里是同一 flex 容器内的**兄弟分隔线**，
   按本节规则与上面 2.1 节 token 表的注释（`--border-subtle /* 默认分隔线 */`、
   `--border-default /* 卡片、输入框描边 */`）都应保持 `subtle`。第二批曾尝试改成 `default`
   并已回退。**若确实认为这三条骨架线太弱（深色下对 surface 仅 1.16），要先扩本节规则、
   给「顶层区域分界」单独定档，再动代码**——不要靠个案判断偷偷升级。
2. **渠道表没有外轮廓可归位**——**已解决（第三批，2026-08-21）**。原状况：
   `views/channels/index.tsx` 里的 `Table` 不在 `Card` 内，而 `components/Table.module.css`
   自身不含外框 `border`（只有 `border-collapse` 与行间线），「表格外框用 `--border-default`」
   在该处无处落地。**解决方式**：不靠外面套 `Card`，而是让 `Table` 组件自带外轮廓——1px
   `--border-default` + `--radius-md`，落在组件的滚动包裹层（`.scroll`）而不是 `<table>`
   本身，因为 `border-collapse: collapse` 下 `<table>` 上的圆角会被单元格边框穿出。
   **但规则有一个例外，别漏了**：套在 `Card` 里的表不是「独立容器」，卡片已经画了一条
   1px `--border-default`，表格再画一条就成了两条同色线贴在一起（外加 8px 圆角套 12px 圆角）。
   所以 `Table` 的外框做成可退的——`framed` prop 默认 `true`，**在 `Card`（尤其
   `Card flush`）里必须显式传 `framed={false}`**。现有两处这样用：
   `views/accounts/parts/PoolCard.tsx` 与 `views/diagnostics/index.tsx` 的出现记录副表。
   第三批最初漏了这两处，双线是复核抓出来的。
   完整规范（含列宽预算与 sticky 操作列）见 §4.1.1。

### 2.3 排版

```css
--font-ui:   /* 平台各自定义，见 §5 */;
--font-mono: /* 平台各自定义，见 §5 */;

--fs-11: 11px;  --lh-11: 16px;   /* 表头、单位 */
--fs-12: 12px;  --lh-12: 18px;   /* 徽章、辅助说明、时间戳 */
--fs-13: 13px;  --lh-13: 20px;   /* 辅助说明、次级正文 */
--fs-14: 14px;  --lh-14: 21px;   /* 正文默认、列表主标题 */
--fs-16: 16px;  --lh-16: 24px;   /* 卡片标题 */
--fs-20: 20px;  --lh-20: 28px;   /* 视图标题、大数字（统计） */
--fs-28: 28px;  --lh-28: 34px;   /* 唯一的英雄数字 */

--fw-regular: 400; --fw-medium: 500; --fw-semibold: 600;
```

正文 14px 是基准。**不出现 15px、17px 这类中间值。**

**数字定宽是硬规则，不是「大数字才需要」**：所有数值一律
`font-variant-numeric: tabular-nums`，并且**成列出现时右对齐**——位数从 3 位变 4 位不许让
列位左右跳动，也不许让 KPI 的整数部分横向漂移。适用范围（缺一处就是 bug）：

- 表格里的数值列（token 计数、上下文窗口、次数、耗时）——右对齐 + tabular-nums，见 §4.1.1
- KPI 与统计大数字（`--fs-20` / `--fs-28`）
- token 计数与百分比（缓存命中率、占比、成本）
- 端口号、HTTP 状态码、降级码计数、时间戳
- 图表的数值标签（§4.2）

mono 与 tabular-nums 是两件事，都要给：mono（§1 第 3 条）保证标识符不糊，tabular-nums 保证
数字不跳。**看到 `.mono` 类不等于数字已定宽**——工程里 `Badge` / `Table` / `Input` 的
`.mono` 带 tabular-nums，`Select` / `Textarea` / `settings` 的 `EnvRow` 的 `.mono` 只换字体族。
顺着类名查到底再决定要不要补，不要凭类名假设。

### 2.4 间距 / 圆角 / 层级

```css
--sp-1: 4px;  --sp-2: 8px;   --sp-3: 12px;  --sp-4: 16px;
--sp-5: 20px; --sp-6: 24px;  --sp-8: 32px;  --sp-10: 40px;

--chat-list-w: 240px;   /* 对话视图会话列表固定宽（§4.5）；视图级尺寸，不进通用间距阶梯 */

--radius-sm / --radius-md / --radius-lg / --radius-full: 999px;  /* 数值见 §5 */

--shadow-sm: 0 1px 2px rgba(0,0,0,.24);
--shadow-md: 0 4px 12px rgba(0,0,0,.28);
--shadow-lg: 0 12px 32px rgba(0,0,0,.36);

--z-content: 1; --z-sticky: 10; --z-dropdown: 100;
--z-dialog: 200; --z-palette: 300; --z-toast: 400;
```

### 2.4.1 交互五态（每个可交互元素都必须五态齐全）

`hover` / `active` / `selected` / `focus-visible` / `disabled` —— **缺哪一态就是 bug**，
不是「视觉打磨的余量」。适用于所有可点、可选、可聚焦的元素：`Button`、`IconButton`、
`Switch`、`SegmentedControl`、`Select`、`Input`、侧栏导航项、表格行、chip / tab、
命令面板条目。

| 态 | 用哪个 token | 时长 | 硬约束 |
|---|---|---|---|
| `hover` | 背景叠 `--bg-hover`；实底 accent 面（`Button primary`）换 `--accent-hover` | `--dur-instant` | 只变色，**不位移、不放大、不加阴影**；`cursor: pointer` |
| `active`（按下） | 背景叠 `--bg-active`；accent 面换 `--accent-press` | `--dur-fast` | 必须与 hover 视觉可区分，否则「到底按下了没有」无法判断 |
| `selected`（当前项） | **标识按场景分派，§3 已定，不可互换**：侧栏用内缩圆角块（左右各留 `--sp-2`、`--radius-md`）+ `--bg-selected` 底 + 图标与文字转 accent 色；高密度表格的「当前」行用**左侧 `--accent-bar-w`（2px）accent 竖条** + `--bg-selected-table` 底（sticky 操作列取不透明等价色 `--bg-selected-table-solid`，§4.1.1） | `--dur-fast` | **不许只靠一个半透明底色表达选中**——半透明底叠在不同层背景上会变色。侧栏靠「内缩块形状 + 底色 + accent 文字图标」三者叠加，表格靠「竖条 + 底色」，两条都满足 §6「状态不只靠颜色」。**不许给侧栏补竖条**：贴边细竖条是旧版语言，内缩块上显得廉价（实现注释见 `shell/Sidebar.module.css`）；也不许把表格竖条换成整块底色——信息密度高的表格里竖条比底色更好扫（§3 原话） |
| `focus-visible` | `--focus-ring-w`（2px）`--accent` outline + `--focus-ring-offset`（2px）offset；Windows 侧 1px / offset 1px（§5 焦点环行） | 不过渡，立即出现 | **绝不 `outline: none`**（§4.1 `Button` 行、§6 第 1 条）。焦点环画在元素外侧，不许被父级 `overflow: hidden` 裁掉 |
| `disabled` | 文字与图标 `--text-tertiary`，背景回落到无态，`cursor: default`，同时给原生 `disabled` 或 `aria-disabled="true"` | 不过渡 | **不可点**（原生 `disabled` 或 `pointer-events: none`），不许只靠颜色表意；不许用整体 `opacity` 压暗——那会连语义色一起压掉，并把嵌套文字的对比度拖到 §1 的 4.5:1 以下 |

叠加规则（写组件时最容易漏的部分）：

- `selected` + `hover`：选中标识恒亮不变（表格是竖条，侧栏是内缩块，见 selected 行的场景分派），
  背景在选中底之上再叠 `--bg-hover`。另注意 `selected` 的 `--dur-fast` 在实现里通常写成
  **元素级** `transition-duration`，于是选中项被 hover 时的变色也走 140ms，比未选中项的 80ms
  慢一档。这是纯 CSS 难以只对类切换生效的必然结果，**不算**把 hover 抬到 140ms 凑数；
  真正违规的是把未选中元素的 hover 变色写成 `--dur-fast`。
- `selected` + `focus-visible`：两者都画，焦点环**不替代**选中标识。
- `disabled` 吃掉 `hover` 与 `active`，但**不吃掉 `focus-visible`**——`aria-disabled` 的元素
  仍应可聚焦，否则读屏用户根本读不到「这里有个不能用的按钮」。
- sticky 操作列的行背景在**任何一态下都必须不透明**（§4.1.1「sticky 操作列」第 1 条），
  给它加 `background-color` 过渡时中间态也不许出现半透明。

### 2.5 动效

```css
--dur-instant: 80ms;    /* hover 的背景色 / 文字色 */
--dur-fast: 140ms;      /* 按下、拨动、chip/tab 选中、图标旋转翻转 */
--dur-normal: 220ms;    /* 面板入场、视图切换、折叠展开的尺寸位移 */
--dur-slow: 320ms;      /* 命令面板入场、首屏内容浮现——仅此两类 */
--ease-out: cubic-bezier(.2,.8,.3,1);
--ease-in-out: cubic-bezier(.4,0,.2,1);

/* 以下两个不是过渡时长，不受下面的过渡上限约束，理由见「上限与例外」 */
--dur-progress-loop: 1100ms;   /* 顶部 1px 加载进度线的 indeterminate 循环周期 */
--dur-spin-loop: 720ms;        /* Spinner 旋转的循环周期 */
--dur-caret-loop: 1100ms;      /* 对话视图流式光标 caret-pulse 的呼吸周期（§4.5） */
```

**时长语义（强制映射）**

按语义选值，**不许为了凑数量乱用**。

| token | 值 | 只准用在 |
|---|---|---|
| `--dur-instant` | 80ms | 仅限 hover 的背景色 / 文字色变化 |
| `--dur-fast` | 140ms | 按钮按下、开关拨动、chip / tab 选中、图标旋转翻转 |
| `--dur-normal` | 220ms | 面板 / 抽屉 / 对话框入场、视图切换、折叠展开的尺寸位移 |
| `--dur-slow` | 320ms | 命令面板入场、首屏内容浮现。**仅此两类，不要扩散** |

反向判据（复核按它判）：hover 态里只过渡 `background-color` / `color` 的规则**必须**是
`--dur-instant`。把它改成 140ms 或 220ms 是凑数，不是设计——80ms 之所以短，正因为 hover
是指针路过的副产物，慢下来会变成拖影。

**缓动只有两条曲线，禁止新增**：入场与位移用 `var(--ease-out)`，双向状态（hover 进出、
开关来回）用 `var(--ease-in-out)`。组件里出现裸 `cubic-bezier(`、或 `ease` / `ease-in`
/ `ease-in-out` 这类 CSS 关键字，都算违规。**不做弹跳 overshoot**——那需要 `cubic-bezier`
的第 2 或第 4 个参数越出 `[0,1]`，而这两条曲线都没有越出，所以「禁止新曲线」与「禁止弹跳」
是同一条规则的两面。

**上限与例外**

**过渡上限 320ms**，没有比 `--dur-slow` 更慢的过渡。

唯一的例外是 **indeterminate 指示器的循环周期**：它不是过渡，不表达「A 变成了 B」，
而是表达「还在进行」，所以不受上限约束。全工程只有三处合法循环，各自有 token——
`--dur-progress-loop`（1100ms，顶部加载进度线）、`--dur-spin-loop`（720ms，`Spinner`；
组件里目前仍写着字面值 720ms，换成 token 即可）与 `--dur-caret-loop`（1100ms，对话视图
流式/思考态光标 `caret-pulse`，§4.5）。除这三处之外出现 >320ms 的时长，
一律按违规处理。

对话视图里逐字出现的流式文本同理：它是**数据到达**，不是过渡，不占循环名额，
也不受 320ms 上限约束（§4.5）。

不做视差、不做弹跳、不做循环装饰动画、不做骨架屏闪烁——加载态用一条 1px 顶部进度线
（accent 色）。**「不做骨架屏闪烁」是明文禁令**：`skeleton-shimmer` 这类微光扫过的关键帧
不许出现在本工程，需要加载态就用进度线或 `Spinner`。这是运维工具，动效服务于「状态变化
被看见」，不是炫技。

**关键帧清单（白名单，全工程只允许这 9 个）**

新增关键帧一律进 `styles/global.css` 并配一个工具类，让调用方用类名而不是各自写
`@keyframes`；已有的三处组件模块（`CommandPalette` / `Dialog` / `Spinner`）归各自 owner，
保留原位。**`src/views/**` 下不许出现 `@keyframes`。**

| 关键帧 | 所在文件 | 用途 | 时长 / 曲线 | 位移或缩放 |
|---|---|---|---|---|
| `palette-in` | `shell/CommandPalette.module.css` | 命令面板入场：opacity 0→1 + 上移 `--sp-2` 归零 | `--dur-slow` `--ease-out` | 有 |
| `app-progress-slide` | `styles/global.css` | 顶部 1px 加载进度线的 indeterminate 循环 | `--dur-progress-loop` `--ease-in-out` `infinite` | 有 |
| `fade` | `components/Dialog.module.css` | 对话框遮罩与面板淡入 | `--dur-normal` `--ease-out` | 无 |
| `spin` | `components/Spinner.module.css` | 加载指示器旋转 | `--dur-spin-loop` `linear` `infinite` | 有（旋转） |
| `view-enter` | `styles/global.css` | 视图切换入场：opacity 0→1 + `translateY(2px)`→0 | `--dur-normal` `--ease-out` | 有 |
| `list-stagger-in` | `styles/global.css` | 列表项错峰入场：opacity 0→1 + `translateY(2px)`→0；容器挂 `.stagger`，逐项 20ms delay，8 项封顶 | `--dur-normal` `--ease-out` | 有 |
| `value-flash` | `styles/global.css` | 数值变化高亮：`background-color` 从 `--accent-muted` 回到元素自身底色 | `--dur-normal` `--ease-out` | 无 |
| `accent-bar-in` | `styles/global.css` | 选中态 accent 竖条入场：`scaleY(0)`→1 | `--dur-fast` `--ease-out` | 有（缩放） |
| `caret-pulse` | `styles/global.css` | 对话视图流式/思考态光标：纯 opacity 呼吸（§4.5） | `--dur-caret-loop` `--ease-in-out` `infinite` | 无 |

**reduced-motion 的精细规则**

`@media (prefers-reduced-motion: reduce)` 开启后，判据是**有没有位移**，不是「有没有动画」：

1. **位移、缩放、旋转一律关掉。** 涉及 `transform` 的过渡与关键帧全部停用——上表最后一列
   标「有」的六个（`palette-in`、`app-progress-slide`、`spin`、`view-enter`、
   `list-stagger-in`、`accent-bar-in`）在这个模式下
   不许播放。宽高、`top/left`、`margin`
   这类会让元素挪位的过渡同样关掉。
2. **不位移的透明度与颜色变化保留。** `opacity`、`color`、`background-color`、
   `border-color`、`box-shadow`、`fill`、`stroke` 的过渡继续走，时长可以压到
   `--dur-instant`。这类变化不引起视线追物，前庭敏感用户可以接受；而它承载的正是
   「状态变了」这个信息，全关掉等于连可读性一起关了。
3. **关掉循环之后，指示器必须仍有静态可见形态。** `Spinner` 停转后仍是一个可见的环，
   进度线停走后仍是一条可见的 accent 条。**不允许出现「关掉动画等于加载态消失」**——
   那是把可达性做成了功能缺失。`caret-pulse` 属第 2 条的纯透明度变化，reduced-motion 下
   可以保留；若实现选择关掉，光标必须回落为**静态可见的插入符**——「关掉动画等于
   思考态消失」同样不允许（§4.5）。
4. **兜底优先于精细。** 通配的 `animation: none !important` 保留：它保证任何后来新增的
   关键帧都默认被关掉，包括 CSS Modules 里 global.css 够不到的哈希类名。然后只对
   global.css 自己提供的**无位移**工具类显式恢复。代价是 `Dialog` 的 `fade` 这类模块内的
   纯透明度动画一起被关掉——可以接受：丢一次淡入不丢任何信息。
5. `scroll-behavior: auto !important` 保留。

这段是可达性兜底，**写反了比不写更糟**。改它之前先确认改完仍然覆盖**全部**关键帧，
包括本批新增的四个。

## 3. 布局骨架

```text
┌──────────────────────────────────────────────────────────────┐
│ TitleBar  (可拖拽区；平台差异见 §5)                            │
├────────┬─────────────────────────────────────────────────────┤
│        │ ViewHeader   标题 · 计数 · 右侧动作区                 │
│ Side   ├─────────────────────────────────────────────────────┤
│ bar    │                                                     │
│ 232px  │ 内容区（唯一滚动容器，padding: 0 var(--sp-6)）        │
│        │                                                     │
├────────┴─────────────────────────────────────────────────────┤
│ StatusBar 30px  当前渠道 · 槽位 · hub 端口 · 今日 token · 降级数 │
└──────────────────────────────────────────────────────────────┘
```

- **Sidebar** 232px，可折叠至 56px（只留图标）。顶部固定品牌区：渐变 Agent Hub mark
  + "Agent Hub" 字标（`--fs-16` `--fw-semibold`）；折叠态只留 32px mark。下方分三组：
  `会话`（对话、渠道、槽位）、`观测`（用量、诊断、账号池、体检）、`扩展`（插件、任务）。
  底部固定「设置」与主题切换。
  选中项：内缩圆角块（左右各留 `--sp-2`、`--radius-md`）+ `--bg-selected` 底 + 图标与文字转 accent 色；
  渠道表的「当前」行仍用左侧 2px accent 竖条标记（信息密度高的表格里，竖条比整块底色更好扫）。
- **TitleBar** 右侧放一个太阳/月亮 IconButton 做深浅色一键快切（显示的是「点它会变成什么」；
  三态「跟随系统」仍由侧栏底部的 SegmentedControl 承担）。
- **StatusBar** 常驻，是产品定位的直接体现（多模型同时在线要一眼看到）。
- **界面大小**：设置页「外观」提供 标准 / 大 / 特大 三档整体缩放（body zoom 100% / 112.5% / 125%），
  图标、文字、控件一起变大，立即生效，localStorage 持久化（键 `claude1.desktop.density`）。
- 主内容区**唯一滚动容器**，页面 body 永不横向滚动；宽表格自己 `overflow-x:auto`。
- 内容最大宽度 1120px 居中；表格类视图可满宽。
- **每视图正文说明 ≤1 行**。解释性文字一律收进列头 Tooltip、EmptyState hint 或诊断视图；
  不在筛选行下方再叠第二层说明。这是去简陋的核心纪律。

## 4. 组件规范

### 4.1 通用原语（`src/components/`）

| 组件 | 关键规范 |
|---|---|
| `Button` | 高 30（sm）/ 34（md）；变体 `primary`（`--accent-gradient` 渐变实底、白字、`--accent-glow` 外发光）、`secondary`（`--bg-surface` + `--border-default`）、`ghost`（透明，hover 上 `--bg-hover`）、`danger`。focus-visible 用 2px `--accent` outline + 2px offset，**绝不 `outline:none`** |
| `IconButton` | 30×30，`--radius-sm`，必须有 `aria-label` 与 Tooltip |
| `Input` / `Textarea` | `--bg-inset` 底、`--border-default` 描边，focus 转 `--accent`；错误态转 `--danger` 并在下方 12px 说明 |
| `Select` | 原生 `<select>` 套自定义样式，不造下拉浮层（省依赖、免键盘可达性 bug） |
| `Switch` | 40×22，轨道 `--border-strong` → 开启 `--accent` |
| `SegmentedControl` | 用于 effort 五档（未设置/low/medium/high/xhigh）与主题三态 |
| `Badge` | 高 20，`--fs-12`，mono 字体，`*-muted` 底 + 对应语义文字色 |
| `StatusDot` | 6px 圆点 + 文字，Codex 式状态表达。语义：绿=正常、琥珀=降级、红=失败、灰=未启用、青=当前 |
| `Tooltip` | 纯 CSS/轻 JS，延迟 400ms，`--bg-elevated` + `--shadow-md` |
| `Dialog` | 居中，最大宽 520，`--bg-elevated`，遮罩 `rgba(0,0,0,.5)`；Esc 关闭、焦点陷阱、打开时焦点进首个可聚焦元素 |
| `Table` | 表头 `--fs-11` 大写字距 .04em `--text-tertiary`，行高 40（dense 34），行间 1px `--border-subtle`，hover `--bg-hover`。列宽固定，数字列右对齐 mono；macOS 隐藏滚动条时，承载主动作的末列固定在右侧，避免核心操作滚出视口后不可发现 |
| `EmptyState` | 图标 + 一行说明 + 一个动作按钮。文案说清"为什么空"，不写"暂无数据" |
| `CodeBlock` | `--bg-inset`，mono 12px，可复制；**渲染前必须过一遍凭证脱敏** |

### 4.1.1 表格的列宽与 sticky 操作列

`Table` 是本项目信息密度最高的组件，列宽必须**先算再写**，不能靠内容撑——内容一变列就跳，
用户扫读时对不齐。

**列宽策略**

- 需要硬列宽上限的表，在表头之前用 `<colgroup>` 声明列宽，配 `table-layout: fixed`。
  宽度取 `--table-col-*` token，视图里不写 px。`Table` 的 `layout` prop 不传时按「有没有
  `<colgroup>`」自动切：有就 `fixed`（让声明的宽度成为硬约束），没有就 `auto`（保持按内容 +
  `minWidth` 分配列宽的老行为）。
  **这条不是每张表都必须做**：目前只有渠道表用了 `<colgroup>`，另外四张
  （`accounts/parts/PoolCard`、`usage/parts/UsageTable`、`diagnostics/parts/FailureTable`、
  `diagnostics` 的出现记录副表）列数少、没有长 id 撑宽的问题，保持 `auto`。
  判断标准是「有没有列会被长内容撑到吃掉别人的宽度」，不是「表格是否重要」。
- **切到 `fixed` 之前先按最长合法值验一遍每个定宽列**。`auto` 下列宽由内容撑开、看不出
  窄了；切 `fixed` 后窄列会直接硬裁，且 `<td>` 上没有 `text-overflow` 时连省略号都没有。
  第三批的协议列就是这么踩的（详见下方预算表的说明）。
- 固定列给定宽，**整张表只留一个 flexible 列**（备注），由它吸收剩余宽度。多个 flexible
  列会让相邻两张表的列位对不上，也让列宽随数据抖动。
- 数字列右对齐 mono（承 §4.1 表 `Table` 行的规定）。

**模型名列：240px 上限 + 中截断**

- 上限 `--table-col-model-max`（240px）。超出走**中截断**，头部与尾部都保留：
  `claude-opus-4-1-…0805`。
- **禁止对整格用 `text-overflow: ellipsis`**——整格 ellipsis 砍的是尾部，而尾部的日期戳
  （`0805`、`20250929`）正是用户区分同族模型版本的唯一依据，砍掉等于把两个不同模型显示成
  同一个。禁的是「砍尾部」这个结果，不是这个 CSS 属性本身：现行实现（`MidTruncate`）恰恰
  用它——头段 `flex: 1 1 auto` + `overflow: hidden` + `ellipsis` 吃掉溢出，尾段
  `flex: 0 0 auto` + `nowrap` 保住日期戳，两段各自独立。**按字面读成「不许出现这个属性」
  会把唯一可行的纯 CSS 方案也否掉。**
- 显示不靠 JS 裁字符：双 `<span>` 让浏览器按可用宽自己决定头段裁到哪里，DOM 里两段拼起来
  仍是完整原串。**完整值进 `title`**。
  待办（第三批未交付，需要时再做）：列头 `Tooltip` 与单元格内的复制按钮。第三批范围只到
  「不横滚 + 不砍尾部」，复制交互被明确排除在该批之外，所以这两项现在只有 `title` 兜着。
- 完整值进 `title` / Tooltip / 剪贴板之前必须过 `redactSecrets`（`CONTRACT.md` 1.2，fail-closed）。

**备注列：min 160 / max 320，两行截断**

- `--table-col-note-min` / `--table-col-note-max`，这是唯一的 flexible 列。
- 超过两行折断：`display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden`（safari15 可用），完整文本进 `title`。不做三行以上——行高一变整表行高就乱。
- 备注取自 `notes`，`CONTRACT.md` 1.2 明确说该字段可能被用户塞过 key，所以**折断前后的两份
  文本（显示串与 `title`）都得是脱敏后的**，不能因为「只是 tooltip」就绕过。
- 现状备注：`views/channels/index.tsx` 的第 6 列目前渲染的是「语义兼容性」，占的就是这一档
  预算。重构时若要拆出独立的备注列，宽度得从别的列匀，不许加总宽。

**sticky 操作列**

末列承载主动作，`position: sticky; right: 0`（§4.1 已定「承载主动作的末列固定在右侧」），因此：

1. **背景完全不透明。** 半透明背景在横滚时会透出下面滚过去的单元格文字。非当前行用
   `--bg-base`（表格底就是它，也和 sticky 表头同色）；当前行用 `--bg-selected-table-solid`
   ——即 `--bg-selected-table` 叠在 `--bg-base` 上的不透明等价色，按
   `c = a·前景 + (1−a)·背景` 逐通道算出（深色 `#142126`、浅色 `#e3eef1`）。
   落地方式：底色由原语 `.stickyAction` 的局部变量 `--sticky-action-bg` 单点提供，
   视图侧只覆盖这个变量、不再自带第二套 `position: sticky`。视图现有三处覆盖——
   分区标题行与详情行用 `--bg-surface`（跟各自的行底对齐，免得操作列变成一条暗带），
   已隐藏行用 `--bg-inset`，三个都是不透明色。
2. 左侧 1px `--border-subtle` 分隔线。它是**容器内部**的分隔线，按 §2.2.1 的规则不用 `default`。
   **实现必须用 `box-shadow: inset 1px 0 0`，不能用 `border-left`**：`.table` 是
   `border-collapse: collapse`，合并模式下单元格边框归 table 的 border grid 统一绘制、
   不属于单元格盒子，横滚时会留在原位不跟着钉住的列走。inset 阴影画在单元格自己的盒子上。
3. 分隔线外侧向左一道 `--table-sticky-fade-w`（24px）宽的渐变遮罩，从行背景色渐到透明，
   表明「左边还有内容没看完」。用伪元素叠 `linear-gradient` 实现；若改用遮罩，
   `-webkit-mask-image` 与标准 `mask-image` 必须同时写（构建目标 safari15）。
   遮罩常显即可，不挂 JS 滚动监听。

**表格外框**

`Table` 自身补 1px `--border-default` 外轮廓 + `--radius-md`。落点是组件的滚动包裹层
（`.scroll`），不是 `<table>`——`border-collapse: collapse` 下 `<table>` 上的圆角会被单元格
边框穿出。这解决 §2.2.1 记的第 2 条缺口：渠道表不在 `Card` 内，此前没有外框可归位。

**宽度预算（1440px 窗口，硬预算）**

1440 − 侧栏 232 − 内容区左右 padding 48（`var(--sp-6)` ×2）= **可用宽 1160px**。

| 列 | 宽（px） | token |
|---|---|---|
| 状态 | 88 | `--table-col-status` |
| 渠道 | 150 | `--table-col-channel` |
| 协议 | 160 | `--table-col-protocol` |
| 模型 | 240（上限） | `--table-col-model-max` |
| 上下文窗口 | 104 | `--table-col-context` |
| 备注 | 160~256（flex） | `--table-col-note-min` / `--table-col-note-max` |
| 动作 | 132 | `--table-col-action` |

固定列合计 **874px**（88+150+160+240+104+132）。备注取 min 160 → **1034px**；取 max 256 →
**1130px**。两种都 ≤ 1160，因此 1440px 下默认不横滚。

**这组数字是硬预算：要加宽某列就得从别的列匀出来，七列总和不许越过 1130。**

**已知缺口：`stickyHeader` 目前是空转，别依赖它。** `Table` 的 `.scroll` 包裹层没有
`height` / `max-height`，高度恒等于内容高度，纵向可滚范围为 0，所以 `position: sticky;
top: 0` 的表头永远不会钉住——真正的页面滚动条在祖先 `App.module.css` 的 `.scroll` 上，
而 sticky 的偏移只对最近的 scrollport 求解。三处调用（渠道表、`usage/parts/UsageTable`、
`diagnostics/parts/FailureTable`）都传了这个 prop 但没有效果。
要修得先决定滚动结构：给表格容器一个 `max-height` 让它自己纵向滚（表头就能钉，但页面里
出现第二个滚动条，与 §3「主内容区唯一滚动容器」冲突），或者把 sticky 的参照改成内容区。
**这是结构性取舍，不该由某一批顺手改**——`overflow-x: auto` 让包裹层同时成为纵向 scrollport
这件事，正是外框圆角能裁切的原因，两者绑在同一块 markup 上。

协议列为什么是 160 而不是更省的 96：定宽列的宽度得按**最长合法值**反推，不是按常见值。
`ApiFormat` 的四个值里最长的 `openai_responses` 是 16 字符，12px mono 按 0.6em advance
算 115.2px，加 Badge 左右 padding 16 与 td 左右 padding 24 = 155.2px。
第三批最初给了 96px，可用文本宽只有 56px（7.8 个字符），连最常见的 `anthropic`（9 字符）
都会被硬裁且没有省略号——**这是切到 `table-layout: fixed` 才暴露的回退**，改 fixed 之前
列宽由内容撑开（改造前实测协议列不裁、模型列 378px、备注列 610px），所以看不出来。
加宽的 64px 从备注列上限匀走（320→256），总和不变。
**教训：把表切成 fixed 之后，每个定宽列都要按最长合法值验一遍，别按截图上看到的值定宽。**

`--table-col-note-max` 的落点与其他列不同，别踩坑：`<col>` 只认 `width`，不认
`min/max-width`，所以这个 token 约束不了列宽本身——它落在单元格内层元素的 `max-width` 上
（现为 `ChannelRow.module.css` 的 `.compatInner`）。flexible 列在 fixed 布局下会吃掉全部
余量，1440px 下实得 1160−2（外框）−874 = 284px，比 256 宽；内容被内层 `max-width` 封住，
所以视觉上仍是 256。预算表里的 256 是**内容宽上限**，不是列宽上限。

### 4.2 图表原语（`src/components/charts/`）

全部手写 SVG，`viewBox` + `preserveAspectRatio="none"` 自适应，颜色取 CSS 变量
（`stroke="var(--accent)"`），因此自动跟随主题。

- `Sparkline`——单序列趋势，24×N，无坐标轴，末点一个 2px 圆点。
- `BarChart`——按渠道/模型的横向条形，条高 20，圆角 2，值标签在条右侧 mono。
  多序列（input/output/cache）用堆叠，颜色序：`--accent` → `--violet` → `--text-tertiary`。
- `TimeSeries`——用量按小时/天的折线 + 面积（accent 8% 填充），有 Y 轴 3 条刻度线
  （`--border-subtle` 虚线）与 X 轴时间标签。hover 显示垂直参考线 + 数值浮层。
  可选**成本副轴**：右轴 3 刻度 + `--danger` 虚线，只在有定价数据时出现——成本是语义色，
  不占下方「最多 3 色」的序列额度。
- `Donut`——缓存命中率单指标，环宽 8，中心放百分比 `--fs-20`。

图表配色**不用彩虹**：同一图里最多 3 色，序列语义固定（输入=青、输出=紫、缓存=灰）。

### 4.3 命令面板（`⌘K` / `Ctrl+K`）

Cursor 式中心浮层：宽 560，距顶 15vh，`--bg-elevated` + `--shadow-lg` + `--radius-lg`。
输入框在顶部无边框，下方分组结果（`导航` / `渠道` / `槽位` / `动作`），↑↓ 移动、Enter 执行、
Esc 关闭。模糊匹配（子序列匹配即可，不引 fuse.js）。命中的字符用 `--accent-text` 高亮。

**这是键盘用户的主入口**，所有视图动作都要在这里能找到。

### 4.4 降级码的人话呈现

`CONTRACT.md` 的 `DEGRADE_CATALOG` 是唯一文案来源。呈现规则：

- 列表里显示**中文标题**，把 `HUB_DEGRADE_*` 原码放在标题右侧 `--fs-11` mono `--text-tertiary`
  ——人话在前，机器码在后但绝不隐藏（可搜索、可粘贴给作者）。
- 展开后三段：**发生了什么** / **对你的影响** / **建议动作**。
- 严重度映射颜色：`info`=灰点、`notice`=青点、`degraded`=琥珀点、`lossy`=琥珀点+粗体标题。
- 同一回合的多个降级码折叠成一行「+N」，展开看全部。

### 4.5 对话视图（ViewId `chat`）

Agent 对话模式。本轮交付的是 **UI 骨架 + 演示数据**：会话、消息、流式回复全是前端假数据，
后端尚未接入。结构是工作台三件套：左侧会话列表 + 右侧消息流 + 底部 composer。
本视图**满宽**（同表格类视图，不走 1120px 居中），且自身接管滚动——会话列表与消息流是
两个独立滚动容器，内容区外壳不滚。这是 §3「唯一滚动容器」的唯一视图级例外。

**演示数据横幅（强制）**

视图顶部、双栏之上一条单行细横幅：`--warn-muted` 底、`--warn` 文字、`--fs-12`，文案固定为
「演示数据——对话尚未接入后端」。假数据必须显式标明，对齐 `CONTRACT.md` §4
「绝不让假数据冒充真实数据」的徽章精神；接入后端后整条移除，不留开关。

**会话列表（左栏，固定宽 `--chat-list-w` 240px）**

- 与消息流之间 1px `--border-subtle`（兄弟分隔线，同 §2.2.1 外壳条带口径）。
- 每项两行：标题一行截断；副行「渠道名 · 相对时间」mono `--fs-12` `--text-tertiary`。
- 选中项沿用侧栏的「内缩圆角块」规范（§2.4.1 selected 行、§3），不另造选中标识，
  也不补竖条。
- 行间不画分隔线，靠间距分组；hover `--bg-hover`，五态按 §2.4.1。

**消息流（右栏，独立滚动容器）**

- 用户消息：右对齐窄块，`--bg-elevated` 底 + `--border-default` 描边 + `--radius-md`，
  最大宽为消息流宽度的 70%。这是全站仅有的「气泡」，且**不自造彩色底**。
- 助手消息：无气泡，正文流左对齐全宽（ChatGPT / Codex 的克制做法），正文 `--fs-14`。
- system / 演示提示：`--bg-inset` 小条（`--radius-sm`）+ `--fs-12` `--text-tertiary`。
- 模型名、token 数、时间戳一律 mono + tabular-nums（§1 第 3 条、§2.3）；时间戳
  `--fs-12` `--text-tertiary`。
- 自动跟随：新消息到达时列表滚到底部；**用户上翻后停止跟随**，滚回底部才恢复。

**流式呈现（演示回复逐字出现）**

逐字出现是**数据到达**不是过渡，不受 320ms 上限约束（§2.5「上限与例外」）。到达过程中的
等待指示**只允许 `caret-pulse`**（§2.5 白名单）：一个纯透明度呼吸的插入符光标，无位移。
不许再出现打字机圆点、旋转图标等第二套等待动画。新消息按 §6 走 `aria-live="polite"`，
但只在整条消息完成时播报一次，不逐字播报。

**composer（底部固定）**

- 输入区沿用 §4.1 `Input` / `Textarea` 规范：`--bg-inset` 底、`--border-default` 描边，
  focus 转 `--accent`。
- 发送按钮是本视图的主行动，用 `Button primary`（渐变 + `--accent-glow` 发光——
  这正是它该出现的地方，§4.1）。
- 键位写死：**Enter 发送、Shift+Enter 换行**，不做设置项。

**空态与思考态**

- 空态按 `EmptyState` 规范给下一步动作：「选一个渠道，说第一句话」。不写「暂无对话」。
- 助手回复到达前的思考态就是 `caret-pulse` 光标本身；reduced-motion 下它是静态可见的
  插入符（§2.5 第 3 条）。

### 4.6 插件视图（ViewId `plugins`）

管理 Claude Code 配置项（hooks / outputStyle / statusLine / permissions / mcp）的清单与
启用开关。来自渠道级 `settings_config` 的项**只读**——所有权在渠道，不在本视图。

**按 kind 分组的列表（不用表格）**

- 组头用 `SectionHeader`（标题 + `count`）。
- 每行从左到右：`StatusDot` + 名称（mono `--fs-14`）+ kind `Badge` + 一行 summary
  （`--fs-13` `--text-secondary`，一行截断）+ 右侧操作位。
- `StatusDot` 语义沿用 §4.1 既有映射，不新增：绿=启用、灰=未启用、**琥珀=只读不可改**。
- 行高 40，行间 1px `--border-subtle`，hover `--bg-hover`；五态与 focus 环全部按
  §2.4.1 / §4.1，本视图不造新态。

**可写与只读的分叉**

- 可写项：右侧 `Switch`（§4.1）。
- 只读项：右侧「只读」字样（`--fs-12` `--text-tertiary`），**不给禁用的 Switch**——
  禁用开关暗示「满足某条件就能开」，而渠道级项在这里永远不可开。
- 「为什么不可改」用 `Tooltip` 承载（如「来自渠道的 settings_config，到渠道视图改」）。
- 琥珀点 + 「只读」文字 + Tooltip 三重编码，满足 §6「状态不只靠颜色」。

### 4.7 计划任务视图（ViewId `tasks`）

计划任务（定时启动会话 / 体检提醒）的 CRUD 与下次运行时间展示。形态是**卡片列表**
（`Card`），不用表格——任务字段异构、数量少，卡片比定宽列好扫，也免去 §4.1.1 的
列宽预算。

**每卡的固定结构**

- 头部：名称（`--fs-14` `--fw-medium`）+ kind `Badge`。
- 正文：`scheduleText` 一行（人话排程，`--fs-14`）；其下 cron 原串 mono `--fs-12`
  `--text-tertiary`——人话在前、原串不隐藏（同 §4.4 降级码原则）。
- 右上：**下次运行倒计时**，mono + tabular-nums、右对齐，格式为「3 天 2 小时后」式的
  人话相对时间，复用 `formatRelative` 家族，不新写格式化函数。
- 动作位：启用 `Switch` + 删除 `IconButton`（danger 变体，`aria-label` + Tooltip 按 §4.1；
  删除前走 `Dialog` 确认）。
- 到点未跑的任务显示「已错过」，配琥珀 `StatusDot`——不是红：任务是错过，不是失败。

**新建 / 编辑**

走 `Dialog`（§4.1：居中、最大宽 520、Esc 关闭、焦点陷阱），表单控件全部用 §4.1 原语。
空态按 `EmptyState` 给下一步动作（如「新建一个每天 9 点的体检提醒」），不写「暂无任务」。

**前后端分工（写死）**

`nextRunAt` 由后端计算，前端只做展示与倒计时渲染，**不在前端解析或推算 cron**——
时区与夏令时的坑留在后端一处。

## 5. 平台差异（两个目录存在的理由）

| 维度 | macOS | Windows |
|---|---|---|
| 标题栏 | `titleBarStyle: "Overlay"`，透明；内容左侧留 78px 给红绿灯；高 38px；标题居中 `--fs-13` `--text-secondary` | `decorations: false` 自绘；高 32px；右侧自绘 最小化/最大化/关闭（46×32，close hover `#c42b1c` 白图标）；左侧 12px 放应用名 |
| 拖拽 | 标题栏整条 `data-tauri-drag-region` | 同上，但排除自绘按钮区 |
| 背景材质 | 窗口 vibrancy（`NSVisualEffectView`，`sidebar` 材质）；Sidebar 背景半透明 + `backdrop-filter: blur(20px)`。深色 `rgba(23,24,30,.72)`；**浅色 `rgba(243,244,246,.88)`**——浅底下 .72 会透得看不出侧栏边界，所以不透明度更高 | Win11 Mica（`ApplyMica`）；不可用时退回实色 `--bg-base`，**不做 blur 兜底**（性能差） |
| 浅色层级 | 为避免大面积同亮度灰纸感，覆盖为 `base #f3f4f6`、`surface #fbfbfc`、`elevated #fff`、`inset #eef0f2`；边框 `#dfe1e6 / #d2d4db / #b7bac4`；tertiary 文本 `#6c6e78`（原 `#72747e` 对 `base` 只有
4.23:1，低于 §1 的 4.5:1 硬规则，第一批已修到 4.61 / 4.91——这一格当时漏改，2026-08-21 补） | 使用 Fluent/Mica 的平台浅色层级，不跟随 macOS 覆盖 |
| 圆角 | `--radius-sm:6px` `--radius-md:8px` `--radius-lg:12px` | `--radius-sm:4px` `--radius-md:6px` `--radius-lg:8px`（Fluent 更方） |
| UI 字体 | `-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue"` | `"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI"` |
| 等宽字体 | `"SF Mono", ui-monospace, "JetBrains Mono", Menlo` | `"Cascadia Code", "Cascadia Mono", Consolas` |
| 字重补偿 | 无 | 正文 `--fw-regular`，标题用 `--fw-semibold`（Segoe 视觉偏细，中文标题需 600） |
| 滚动条 | 隐藏（`::-webkit-scrollbar{width:0}`），靠触控板惯性 | 8px 细滚动条常显，thumb `--border-strong` `--radius-full`（Windows 用户期待可见轨道） |
| 快捷键显示 | `⌘K` `⌘,` `⌘R` `⌥⌘I` | `Ctrl+K` `Ctrl+,` `Ctrl+R` `Ctrl+Shift+I` |
| 修饰键检测 | `event.metaKey` | `event.ctrlKey` |
| 动效时长 | 表内基准值 | **过渡四档**（`--dur-instant/fast/normal/slow`）全部 ×0.85（Windows 惯例更快），即 68 / 119 / 187 / 272ms；**indeterminate 循环周期**（`--dur-progress-loop` / `--dur-spin-loop`）两侧取相同值，不缩放——它们不是过渡，缩了只会让循环更抢眼（现状可查：两侧 `--dur-progress-loop` 都是 1100ms） |
| 焦点环 | 2px offset 2px | 1px offset 1px（Fluent 更贴合） |
| 控件密度 | 表内基准 | 行高 -2px（40→38），按钮高 -2px |

`chat` / `plugins` / `tasks` 三视图在上表之外**无平台差异项**。唯一要按上表执行的是：
chat 的会话列表与消息流是两个独立滚动容器（§4.5），滚动条遵循上表「滚动条」行——
macOS 隐藏，Windows 常显 8px 细滚动条；两个容器都遵守，不只消息流一个。

**共同底线**：两侧的功能、信息架构、文案、token 命名完全一致。差异只在上表列出的维度；
任何其他不一致都是 bug。

## 6. 可达性

- 全部交互元素键盘可达，Tab 顺序符合视觉顺序；`focus-visible` 必须可见。
- 语义化标签：视图用 `<main>`、侧栏 `<nav aria-label="主导航">`、列表用 `<ul>`/`role="table"`。
- 状态不只靠颜色：降级/失败一律颜色 + 图形（圆点形状/图标）+ 文字三重编码。
- 动态内容更新用 `aria-live="polite"`（如启动结果、体检结论）。
- 最小点击区 28×28。
