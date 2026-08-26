# claude1 桌面端 UI 重构 prompt

本文是一份**可直接投喂给执行 agent 的任务书**。它不是设计文档——`UI/DESIGN.md` 才是唯一视觉
真理来源。本文的作用是：把「现在这套界面哪里不行、要改成什么、改完怎么验收」讲到能直接开工。

文中所有数字都来自 2026-08-20 对 `UI/macos` 运行实例的实测（Vite dev server :1420，窗口
1733×683 与 620 宽两档，深浅两主题各测一遍），不是估计。执行前不必重测，但改完必须按第 5 节
逐项复测。

---

## 0. 一句话任务

把 claude1 桌面端从「结构正确但视觉塌陷」推到「Cursor / ChatGPT desktop 同级的完成度」，
在**不动 `CONTRACT.md` 任何契约字段**的前提下，重建层次、动效、文案与精细度，并把 `UI/windows`
从落后 41 个文件的状态追平。

---

## 1. 现状诊断（实测证据，逐条可复现）

### 1.1 致命问题：层次的承重件选错了（**已修正原诊断**）

本节的第一版结论是「四层背景对比度只有 1.06，层次塌陷，要重排色值」。**那个结论是错的**，
补测业界基线后被推翻，记录在此以免执行者再走一遍弯路。

四层背景实测：

| 层对 | 深色实测 | 浅色实测 | 业界对照 |
| --- | --- | --- | --- |
| base ↔ surface | 1.06 | 1.06 | VSCode Dark+ 1.09、GitHub Dark 1.09 |
| surface ↔ elevated | 1.10 | 1.03 | GitHub surface↔overlay 1.07 |
| base ↔ elevated | 1.18 | 1.18 | Linear 近似 1.11 |
| base ↔ inset | 1.04 | 1.04 | — |

**本项目的背景层次与业界深色工具处在同一区间。** 深色主题里把层对比推到 1.25 以上，
只会让 surface 发灰、离 Cursor / ChatGPT desktop 更远。所以：**不要动背景色值。**

真正的缺口在承重件。实测 token 使用密度：

| token | 对 surface 对比 | 使用次数 |
| --- | --- | --- |
| `--border-subtle` | 1.16 | **49** |
| `--border-default` | 1.37（GitHub Dark 同位 1.42） | **18** |
| `--border-strong` | — | 9 |
| `--shadow-sm/md/lg` | — | 合计 **11**（3 / 3 / 5） |

卡片与表格容器普遍选了最弱的 `--border-subtle` 划结构——`views/channels/index.module.css:12`
的卡片、`components/Table.module.css` 的行框、`PoolCard.module.css:45` 都是。而值本身够用的
`--border-default` 被冷落，阴影几乎缺席。

**所以第一优先级是改组件里的 token 选择，不是改 token 的值。** 规则已写入 DESIGN.md 第 2.2.1 节：
独立容器（卡片、面板、浮层、输入框、表格外框）用 `--border-default`；`--border-subtle` 只用于
容器内部的行间分隔线；浮层必须同时带 `--shadow-md` 或 `--shadow-lg`。

### 1.2 自己的硬规则被自己违反

DESIGN.md 第 1 节写明「两套都必须自查对比度 ≥ 4.5:1」。实测不合格项：

- 深色 `--text-tertiary` on surface = **4.15**（不合格）
- 深色 `--text-tertiary` on base = **4.42**（不合格）
- 浅色 `--text-tertiary` on base = **4.23**（不合格）

`--text-tertiary` 被 DESIGN.md 限定「仅用于 ≥12px 的辅助文字」，但 12px 不能豁免 4.5:1——
WCAG 的豁免线是 18.66px bold / 24px regular。这三项是**规范违约**，不是口味问题。

其余语义色实测合格，重构时不要顺手改动：深色 accent 10.06、accentText 12.41、warn 7.02、
success 6.97、violet 5.93、danger 5.28；浅色 primary 17.13、secondary 7.12。

### 1.3 表格横向溢出叠加 sticky 半透明——这是 bug，不是审美

渠道表实测 `scrollWidth` = **1787px**。即使窗口拉到 1733px 宽，`clientWidth` 仍只有 1733px，
**永远溢出**；窄窗（容器 620px）下要横滚 1167px 才能看到操作列。

而操作列是 `position: sticky; right: 0; z-index: 2`，背景为 `rgba(10,157,176,0.07)`——
**半透明**。横向滚动时，底层单元格的文字会从操作列底下透出来，两层字叠在一起。

单元格实测宽度分布暴露了溢出根因：模型名列 **378px**（承载 `claude-opus-4-1-20250805` 这类
长 id），备注列 **610px**。两列吃掉 988px。

### 1.4 动效体系等于不存在

时长 token 的实际使用分布：

| token | 值 | 使用次数 |
| --- | --- | --- |
| `--dur-instant` | 80ms | **28** |
| `--dur-fast` | 140ms | 4 |
| `--dur-normal` | 220ms | 3 |
| `--dur-progress-loop` | 1100ms | 2 |

80ms 在感知上就是「瞬间」。全站 28 处反馈都是瞬时切换，等于没有动效。
`@keyframes` 全工程只有 **4 个**：`palette-in`、`app-progress-slide`、`fade`、`spin`。

对照参考坐标：Cursor 与 ChatGPT desktop 的质感几乎全部来自「轻、快、但连续」的过渡——
hover 的背景渐入、面板的位移入场、列表项的错峰出现、数字的滚动更新。这一层本工程完全空白。

### 1.5 诊断视图 5.5 屏长，无分段导航

实测诊断视图滚动容器 `scrollHeight` = **3744px**，`clientHeight` = **683px**。
5.5 屏的连续长页，没有 sticky 小节头、没有锚点跳转、没有回到顶部。用户滚到中段即失去方位。

### 1.6 windows 端落后 41 个文件

存在性差异：`src/store/ui.ts` **windows 完全缺失**——即「界面大小」标准/大/特大三档功能
在 Windows 端整个不存在。

内容差异 top 项（diff 行数）：`CommandPalette.tsx` **365**、`tokens.css` **200**、
`TitleBar.tsx` **161**、`TitleBar.module.css` 76、`global.css` 70、`Sidebar.module.css` 68、
`views/channels/index.tsx` 54、`store/nav.ts` 48。

### 1.7 已经做对的部分——不要推翻重做

- 外壳结构正确：7 个视图（渠道/槽位/用量/诊断/账号池/体检/设置）+ 主题三段控件（跟随/深色/浅色）。
- `⌘K` 命令面板可用，Escape 与遮罩点击都能正确关闭（实测 `_overlay_1zz79_3` 点击后 open=false）。
- 无障碍播报有专门的 `store/announce.ts`，且入口做了 `redactSecrets` 兜底脱敏——这是
  fail-closed 的凭证边界，**任何重构都不得绕过它**。
- macOS vibrancy 已落地：`--sidebar-bg: rgba(23,24,30,.72)` + `--sidebar-blur: 20px`，
  实测侧栏 computed 背景为半透明。

---

## 2. 重构指令（按用户点名的六个维度）

### 2.1 配色

**目标：把四层背景拉开到肉眼可辨，同时保住「深色为默认、颜色只表达语义」的立场。**

1. **背景四层色值保持不动**（理由见 1.1）。base #101116 / surface #17181e /
   elevated #1f212a / inset #0b0c10 与业界同区间，动它只会发灰。
2. **边框改用法，不改值。** `--border-default`（1.37）已与 GitHub Dark 同位，问题是
   49 : 18 的使用比例倒挂。按 DESIGN.md 第 2.2.1 节的规则把独立容器逐个换成
   `--border-default`，`--border-subtle` 退回容器内部分隔线。这是纯组件层改动。
3. ~~修 `--text-tertiary`~~ **（第一批已完成，2026-08-20）**：深色 #787a85 → `#828490`
   （surface 4.15→4.77、base 4.42→5.07）；浅色 #72747e → `#6c6e78`
   （base 4.23→4.61、surface 4.50→4.91）。DESIGN.md 第 2.1/2.2 节与 macos `tokens.css`
   已同步，比值写进了注释。漂移由 `UI/tools/token-drift.py` 守卫，改完 token 跑一遍即可。
   **windows 侧尚未同步**，见第 4 节。
4. 引入 elevated 的**顶部高光**（`inset 0 1px 0 rgba(255,255,255,.06)`）与真实投影。
   仅靠背景色区分浮层在深色主题里永远不够，光照线索比色差廉价且有效。
5. 浅色主题不是深色的机械反相，但**同样不要把 surface 改成纯白**。DESIGN.md 原本把
   surface 与 elevated 都写成 #ffffff，层次预算是 1.0（完全无区分）——实现里改成
   surface #fbfbfc / elevated #ffffff 才是对的。第一批已把这个修正回写进 DESIGN.md，
   连同 base #f3f4f6、inset #eef0f2、三档 border 与 hover/selected 的漂移值一并对齐。
6. accent 渐变 `linear-gradient(135deg,#3ed6e3,#3f8cff)` 与 `--accent-glow` 目前几乎没用上。
   限定用法：**只有主行动按钮**用渐变+发光，其他一律纯色 accent。别让渐变蔓延成装饰。

### 2.2 UI（视觉与组件精度）

1. **表格是重灾区，优先重做**（详见 1.3）：
   - 模型名列上限 240px，超出中截断（`claude-opus-4-1-…0805` 保留头尾），完整值进 tooltip
     与复制按钮；不要用 `text-overflow: ellipsis` 砍掉尾部——尾部的日期是用户区分版本的依据。
   - 备注列 610px 收到 flexible 但 min 160px / max 320px，多行改两行截断。
   - sticky 操作列背景改为**完全不透明**的 `--bg-surface`（当前行用 `--bg-selected-table`
     的不透明等价色），并加左侧 1px 分隔线 + 向左的渐变遮罩，表明「下面还有内容」。
   - 目标：1440px 窗口下 `scrollWidth ≤ clientWidth`，即默认不横滚。
2. 卡片、浮层、命令面板统一到新的 elevated 规范：圆角沿用 `--radius-lg: 12px`，
   投影分两档（浮层/对话框），不要每个组件自己写 box-shadow。
3. 等宽字体的执行要彻查。DESIGN.md 第 1 节硬规则第 3 条要求「渠道名、模型 id、token 计数、
   降级码、端口号全部 mono」。渠道表确实在渲染 `anthropic`、`200.0k` 这类标识符，但本轮**未逐项
   验证字体族**——需要对七个视图全量核对一遍，尤其槽位、用量、体检三处。
4. 图表原语（`components/charts/`）保留现有 sr-only 数据表方案，但配色要改为
   **单色渐变阶梯**而非多语义色——图表用 accent 的明度阶梯，语义色只留给状态标记。

### 2.3 UX（交互与信息架构）

1. **诊断视图分段**（详见 1.5）：加 sticky 小节头 + 右侧锚点导航（或顶部 segmented），
   长表格分页或虚拟滚动。3744px 的连续页必须被切成可跳转的块。
2. 命令面板**只需补三项，不要推翻重做**（**已修正原诊断**：原文写「当前只是视图跳转器」，
   2026-08-21 核实为错——`shell/CommandPalette.tsx` 已有四个分组共 28 个动作：导航七视图、
   渠道的启动/隐藏/别名/模型覆盖增删、槽位的绑定/清除/按槽位启动、以及主题切换、
   用量时间窗与分桶粒度、刷新当前视图、刷新全部、运行体检、打开日志目录、
   在 Finder 显示配置文件、折叠侧栏。这是 2026-08-19 那轮「命令面板动作补全」的成果）。
   实测缺口只剩三个：**界面大小三档切换**（`store/ui.ts` 有状态但面板未接，`density` 零命中）、
   **复制诊断报告**（零命中）、**最近使用分组**（零命中）。补这三项即可。
3. 键盘可达性（**已修正原诊断**：`⌘1`–`⌘7`、`⌘,`、`⌘R`、`⌘B` 在 `shell/keyboard.ts` 里
   **已全部实现**，原文说「需补」是错的）。真实缺口只有**表格内 `↑↓` 移动行 + `Enter`
   触发主操作**，以及确认 `Esc` 逐层退出在嵌套态（面板 mode 从 channel/slot 退回 root）下成立。
   焦点环用 2px `--accent` outline + 2px offset（DESIGN.md 4.1 节原文如此，不是 `--border-strong`）。
4. 空态、加载态、错误态三件套要在**每个视图**都成立。已有 `loadedKeys` 空态门控机制
   （见 memory `ui-desktop-shell-status`），沿用它，不要新造标志位。
5. 反馈机制统一。现在只有 `SlotRow.tsx` 里一处「成功反馈停留时长」的局部实现，
   注释还写着「不做 toast 队列」。既然 `--z-toast: 400` 与 global.css 的 toast 层已经存在，
   就补一个最小 toast store（成功/失败两态，3s 自动消失，可手动关闭），
   并让复制、启动会话、保存设置三类操作统一走它。

### 2.4 精细度

1. 1px 对齐与半像素模糊：所有分隔线检查是否落在物理像素上（Retina 下 0.5px 方案）。
2. 图标统一到单一线宽（1.5px）与单一栅格（20px），当前侧栏图标来源不统一。
3. 数字对齐：所有数值列右对齐 + `font-variant-numeric: tabular-nums`，
   token 计数与百分比不能因位数变化跳动。
4. hover / active / selected / focus / disabled 五态在每个可交互元素上都要有明确定义，
   且 selected 的主标识是**左侧 accent 条**（DESIGN.md 已定），背景色只是辅助。
5. 侧栏折叠态（`--sidebar-w-collapsed: 56px`）要有完整设计：图标居中、tooltip 补名称、
   展开/折叠有位移过渡。

### 2.5 文案

1. 全站中文文案统一为**陈述句、无感叹号、不用「哦/啦/呢」**。当前实测到的
   「隐藏：普通列表不再列出它」这种「标签：解释」句式很好，推广它。
2. 降级码走 DESIGN.md 第 4.4 节的「人话呈现」：`码 + 一句人话原因 + 一个可执行动作`。
   降级目录已在 `data/degradeCatalog.ts`，文案缺口在那里补，不要散落到视图里。
3. 错误文案**绝不伪装**——这是项目根 CLAUDE.md 的硬规则：上游错误原样暴露，
   前端只负责在原文旁加一行「这通常意味着什么」。禁止把上游 5xx 改写成「网络繁忙」。
4. 空态文案给出下一步动作而非描述现状：不写「暂无数据」，写「还没有渠道，按 ⌘K 添加」。
5. 播报文案（`announce.ts`）要能被读屏完整念出：避免纯符号、避免依赖颜色表意。

### 2.6 动态效果

**目标：从 28 处 80ms 瞬时切换，升级为分层的连续动效体系。**

1. 重新定义时长语义并强制执行：
   - `--dur-instant` 80ms —— 仅限 hover 背景/文字色变化。
   - `--dur-fast` 140ms —— 按钮按下、开关拨动、chip 选中。
   - `--dur-normal` 220ms —— 面板/抽屉/对话框入场，视图切换。
   - 新增 `--dur-slow` 320ms —— 命令面板、首屏内容浮现。
   要求 `--dur-fast` 与 `--dur-normal` 的使用次数各自 **≥ 8**（当前 4 / 3）。
2. 补齐关键 `@keyframes`（当前仅 4 个）：视图切换的淡入+2px 上移、列表项 20ms 错峰入场
   （上限 8 项，避免长列表拖沓）、数值变化的高亮闪一下、骨架屏的 shimmer。
3. 缓动只用两条既有曲线：入场/位移用 `--ease-out`，双向状态用 `--ease-in-out`。禁止新增。
4. `prefers-reduced-motion: reduce` 已在 global.css:209 存在——新增的每一条动效都必须
   落进这个分支被关掉，只保留不位移的透明度变化。
5. 不做的事：视差、弹跳（overshoot）、超过 400ms 的过渡、循环装饰动画。
   这是运维工具，动效服务于「状态变化被看见」，不是炫技。

---

## 3. 硬约束（越界即视为错误）

1. **`CONTRACT.md` 的契约面不可动**。第 2 节的 TypeScript 类型（两侧逐字相同）、第 6.2 节钉死的
   `AppState` / `NavState` 形状、第 3 节 IPC 命令签名——一个字段都不许增删改。
   需要新状态就像 `store/ui.ts`、`store/announce.ts` 那样**另开一个极小 store**。
2. **`DESIGN.md` 是唯一视觉真理来源**，且两个平台的 `tokens.css` 必须由它生成。
   改色值的正确顺序是：先改 DESIGN.md 第 2 节 → 再同步两侧 tokens.css → 最后改组件。
   反向操作（先改 CSS 后补文档）会让下一轮重构无据可依。
3. **不允许视图自创色值、间距、圆角**。所有值走 token。
4. **`redactSecrets` 脱敏边界不可绕过**（CONTRACT.md 第 1.2 节，fail-closed）。
   任何新增的文本展示路径——toast、tooltip、复制内容、错误详情——都要过它。
5. **错误原样暴露**，不伪装、不吞掉（项目根 CLAUDE.md）。
6. 文件所有权见 CONTRACT.md 第 6 节，那是并发写入的唯一冲突边界。多 agent 并行时按它切分。
7. macOS 构建目标是 `safari15`（WKWebView 对齐），**不要使用 Safari 15 不支持的 CSS**：
   慎用 `:has()`、容器查询、`@property`。写之前确认兼容性。
8. 代码注释保持中文，与现有工程一致。

---

## 4. windows 端追平（第二阶段，不与第一阶段并行）

先在 `UI/macos` 上把重构做完并验收，再按 DESIGN.md 第 5 节的平台差异表移植。原因：
两边同时改会让 41 个文件的差异变成无法审阅的三方 diff。

移植清单按优先级：

1. `src/store/ui.ts` —— 整个文件缺失，先补齐界面大小三档。
2. `tokens.css`（差 200 行）—— 按 DESIGN.md 重新生成，而不是从 macos 复制：
   Windows 没有 vibrancy，`--sidebar-bg` 应为不透明色，`--sidebar-blur` 不适用。
3. `CommandPalette.tsx`（差 365 行）—— 快捷键 `⌘K` → `Ctrl+K`，其余逻辑对齐。
4. `TitleBar.tsx` + `.module.css`（差 161 + 76 行）—— Windows 用系统窗口控件在右侧，
   与 macOS 左侧红绿灯的布局镜像，这部分**允许且应当**存在差异。
5. 其余 36 个文件按 diff 行数从大到小逐个对齐，纯样式差异优先。

另外：memory `ui-desktop-shell-status` 记录 2026-08-19 那轮 14 项修复（空态门控 loadedKeys、
refreshView 数组口径、命令面板动作补全、SEVERITY_TONE 单点化、图表 sr-only 数据表等）
**只落在 macos**，移植时要一并带过去。

---

## 5. 验收标准（改完逐项复测，数字必须达标）

在 `:1420` 起 dev server，深浅两主题、1440px 与 620px 两档宽度各测一遍：

| 项 | 基线 | 验收阈值 | 状态 |
| --- | --- | --- | --- |
| base ↔ surface 对比 | 1.06 | **保持 1.05–1.12**（不得推高） | — |
| surface ↔ elevated 对比 | 1.10 | **保持 1.05–1.15** | — |
| `--border-default` 值 | 1.37 | **不改值** | — |
| 独立容器用 `--border-default` 的比例 | 15 : 45 倒挂 | 独立容器外轮廓 100% 用 default | **已达 24 : 36**（`UI/tools/border-audit.py` 审计 0 违规） |
| 浮层同时带 border-default + shadow | — | 每个浮层都有 | **已核实齐备**（Dialog / CommandPalette / Select / Tooltip） |
| `--text-tertiary` on base（深/浅） | 4.42 / 4.23 | 均 ≥ 4.5 | **已达 5.07 / 4.61** |
| `--text-tertiary` on surface（深/浅） | 4.15 / 4.50 | 均 ≥ 4.5 | **已达 4.77 / 4.91** |
| DESIGN.md ↔ tokens.css 漂移项 | 深色 3 + 浅色 9 | 0（`UI/tools/token-drift.py` 校验） | **已对齐** |
| 渠道表 scrollWidth @1440px | 1787 | ≤ clientWidth | **已达成**（固定六列 874 + 备注 flex，总和上限 1130 ≤ 1160；`<colgroup>` + `table-layout: fixed`） |
| sticky 操作列背景 alpha | 0.07 | 1.0（不透明） | **已达成**（`--sticky-action-bg` 单点提供，当前行 `--bg-selected-table-solid` `#142126`/`#e3eef1`） |
| `--dur-fast` 使用次数 | 3（重测口径） | ≥ 8 | **已达 30**（第四批改动已落盘，复核未跑） |
| `--dur-normal` 使用次数 | 2（重测口径） | ≥ 8 | **已达 18**（同上） |
| `@keyframes` 总数 | 4 | ≥ 8 | **已达 8**（`palette-in` / `app-progress-slide` / `view-enter` / `list-stagger-in` / `value-flash` / `accent-bar-in` / `fade` / `spin`，全在白名单文件内。**数的时候要剔除注释**——`grep '@keyframes'` 会得到 16，多出的 8 处是注释提到这个词） |
| 诊断视图单段最大高度 | 3744px | ≤ 2 屏且有锚点导航 | 待第五批 |
| windows 缺失文件 | 1（store/ui.ts） | 0 | 待第六批 |
| windows token 对等违规 | 47（`UI/tools/token-parity.py` 2026-08-21 实测） | 0 | 待第六批 |
| windows 内容差异文件数 | 63（会随 macos 侧改动继续增长） | 仅剩 DESIGN.md 第 5 节白名单内的差异 | 待第六批 |

复测脚手架（浏览器控制台可直接跑，与本文数字同源）：

```js
(() => {
  const rs = getComputedStyle(document.documentElement);
  const tok = n => rs.getPropertyValue(n).trim();
  const srgb = c => (c /= 255, c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const hex = h => (h = h.replace('#', ''), [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)));
  const ratio = (a, b) => {
    const L1 = lum(a), L2 = lum(b), hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  };
  const base = hex(tok('--bg-base')), surf = hex(tok('--bg-surface')),
        elev = hex(tok('--bg-elevated'));
  const tbl = document.querySelector('table');
  return {
    theme: document.documentElement.dataset.theme,
    layer: {
      base_surface: ratio(base, surf),
      surface_elevated: ratio(surf, elev),
      base_elevated: ratio(base, elev),
    },
    border_default_on_surface: ratio(hex(tok('--border-default')), surf),
    tertiary: { on_base: ratio(hex(tok('--text-tertiary')), base),
                on_surface: ratio(hex(tok('--text-tertiary')), surf) },
    table: tbl ? { sw: tbl.scrollWidth, cw: tbl.clientWidth } : null,
  };
})()
```

同时必须通过：

- `python3 UI/tools/token-drift.py UI`（DESIGN.md 与 macos tokens.css 零漂移，退出码须为 0）
- `python3 UI/tools/border-audit.py UI/macos/src`（独立容器外轮廓 0 违规、内部线 0 误用）
- `python3 UI/tools/token-parity.py UI`（第六批后：两侧 token 名集合一致、深色值一致、
  差异只落在 DESIGN.md 第 5 节白名单内。2026-08-21 基线 47 项违规——其中 windows 的
  深色 `--accent` 还停在旧青 `#4ec9d4`，macos 早已换成 `#3ed6e3`）
- `python3 -m unittest discover -s tests -p 'test_*.py'`（项目根验证命令，不得因 UI 改动而失败）
- 键盘全流程走一遍：`⌘K` 开关、`Esc` 逐层退、七视图直达、表格内上下移动。
- 开启「减少动态效果」系统设置后，全站无位移动画。
- 读屏（VoiceOver）过一遍启动会话与体检两条播报路径。

---

## 6. 交付顺序

分五批，每批独立可验收，**不要一次性铺开**：

1. ~~**第一批（token 层）**~~ —— **已完成 2026-08-20**：`--text-tertiary` 深浅两套修到
   4.5:1 合规；DESIGN.md 第 2.1/2.2 节与 macos `tokens.css` 对齐（文档侧 12 项：深色 3、浅色 9，
   其中 `--bg-selected-table` 是旧青 `rgba(78,201,212)` 未随 accent 换新的色相漂移）；
   新增 DESIGN.md 第 2.2.1 节确立「边框/阴影承重」规则并记下业界对照基线。
   只碰 2 个文件，背景色值一个没动。
2. ~~**第二批（边框承重归位）**~~ —— **已完成 2026-08-20**：9 处独立容器外轮廓从
   `--border-subtle` 归位到 `--border-default`（`var()` 声明口径 45→36 / 15→24），零越界，
   浮层阴影经核实本来就齐备、无需补。**两处规则未覆盖的缺口记在 DESIGN.md 第 2.2.1 节**：
   外壳条带（Sidebar/ViewHeader/StatusBar）的分界线按现规则保持 subtle（曾改被回退），
   要升级须先扩规则；渠道表因不在 Card 内且 `Table.module.css` 无外框，归位无处落地，
   并入第三批。
3. ~~**第三批（表格）**~~ —— **已完成 2026-08-21**（workflow `ui-batch3-table`，6 agent 全成）：
   `<colgroup>` 七列定宽 + `table-layout: fixed` 自动判定、模型列中截断 `MidTruncate`
   （双 span 保尾部日期戳）、sticky 操作列不透明 + `box-shadow: inset` 分隔线 + 渐变遮罩、
   表格外框（`framed` prop，Card 内退框）。规范落在 DESIGN.md 新增的 §4.1.1。
   **三路复核 pass=False，22 项（1 blocker / 11 major / 10 minor），全部已处理**：
   - blocker：`.table thead th` 的 `text-align: left` 特异性压死 `.align-*`，
     `<Th numeric>`/`<Th align>` **一直是空转**（8 处受害，既存 bug）。已加同等特异性覆盖。
   - 两个本批新引入的回退：协议列 96px 硬裁（切 `fixed` 才暴露，已按最长合法值定到 160，
     从备注上限 320→256 匀出）、`framed` 逃生口零调用导致 Card 内双 1px 线
     （`PoolCard` 与 diagnostics 副表已传 `framed={false}`）。
   - 6 处文档矛盾：引用已删除的类名、"每张表都用 colgroup"写成绝对规定、
     "禁止 `text-overflow: ellipsis`"与自己的实现字面冲突、§2.2.1"规则不再有例外"、
     §5 的 tertiary `#72747e` 是**第一批漏改的残留**、浅色 `--sidebar-bg` 的 `.88` 无文档出处。
   - 记为缺口不动：`stickyHeader` **一直是空转**（`.scroll` 无 `max-height`，纵向可滚范围 0，
     3 处调用受害）。修它要改滚动结构、与 §3「唯一滚动容器」冲突，已写进 §4.1.1。
4. **第四批（动效与精细度）** —— **改动已落盘，复核未跑**（workflow `ui-batch4-motion`
   在 Apply 之后被 checkpoint 中断，Spec / Keyframes / Apply 四路完成，Verify 三路从未启动）。
   56 个文件被改，四项计数全部达标（见验收表）。编排者独立验过：`tsc` 干净、
   `token-drift` 0、`border-audit` 0 违规、`unittest` 800 OK。
   **下一步第一件事：跑 `UI/.orchestration/batch4-verify.mjs` 补上三路复核。**
   第三批的经验是复核能抓出 blocker，不要跳过。
5. **第五批（UX 与文案）**：脚本就绪 `UI/.orchestration/batch5-ux.mjs`（10 agent）。
   诊断分段、命令面板**只补三项**、toast store、降级码文案、空态三件套。
6. **第六批（windows 追平）**：脚本就绪 `UI/.orchestration/batch6-windows.mjs`（12 agent）。
   `token-parity.py` 基线 47 项违规，目标 0。

每批结束后更新 DESIGN.md 对应章节与 CONTRACT.md 第 6.2 节（若涉及所有权变更），
并把实测数字写回本文第 5 节的「当前实测」列——让下一轮重构者看到的是真实基线，不是历史陈述。

---

## 附：本文数据来源

2026-08-20 session `8e7adee2`：读 `UI/DESIGN.md`、`CONTRACT.md`、`README.md`、
`macos/src/styles/{tokens,global}.css`、`shell/{views,keyboard}.ts`；起 `:1420` dev server，
经 preview 通道逐视图截图 + `getComputedStyle` 求值；`grep` 统计动效 token 密度与
`@keyframes` 数量；`diff -rq` 比对 macos 与 windows 源码树。该 session 在写入本文时
连续三次被上游连接中断（1.2MB 上下文），数据从 session 记录中回收后由本文落盘。
