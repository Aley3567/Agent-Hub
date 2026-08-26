export const meta = {
  name: 'ui-batch6-windows',
  description: '第六批：Windows 端追平 macOS，按 DESIGN.md 第 5 节平台差异表保留应有差异',
  phases: [
    { title: 'Base', detail: 'tokens/global 重新生成 + store 追平（含缺失的 ui.ts）' },
    { title: 'Port', detail: '七路并行移植：外壳三块 / 组件 / 两组视图 / 数据层' },
    { title: 'Verify', detail: '三路独立复核：追平完整性 / 平台差异正确性 / 契约与文案' },
  ],
}

const ROOT = '/Users/admin/Desktop/claude-hub/UI'
const MAC = `${ROOT}/macos/src`
const WIN = `${ROOT}/windows/src`

const PREAMBLE = `你在把 ${ROOT} 下的 macOS 桌面端成果移植到 Windows 端
（Tauri v2 + React + TypeScript + CSS Modules）。

【背景：为什么现在做这批】
macOS 侧刚连做了五批改造，Windows 侧一批都没跟：
  第一批 token 层：--text-tertiary 深浅两套修到 4.5:1 合规、DESIGN.md 与 tokens.css 对齐。
  第二批 边框承重：9 处独立容器外轮廓从 --border-subtle 归位到 --border-default。
  第三批 表格：外框、sticky 操作列不透明、渐变遮罩、模型列中截断、colgroup 列宽。
  第四批 动效：--dur-slow 320ms、时长语义映射、@keyframes 补齐、五态、tabular-nums。
  第五批 UX 文案：诊断视图分段、命令面板补三项、toast store、降级码文案、空态三件套。
另外 2026-08-19 那轮 14 项修复（空态门控 loadedKeys、refreshView 数组口径、
命令面板动作补全、SEVERITY_TONE 单点化、图表 sr-only 数据表等）**也只落在 macos**。
**这些全部要带过去。**

【最重要的一条：哪些差异必须保留】
两侧的功能、信息架构、文案、token 命名**完全一致**。差异只允许出现在 DESIGN.md 第 5 节
平台差异表列出的维度里。**任何其他不一致都是 bug。**
反过来说：把平台差异抹平（比如给 Windows 也加 vibrancy、把 Ctrl+K 改成 ⌘K）**同样是错的**。
动手前必读 ${ROOT}/DESIGN.md 第 5 节整张表。

【不可越界的硬约束】
1. 只改分配给你的文件路径。你的路径全部在 ${WIN} 下——**macOS 侧一个字都不许改**。
   如果你发现 macOS 侧有 bug，写进 open_questions，不要动手。
2. CONTRACT.md 第 2 节 TypeScript 数据类型「两侧逐字相同」、第 6.2 节 AppState / NavState 形状、
   第 3 节 IPC 签名——一个字段都不许增删改，两侧必须逐字一致。
3. redactSecrets 是 fail-closed 凭证脱敏边界（CONTRACT.md 1.2 节），移植时不可绕过、不可弱化。
4. 错误原样暴露，不伪装、不吞掉。
5. 文案两侧**逐字一致**。degradeCatalog.ts 顶部注释明写「不要在移植时改写措辞」。
   唯一允许的文案差异是快捷键显示（⌘K → Ctrl+K 这类）。
6. 代码注释保持中文。注释里描述平台差异时要写清「Windows 侧如此，macOS 侧是 X」。

【禁止伪造证据】
注释里引用 DESIGN.md / CONTRACT.md 章节前先 grep 确认真实存在。前面批次抓到过 agent
自创名词再拿章节号背书。引用不到就不引用。

【工作方法】
用 diff 驱动，不要凭记忆移植：
  diff ${MAC}/<路径> ${WIN}/<路径>
逐个 hunk 判断：这是「macOS 领先、需要追平」，还是「平台差异、应当保留」？
判断依据只有 DESIGN.md 第 5 节那张表。判不准的写进 open_questions，不要瞎猜。

【报告要求】
最终文本就是返回值。按 schema 返回结构化数据。
ported 写你追平了什么，kept_different 写你**刻意保留**的平台差异及其依据（第 5 节的哪一行）。`

const PLATFORM_TABLE = `【DESIGN.md 第 5 节平台差异表（Windows 列，这是唯一的差异白名单）】
标题栏：decorations: false 自绘；高 32px；右侧自绘 最小化/最大化/关闭（46×32，
  close hover #c42b1c 白图标）；左侧 12px 放应用名。（macOS 是 Overlay 透明、高 38px、
  左侧留 78px 给红绿灯、标题居中）
拖拽：标题栏整条 data-tauri-drag-region，但**排除自绘按钮区**。
背景材质：Win11 Mica（ApplyMica）；不可用时退回实色 var(--bg-base)，**不做 blur 兜底**（性能差）。
  即 Windows 的 --sidebar-bg 应为**不透明色**，--sidebar-blur 不适用。
浅色层级：使用 Fluent/Mica 的平台浅色层级，**不跟随 macOS 的覆盖值**。
圆角：--radius-sm:4px --radius-md:6px --radius-lg:8px（Fluent 更方；macOS 是 6/8/12）。
UI 字体："Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI"。
等宽字体："Cascadia Code", "Cascadia Mono", Consolas。
字重补偿：正文 --fw-regular，标题用 --fw-semibold（Segoe 视觉偏细，中文标题需 600）。
滚动条：8px 细滚动条**常显**，thumb --border-strong --radius-full（macOS 是隐藏滚动条）。
快捷键显示：Ctrl+K / Ctrl+, / Ctrl+R / Ctrl+Shift+I（macOS 是 ⌘K / ⌘, / ⌘R / ⌥⌘I）。
修饰键检测：event.ctrlKey（macOS 是 event.metaKey）。
动效时长：**全部 ×0.85**（Windows 惯例更快）。
焦点环：1px offset 1px（macOS 是 2px offset 2px）。
控件密度：行高 −2px（40→38），按钮高 −2px。
**表里没列的维度，两侧必须一致。**`

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_changed', 'ported', 'kept_different', 'open_questions'],
  properties: {
    files_changed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'what'],
        properties: { path: { type: 'string' }, what: { type: 'string' } },
      },
    },
    ported: { type: 'array', items: { type: 'string' }, description: '追平了什么能力/修复' },
    kept_different: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'basis'],
        properties: {
          what: { type: 'string', description: '刻意保留的差异' },
          basis: { type: 'string', description: 'DESIGN.md 第 5 节的哪一行支持它' },
        },
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'violations', 'measured', 'notes'],
  properties: {
    pass: { type: 'boolean' },
    violations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'path', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          path: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    measured: { type: 'object', additionalProperties: true },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

/* ── 现状（编排者 2026-08-21 diff 实测）────────────────────────────────
   存在性差异只有一个：${MAC}/store/ui.ts 在 Windows 侧**完全缺失**
   （即「界面大小 标准/大/特大 三档」在 Windows 端整个不存在）。
   内容差异 63 个文件。diff 行数 top：CommandPalette.tsx 365、tokens.css 240、
   TitleBar.tsx 161、TitleBar.module.css 76、global.css 70、Sidebar.module.css 68、
   views/channels/index.tsx 54、store/nav.ts 48、shell/views.ts 46、
   views/diagnostics/index.tsx 43、views/doctor/index.tsx 34。
   **这些数字会因为前几批的改动继续变化，不要拿它们当准，自己 diff。**
   门禁：${ROOT}/tools/token-parity.py 校验两侧 token 的对等性（名字集合必须一致；
   深色色值/字号/间距/阴影/层级必须一致；第 5 节明文允许差异的维度只报告不判违规）。
   **2026-08-21 基线：47 项违规**——windows 缺 14 个 token 名（--accent-glow、
   --accent-gradient、--bg-selected-table、--bg-selected-table-solid、9 个 --table-col-*、
   --table-sticky-fade-w）；深色段 22 项不该差异却差异了（--accent 还是旧青 #4ec9d4，
   macos 早已换成 #3ed6e3；--bg-base #131316 vs #101116 等）；浅色段 8 项 + 缺失 4 项。
   跑法：python3 ${ROOT}/tools/token-parity.py ${ROOT}
   ${ROOT}/tools/token-drift.py 只校验 macos 一侧，本批不用它。
   ──────────────────────────────────────────────────────────────────── */

phase('Base')
const base = await parallel([
  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

你的角色：win-shell（样式基座）。你名下只有两个文件——
  ${WIN}/styles/tokens.css
  ${WIN}/styles/global.css
（其他 Windows 文件归别人，macOS 侧一律只读。）

任务：把这两个文件按 DESIGN.md 重新生成，而不是从 macos 复制。

1. **tokens.css 是重头**。DESIGN.md 第 2 节是唯一真理来源，第 5 节 Windows 列是平台覆盖。
   正确做法：以 DESIGN.md 第 2 节的色值/字号/间距/动效为骨架，逐项应用第 5 节 Windows 列的覆盖。
   必须应用的 Windows 覆盖：
   - 圆角 --radius-sm:4px --radius-md:6px --radius-lg:8px
   - --font-ui: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif
   - --font-mono: "Cascadia Code", "Cascadia Mono", Consolas, monospace
   - **--sidebar-bg 必须是不透明色**（Windows 无 vibrancy，Mica 不可用时退实色，不做 blur 兜底）。
     --sidebar-blur 在 Windows 不适用——要么删掉，要么明确置为 0 并注释说明，你选一个并说清理由。
   - 动效时长**全部 ×0.85**：--dur-instant 80→68ms、--dur-fast 140→119ms、
     --dur-normal 220→187ms、--dur-slow 320→272ms。
     自己复算一遍这四个值（四舍五入到整数毫秒），--dur-progress-loop 是 indeterminate 循环，
     按不按 ×0.85 你判断并说明。
   - --focus-ring-w: 1px、--focus-ring-offset: 1px
   - --row-h: 38px（macOS 40）、--control-h-sm/-md 各 −2px
   - --titlebar-h: 32px，**没有 --titlebar-inset-left**（那是给红绿灯留位的，Windows 不需要），
     改为左侧 12px 放应用名所需的 token
   - **浅色层级不跟随 macOS 覆盖**：DESIGN.md 第 5 节 Windows 行明写「使用 Fluent/Mica 的
     平台浅色层级，不跟随 macOS 覆盖」。macos/tokens.css 的浅色段用的是
     base #f3f4f6 / surface #fbfbfc / elevated #fff / inset #eef0f2 与边框 #dfe1e6/#d2d4db/#b7bac4
     这套 macOS 专属覆盖——**Windows 应回到 DESIGN.md 第 2.2 节的基准浅色值**。
     去读 DESIGN.md 2.2 与第 5 节两处，判断基准值与 macOS 覆盖值到底哪些不同，
     把你的判断依据写进 kept_different。判不准就写 open_questions，**不要瞎抄一套**。
2. **必须带过去的第一批成果**：--text-tertiary 深浅两套的 4.5:1 合规值。
   去 macos/tokens.css 看深色 #828490（对 surface 4.77 / base 5.07）与浅色的合规值，
   Windows 的浅色基准背景若与 macOS 不同，**要自己重算对比度**而不是照抄
   （公式 (L1+0.05)/(L2+0.05)，相对亮度按 WCAG；12px 不能豁免 4.5:1，
   豁免线是 18.66px bold / 24px regular）。用 python3 算，把算式与结果写进 ported。
3. **必须带过去的第四批成果**：--dur-slow token（值按 ×0.85）。
4. **主题三态的落地方式两侧一致**：深色在裸 :root，浅色在
   @media (prefers-color-scheme: light) 内的 :root:not([data-theme="dark"]) **与**
   :root[data-theme="light"] 两处重复定义。缺一处就有一种组合失效。
   macos/tokens.css 顶部注释解释了这个设计，去读一遍。
5. **global.css**：把第四批补的 @keyframes 与工具类、reduced-motion 精细化分支带过来。
   Windows 特有的必须改：
   - 滚动条 **8px 常显**，thumb var(--border-strong) var(--radius-full)
     （macOS 是 ::-webkit-scrollbar{width:0} 隐藏）。
   - 字重补偿：正文 --fw-regular，中文标题用 --fw-semibold（Segoe 视觉偏细）。
   @keyframes 只允许存在于 global.css 与 CommandPalette/Dialog/Spinner 三处，与 macOS 同纪律。
6. 改完跑门禁：python3 ${ROOT}/tools/token-parity.py ${ROOT}
   它校验：token 名集合必须一致；深色色值/字号/间距/阴影/层级必须一致；
   第 5 节允许差异的维度（圆角、字体、动效、焦点环、控件密度、标题栏高、--sidebar-bg、
   浅色的背景层与边框）只报告不判违规。
   **改动前基线 47 项违规，你的目标是 0。** 达不到 0 的项逐条说明原因写进 open_questions
   ——尤其注意它对「浅色层级」的判定：accent、violet、语义色、文字色**不在**平台差异表里，
   两侧必须一致，只有背景四层与边框三档允许不同。如果你认为工具的白名单划错了，
   **不要改工具**（它不在你名下），把理由写进 open_questions。
   把完整输出与最终违规数写进 ported。`, { label: 'win:tokens', phase: 'Base', schema: FIX_SCHEMA }),

  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

你的角色：win-shell（状态层）。你名下只有这三个文件——
  ${WIN}/store/ui.ts（**新建，Windows 侧完全缺失**）
  ${WIN}/store/index.ts
  ${WIN}/store/nav.ts
（styles/** 由另一个 agent 同时在改，你不要碰；macOS 侧一律只读。）

任务：

1. **新建 store/ui.ts**。这是 Windows 端唯一的存在性缺失——「界面大小 标准/大/特大 三档」
   功能在 Windows 上整个不存在。
   先读 ${MAC}/store/ui.ts 全文，**逐字移植**（localStorage 键名 claude1.desktop.density
   必须一致，body zoom 100% / 112.5% / 125% 三档也一致）。
   这个 store 里如果有 macOS 专属的东西（比如 vibrancy 相关），才需要调整——先确认有没有。
2. **store/index.ts 与 store/nav.ts 追平**。diff 后逐 hunk 判断。
   - **CONTRACT.md 第 6.2 节钉死的 AppState / NavState 形状必须两侧逐字一致**，
     一个字段都不许有差异。diff 里任何字段级差异都是要追平的 bug，不是平台差异。
   - 2026-08-19 那轮的「refreshView 数组口径」「空态门控 loadedKeys」修复要确认都在。
   - 第五批新建的 store/toast.ts 归**另一个 agent**（win:shell-rest）移植，你不要建。
   - 如果 nav.ts 里有快捷键相关的状态（比如 paletteOpen），状态本身两侧一致，
     **键位差异在 keyboard.ts 里体现**，不在 store 里。
3. 移植完把 ${MAC}/store 与 ${WIN}/store 的文件清单对照一遍（除 toast.ts 归别人），
   确认没有遗漏文件。把清单写进 ported。`, { label: 'win:store', phase: 'Base', schema: FIX_SCHEMA }),
])

log(`Base 完成 ${base.filter(Boolean).length}/2`)

const BASE_NOTE = `【上一阶段已完成】
${WIN}/styles/tokens.css 与 global.css 已按 DESIGN.md 重新生成（含 Windows 的圆角、字体、
动效 ×0.85、焦点环 1px、行高 38px、不透明 --sidebar-bg、常显滚动条）；
${WIN}/store/ui.ts 已新建，store/index.ts 与 nav.ts 已追平。
**动手前先读 ${WIN}/styles/tokens.css**，拿准 Windows 侧 token 的实际值——
不要假设它和 macOS 一样。特别是动效时长（×0.85 后不是 80/140/220/320）、圆角、行高。
Base 阶段的自述：
tokens → ${JSON.stringify(base[0]?.ported ?? [], null, 1)}
store  → ${JSON.stringify(base[1]?.ported ?? [], null, 1)}`

phase('Port')
const ported = await parallel([
  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

${BASE_NOTE}

你的角色：win-shell（标题栏）。你名下只有两个文件——
  ${WIN}/shell/TitleBar.tsx
  ${WIN}/shell/TitleBar.module.css
（shell/ 下其他文件归别人，别碰。）

**这是差异最大且差异最应当存在的一块**——DESIGN.md 第 5 节明写 Windows 用系统窗口控件在右侧、
与 macOS 左侧红绿灯的布局镜像，「这部分**允许且应当**存在差异」。
所以你的任务不是把它改成和 macOS 一样，而是：**确认 Windows 的实现符合第 5 节 Windows 列，
并把 macOS 侧非平台性的改进（动效语义、五态、focus 可见性、文案）带过来**。

1. 逐条核对 Windows 标题栏是否符合第 5 节：
   - decorations: false 自绘，高 32px（token 是 --titlebar-h）
   - 右侧自绘 最小化 / 最大化 / 关闭，尺寸 46×32，close 的 hover 背景 #c42b1c 配白色图标
     （**这个 #c42b1c 是 Windows 平台规定色，是第 5 节明文给的值，不算"自创色值"**；
     但它应该以 token 形式落在 tokens.css 里还是内联？tokens.css 归别人，
     所以如果它还没有 token，你在 open_questions 里提出来，本轮先按现状处理）
   - 左侧 12px 放应用名
   - data-tauri-drag-region 覆盖整条，但**排除自绘按钮区**（否则拖拽会吞掉按钮点击）
2. 把 macOS 侧的非平台性改进带过来：
   - 第四批的时长语义与五态（hover/active/focus-visible/disabled）。
     窗口按钮的 hover 属 instant，按下属 fast——按 Windows 的 ×0.85 值。
   - focus-visible 必须可见，焦点环用 Windows 的 1px/offset 1px。绝不 outline: none。
   - 三个窗口按钮必须有 aria-label（中文，「最小化」「最大化」「关闭」）。
3. macOS 侧有主题快切 IconButton（太阳/月亮，显示「点它会变成什么」）——
   DESIGN.md 第 3 节说 TitleBar 右侧放这个。Windows 右侧被窗口按钮占了，
   放在窗口按钮**左边**还是移到别处？看 macOS 的实现与第 3 节原文，给一个结论并实现，
   理由写进 kept_different。`, { label: 'win:titlebar', phase: 'Port', schema: FIX_SCHEMA }),

  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

${BASE_NOTE}

你的角色：win-shell（命令面板与键盘）。你名下只有这三个文件——
  ${WIN}/shell/CommandPalette.tsx
  ${WIN}/shell/CommandPalette.module.css
  ${WIN}/shell/keyboard.ts
（shell/ 下其他文件归别人，别碰。）

**这是 diff 最大的一块（改动前 365 行差异，第五批后更多）**，但差异**几乎全是 macOS 领先**，
不是平台差异。macOS 侧的面板有四个分组共 28+ 个动作（导航七视图、渠道启动/隐藏/别名/
模型覆盖、槽位绑定/清除/启动、主题切换、用量时间窗与粒度、刷新、体检、打开日志目录、
Finder 显示配置、折叠侧栏），第五批又补了界面大小三档、复制诊断报告、最近使用分组。

1. 先 diff 两侧 CommandPalette.tsx，把 macOS 的动作、分组、mode 嵌套（root/channel/slot）、
   模糊匹配、高亮、键盘导航**全部追平**。
2. 平台差异**只有快捷键的显示与检测**：
   - 显示文案：⌘K → Ctrl+K、⌘, → Ctrl+,、⌘R → Ctrl+R、⌥⌘I → Ctrl+Shift+I
   - 检测：event.metaKey → event.ctrlKey
   - 面板里显示快捷键提示的地方全部同步。
   **除此之外的任何文案差异都是 bug**（CONTRACT 要求文案两侧逐字一致）。
3. keyboard.ts：macOS 侧已有 ⌘K / ⌘, / ⌘R / ⌘B / ⌘1–⌘7。Windows 全部对应到 Ctrl。
   - macOS 侧的守卫是「只认 Command，且不与 Control/Option 组合」；
     Windows 侧应改为「只认 Ctrl，且不与 Alt 组合」——**但要想清楚 Shift**：
     Ctrl+Shift+I 是开发者工具，第 5 节列了它。你的守卫不能把带 Shift 的组合全挡掉，
     也不能把系统组合抢走。给一个明确策略并写进 kept_different。
   - Ctrl+R 的 preventDefault **必须保留**（否则 WebView 整页重载）。
   - 复制诊断报告如果在 macOS 侧绑了快捷键，Windows 对应过来；没绑就不要自己发明。
4. 第五批新增的**复制诊断报告**必须过 redactSecrets（fail-closed 边界）。
   移植时确认这条没被弱化。
5. 动效时长用 Windows 的 ×0.85 值（面板入场在 macOS 属 --dur-slow 320ms，
   Windows 是 272ms——直接用 var(--dur-slow) 就自动是 Windows 的值，不要写死数字）。`,
    { label: 'win:palette', phase: 'Port', schema: FIX_SCHEMA }),

  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

${BASE_NOTE}

你的角色：win-shell（外壳其余 + 应用根）。你名下的文件——
  ${WIN}/shell/Sidebar.tsx 与 Sidebar.module.css
  ${WIN}/shell/StatusBar.tsx 与 StatusBar.module.css
  ${WIN}/shell/ViewHeader.tsx 与 ViewHeader.module.css
  ${WIN}/shell/RouteProgress.tsx 与 RouteProgress.module.css
  ${WIN}/shell/views.ts
  ${WIN}/shell/announce.ts（如果 Windows 侧在 shell 下；macOS 侧在 store/，按实际位置对齐）
  ${WIN}/shell/ToastHost.tsx 与 ToastHost.module.css（**第五批新建，Windows 需要新建**）
  ${WIN}/store/toast.ts（**第五批新建，Windows 需要新建**）
  ${WIN}/App.tsx、${WIN}/App.module.css、${WIN}/main.tsx
（TitleBar.* 与 CommandPalette.* / keyboard.ts 归别人，别碰。
 styles/**、store/index.ts、store/nav.ts、store/ui.ts 已完成，别碰。）

1. **Sidebar**（改动前 68 行 CSS 差异）：追平 macOS 的结构与第四批的折叠态动效。
   平台差异：Windows 的 --sidebar-bg 是**不透明色**、无 blur（Base 阶段已在 tokens 里落好，
   你直接用 var(--sidebar-bg)，**不要写 backdrop-filter**）。
   控件密度按第 5 节 −2px。
2. **shell/views.ts**（改动前 46 行差异）：这里有 2026-08-19 修的「refreshView 数组口径」，
   必须追平。视图路由表的七个路径与目录名两侧必须逐字一致（CONTRACT 6.1 节钉死）。
3. **store/toast.ts + shell/ToastHost.tsx**：第五批新建，Windows 侧完全缺失，逐字移植。
   - **入口 redactSecrets 必须保留**（fail-closed 边界）。
   - 不许进 AppState / NavState。
   - 入场动效用 Windows 的时长 token（var(--dur-normal) 自动是 187ms）。
   - reduced-motion 下退化为无位移。
4. **App.tsx**：挂载 ToastHost；追平第四批的视图切换动效（view-enter 关键帧）。
5. **StatusBar / ViewHeader / RouteProgress**：追平第二批的边框承重归位
   （独立容器外轮廓用 --border-default；容器内部行间分隔线才用 --border-subtle）。
   注意 DESIGN.md 第 2.2.1 节记了一条**规则未覆盖的缺口**：Sidebar 的 border-right、
   ViewHeader 的 border-bottom、StatusBar 的 border-top 这三条外壳骨架线
   **按现规则保持 subtle**（macOS 侧曾改成 default 并已回退）。
   **Windows 侧照 macOS 现状来——保持 subtle，不要"顺手升级"。** 去读 2.2.1 节原文确认。
6. RouteProgress 的 --dur-progress-loop 按 Base 阶段的决定处理，不要自己另定。`,
    { label: 'win:shell-rest', phase: 'Port', schema: FIX_SCHEMA }),

  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

${BASE_NOTE}

你的角色：win-shell（组件原语）。你名下的路径——
  ${WIN}/components/**（含 charts/）
  ${WIN}/lib/**
（shell/**、views/**、store/**、styles/** 一律不许动。）

任务：逐个组件 diff 并追平。改动前差异较大的有 Switch.module.css 24、Button.module.css 24、
charts/BarChart.tsx 27、SearchInput.module.css 20、Select.module.css 15、Input.module.css 13、
Table.module.css 12——但前几批改完后差异会更大，自己 diff。

必须带过去的成果：
1. **第二批边框承重**：Card、CodeBlock 等独立容器外轮廓用 --border-default，
   容器内部行间分隔线用 --border-subtle。
2. **第三批表格**（Table.tsx + Table.module.css，这是重点）：
   外框 1px var(--border-default) + 圆角、可退的 framed prop（默认 true）、
   sticky 操作列**完全不透明**背景（--sticky-action-bg 单点提供，非当前行 --bg-base、
   当前行 --bg-selected-table-solid）、左侧分隔线用 **box-shadow: inset 1px 0 0
   var(--border-subtle)（不是 border-left——collapse 模式下 border 横滚时不跟着 sticky 走）**、
   渐变遮罩伪元素 right: 100%、模型列中截断 MidTruncate（双 span 保尾部日期，
   **不是**整格 ellipsis，且要一并进 windows 的 components/index.ts 桶导出）、
   hasColgroup() 自动判定 table-layout、
   **.table thead th.align-* 的高特异性覆盖**（漏了它 <Th numeric> 在 Windows 侧会全部失效）。
   DESIGN.md 第 4.1.1 节是规范，先读。
3. **第五批表格键盘导航**：↑↓ 移动行、Enter 触发主操作、roving tabindex、
   aria-selected、左侧 accent 竖条主标识。新 prop 必须是纯可选、向后兼容。
4. **第四批五态与时长语义**：hover/active/selected/focus-visible/disabled 五态齐全，
   时长按语义选 token（不写死毫秒数，用 var(--dur-*)，Windows 的值自动 ×0.85）。
   焦点环用 Windows 的 --focus-ring-w 1px / --focus-ring-offset 1px。绝不 outline: none。
5. **第四批 tabular-nums**：数值展示一律 font-variant-numeric: tabular-nums。
6. **图表 sr-only 数据表**（2026-08-19 那轮的成果）：charts/ 下每个图表都要有
   屏幕阅读器可读的数据表兜底。确认 Windows 侧有。
7. **Icon 统一线宽 1.5px / 20px 栅格**（第四批），用 var(--stroke-w) 与 var(--icon-size)。

平台差异**只有**：控件密度（行高 38、按钮高 −2px，已在 token 里）、圆角（token 里）、
焦点环（token 里）、字体（token 里）。
也就是说组件 CSS 里**几乎不该出现平台条件分支**——差异都由 token 承担。
如果你发现某处必须写平台专属样式（比如滚动条），说明理由并写进 kept_different。`,
    { label: 'win:components', phase: 'Port', schema: FIX_SCHEMA }),

  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

${BASE_NOTE}

你的角色：win-views（渠道 + 槽位）。你名下的路径——
  ${WIN}/views/channels/**
  ${WIN}/views/slots/**
（其他 views/**、components/**、shell/**、store/**、styles/** 一律不许动。）

任务：diff 并追平。改动前 views/channels/index.tsx 54 行、index.module.css 21 行、
parts/ChannelRow.module.css 27 行、views/slots/index.tsx 23 行、
parts/SlotRow.module.css 31 行差异，前几批改完后更大，自己 diff。

必须带过去的成果：
1. **第三批渠道表**：<colgroup> 七列宽度声明（协议 160 / 备注 min 160 max 256，
   **不是 96/320**）、模型列中截断（保留尾部日期）、备注列两行 -webkit-line-clamp 截断、
   sticky 操作列**完全不透明**背景（只覆盖 --sticky-action-bg 变量，当前行用
   --bg-selected-table-solid）、已隐藏分区行与详情行背景不透明。
   规范在 DESIGN.md 第 4.1.1 节，先读。**列宽用 token（--table-col-*），不写死 px。**
2. **第二批**：.toolbar 这类独立面板外轮廓用 --border-default。
3. **第四批**：时长语义（用 var(--dur-*) 不写死毫秒）、五态、tabular-nums。
4. **第五批**：空态/加载态/错误态三件套，空态走 store 的 loadedKeys 门控
   （空态只在 loadedKeys[key]===true 且数据为空时出现），空态文案给下一步动作。
   错误态把 error[key] **原文**照摆 + 一行「这通常意味着什么」，**不许伪装成「网络繁忙」**。
5. **文案两侧逐字一致**——除了快捷键显示（⌘K → Ctrl+K）。
   空态文案里如果提到 ⌘K，Windows 要改成 Ctrl+K。这是**唯一**允许的文案差异。
6. SlotRow.tsx 的局部成功反馈：macOS 第五批明确**没有**用 toast 替换它，
   Windows 照 macOS 现状来，不要自己替换。`,
    { label: 'win:views-a', phase: 'Port', schema: FIX_SCHEMA }),

  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

${BASE_NOTE}

你的角色：win-views（观测 + 运维）。你名下的路径——
  ${WIN}/views/usage/**
  ${WIN}/views/diagnostics/**
  ${WIN}/views/accounts/**
  ${WIN}/views/doctor/**
  ${WIN}/views/settings/**
（views/channels、views/slots、components/**、shell/**、store/**、styles/** 一律不许动。）

任务：diff 并追平。改动前 views/diagnostics/index.tsx 43 行、views/doctor/index.tsx 34 行、
views/settings/index.tsx 21 行、diagnostics/parts/aggregate.ts 12 行、
settings/parts/PathRow.tsx 10 行差异，前几批改完后更大，自己 diff。

必须带过去的成果：
1. **第五批诊断视图分段**（这是本路最大的一块）：sticky 小节头（背景必须不透明）、
   锚点导航或顶部 SegmentedControl、回到顶部、单段 ≤ 2 屏、长表格的分页或虚拟滚动。
   规范在 DESIGN.md 第 4.6 节（或 spec 放的位置），先读。
2. **第五批降级码呈现**（DESIGN.md 4.4 节）：中文标题 + 右侧 --fs-11 mono --text-tertiary 原码、
   展开三段（发生了什么 / 对你的影响 / 建议动作）、严重度**三重编码**（颜色 + 图形 + 文字）、
   同回合多码折叠成「+N」。SEVERITY_TONE 单点化（2026-08-19 成果）要在。
3. **第二批**：doctor 两处列表外框、KpiRow 两处、settings PathRow 取值框
   → 独立容器外轮廓用 --border-default。
   **另外**：accounts 的 PoolCard 与 diagnostics 的出现记录副表都是 <Table> 套在 <Card> 里，
   macOS 侧给它们传了 framed={false}（卡片已经画了一条 1px，表格再画一条会成两条同色线
   贴在一起）。Windows 侧同样要传。见 DESIGN.md 第 2.2.1 节第 2 条的例外说明。
4. **第四批**：时长语义、五态、**tabular-nums（本路数值最密集：用量 KPI、token 计数、
   百分比、耗时，逐个确认）**。
5. **第五批三件套**：空态/加载态/错误态，走 loadedKeys 门控，错误原文照摆不伪装。
6. **图表配色**按 DESIGN.md 4.2 节（同图最多 3 色，输入=青 / 输出=紫 / 缓存=灰），
   两侧一致。sr-only 数据表兜底要在。
7. **settings 的「外观」区**：界面大小三档（Base 阶段刚建的 store/ui.ts 提供）
   在 Windows 侧原本**整个不存在**——这里要把 UI 补上，不只是 store。
   三档 body zoom 100% / 112.5% / 125%，localStorage 键 claude1.desktop.density。
8. 文案两侧逐字一致，只有快捷键显示可以不同。`,
    { label: 'win:views-b', phase: 'Port', schema: FIX_SCHEMA }),

  () => agent(`${PREAMBLE}

${PLATFORM_TABLE}

${BASE_NOTE}

你的角色：win-shell（数据与类型层）。你名下的路径——
  ${WIN}/data/**
  ${WIN}/api/**
  ${WIN}/types/**
  ${WIN}/lib/**（如果 win:components 没占；两边都涉及 lib 时以 components agent 为先，
    你只在 lib 下确实有你独占的文件时才动，不确定就跳过并写进 open_questions）
（components/**、shell/**、views/**、store/**、styles/** 一律不许动。）

任务：

1. **data/degradeCatalog.ts**（改动前 18 行差异，第五批文案审定后更多）：
   **必须与 macOS 侧逐字一致**——文件顶部注释明写「内容由编排者审定，不要在移植时改写措辞
   ——两个平台工程必须逐字一致」。
   第五批对 36 个码的文案做了审定与补齐，全部照搬。
   **一个标点都不要改。** 唯一例外：文案里如果出现 ⌘ 快捷键，改成 Ctrl。
   改完做一次严格比对：除快捷键外还有任何字符差异都要消除。把比对方法与结果写进 ported。
2. **types/contract.ts**：CONTRACT.md 第 2 节要求两侧**逐字相同**。
   diff 后任何差异都是 bug，全部追平。一个字段都不许有平台差异。
3. **api/**（含 mock.ts，改动前 18 行差异）：IPC 命令签名两侧一致（CONTRACT 第 3 节）。
   mock 数据两侧一致——mock 是离线兜底，数据不同会让两个平台的离线表现不一致。
   **redactSecrets 如果在 lib/ 里，确认它的实现两侧逐字一致**：这是 fail-closed 的
   凭证脱敏边界（CONTRACT 1.2 节），Windows 侧弱一分就是凭证泄漏风险。
4. 比对完给出一份清单：${MAC} 与 ${WIN} 下这几个目录的文件是否一一对应、有无遗漏。`,
    { label: 'win:data-api', phase: 'Port', schema: FIX_SCHEMA }),
])

log(`Port 完成 ${ported.filter(Boolean).length}/7 路`)

const VERIFY_PREAMBLE = `你在复核 ${ROOT} 下 Windows 端第六批（追平 macOS）的改动。

【你的立场是对抗式的】
默认改动**有问题**。不要采信任何 agent 的自述——自己 diff、自己 grep、自己数。
前面的批次抓到过 fix agent 在注释里伪造 DESIGN.md 章节引用，这类问题报 major 起。

【只读】不许修改任何文件。只 cat / diff / grep / python3 算数。

【本批的两类错误同样严重】
A. **追平不足**：macOS 的能力/修复没带过去 → 功能不一致。
B. **差异被抹平**：把 Windows 该有的平台差异改成了 macOS 的做法（给 Windows 加 vibrancy blur、
   把 Ctrl 改回 ⌘、用 macOS 的圆角/字体/行高）→ 平台体验错位。
两类都要找。判定唯一依据是 ${ROOT}/DESIGN.md 第 5 节平台差异表。

【判定尺度】
- blocker：CONTRACT 契约面两侧不一致、redactSecrets 被弱化、错误被伪装、
  文案非快捷键差异、存在性缺失（文件没建）、修饰键检测错（metaKey 留在 Windows 侧）、
  伪造文档引用、macOS 侧被改动。
- major：某批成果没带过去、平台差异应用错、差异被抹平。
- minor：注释缺失、命名不一致。
pass 只有在 violations 为空时才是 true。`

phase('Verify')
const verdicts = await parallel([
  () => agent(`${VERIFY_PREAMBLE}

${PLATFORM_TABLE}

你负责**追平完整性**。

1. 跑 diff -rq ${MAC} ${WIN}，拿到当前所有差异文件与存在性差异。
   - **存在性差异必须为 0**（改动前只有 store/ui.ts 缺失；第五批新增的 store/toast.ts、
     shell/ToastHost.tsx + .module.css 也必须在 Windows 侧存在）。
     任何 "Only in macos" 是 blocker，写进 detail。
     "Only in windows" 也要报——除非是 Windows 专属文件且有第 5 节依据。
   - 把差异文件总数与清单填进 measured。
2. 逐个差异文件跑 diff，把每个 hunk 分类：
   （a）平台差异，第 5 节白名单内 → 正确
   （b）macOS 领先、Windows 没跟 → **追平不足，major**
   （c）Windows 自己跑偏、macOS 没有的东西 → **major**
   文件多，按 diff 行数从大到小至少查到覆盖 80% 的差异行数为止，把已查/未查清单写进 notes。
   **不要谎称全查了**——查到哪写到哪。
3. 重点核对五批成果是否都在 Windows 侧（逐条给结论）：
   - 第一批：--text-tertiary 深浅两套都 ≥ 4.5:1。自己用 python3 按 WCAG 算一遍
     （公式 (L1+0.05)/(L2+0.05)），对 Windows 自己的 --bg-base 与 --bg-surface 算。
     算不过 4.5 是 major。
   - 第二批：跑 python3 ${ROOT}/tools/border-audit.py ${WIN}
     「疑似独立容器仍用 subtle」必须为 0。非 0 是 major。输出写进 measured。
   - 第三批：Table 外框、sticky 不透明（grep 有没有 rgba 半透明残留在 sticky 背景上）、
     渐变遮罩、模型列中截断（**不是** text-overflow: ellipsis）、colgroup。
   - 第四批：数 ${WIN} 下 var(--dur-fast) / var(--dur-normal) / var(--dur-slow) 出现次数
     与 @keyframes 总数，要求 fast ≥ 8、normal ≥ 8、@keyframes ≥ 8（与 macOS 同线）。填进 measured。
   - 第五批：诊断视图 sticky 小节头 + 锚点导航、命令面板三项新增（density / 复制诊断报告 /
     最近使用）、toast store、空态 loadedKeys 门控。
   - 2026-08-19 那轮：空态门控、refreshView 数组口径、命令面板动作补全、
     SEVERITY_TONE 单点化、图表 sr-only 数据表。`,
    { label: 'verify:win-parity', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

${PLATFORM_TABLE}

你负责**平台差异是否正确应用**——既查有没有漏应用，也查有没有被抹平。

逐项核对 ${WIN}，每项给明确结论：

1. **修饰键检测**：grep ${WIN} 下所有 metaKey。**Windows 侧不该有 metaKey**（应为 ctrlKey）。
   残留 metaKey 是 blocker（快捷键在 Windows 上直接失效）。
2. **快捷键显示文案**：grep ${WIN} 下的 ⌘ 与 ⌥ 符号。**不该有**，应为 Ctrl / Ctrl+Shift。
   残留是 blocker。同时反查 ${MAC} 下不该出现 "Ctrl+"（除注释说明平台差异）。
3. **背景材质**：grep ${WIN} 下的 backdrop-filter 与 blur(。
   **Windows 不做 blur 兜底**（第 5 节明文，性能差）。出现是 major（差异被抹平）。
   确认 --sidebar-bg 是**不透明色**（不是 rgba 带 alpha < 1）。带 alpha 是 major。
4. **圆角**：Windows 应为 --radius-sm:4px --radius-md:6px --radius-lg:8px。
   若等于 macOS 的 6/8/12 就是抹平，major。
5. **字体**：--font-ui 应含 "Segoe UI Variable Text"，--font-mono 应含 "Cascadia Code"。
   出现 -apple-system 或 "SF Mono" 是 major。
6. **动效 ×0.85**：Windows 的 --dur-instant / fast / normal / slow 应约为
   68 / 119 / 187 / 272ms。自己复算 80/140/220/320 各 ×0.85 并四舍五入，与实际值比。
   若等于 macOS 原值就是没应用，major。
   另外 grep 组件里有没有**写死毫秒数**而不是用 var(--dur-*)——写死会绕过 ×0.85，major。
7. **焦点环**：--focus-ring-w: 1px、--focus-ring-offset: 1px。等于 macOS 的 2px/2px 是 major。
   同时 grep 有没有 outline: none 且无替代可见焦点样式——有是 blocker。
8. **控件密度**：--row-h 应为 38px（macOS 40），控件高各 −2px。
9. **滚动条**：Windows 应 8px **常显**，thumb var(--border-strong) var(--radius-full)。
   若是 macOS 的 ::-webkit-scrollbar{width:0} 隐藏方案，major。
10. **标题栏**：高 32px、右侧自绘三按钮 46×32、close hover #c42b1c 白图标、左侧 12px 应用名、
    drag-region 排除按钮区。有 --titlebar-inset-left: 78px（macOS 给红绿灯留位的）残留是 major。
11. **字重补偿**：中文标题用 --fw-semibold（Segoe 视觉偏细）。
12. **浅色层级**：第 5 节明写 Windows「使用 Fluent/Mica 的平台浅色层级，不跟随 macOS 覆盖」。
    对比两侧浅色段的 --bg-base / surface / elevated / inset 与三档 border。
    如果 Windows 逐字照抄了 macOS 的覆盖值（base #f3f4f6 / surface #fbfbfc / inset #eef0f2 /
    border #dfe1e6,#d2d4db,#b7bac4），那要判断：这是遵循 DESIGN.md 2.2 节基准值，
    还是错误照搬 macOS 专属覆盖？**去读 DESIGN.md 2.2 与第 5 节两处原文再下结论**，
    把你的推理过程写进 notes——这一项判错会误伤，宁可标 notes 也不要乱报 major。
13. **跑 token 对等门禁**：python3 ${ROOT}/tools/token-parity.py ${ROOT}
    改动前基线 47 项违规。把完整输出与最终违规数写进 measured。
    非 0 是 major，逐条把违规写进 detail。
    注意这个工具的白名单本身也可能划错——如果某条违规你判断其实是第 5 节允许的差异，
    在 notes 里说明，不要因为工具报了就当铁证。反过来，工具没报但你发现的差异也要报。`,
    { label: 'verify:win-platform', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

你负责**契约、凭证边界与文案逐字一致**——本批最严重的错误都在你这里。

1. **CONTRACT 契约面两侧逐字一致**。
   diff ${MAC}/types/contract.ts ${WIN}/types/contract.ts —— **应当无差异**
   （CONTRACT.md 第 2 节要求两侧逐字相同）。任何差异是 blocker。
   diff 两侧 store/index.ts 与 store/nav.ts，对照 CONTRACT.md 第 6.2 节：
   AppState / NavState 的**字段**必须逐字一致（实现可以有平台差异，形状不行）。
   字段级差异是 blocker。
   diff 两侧 api/**：IPC 命令签名必须一致（第 3 节）。
2. **redactSecrets 边界**。
   找到两侧的 redactSecrets 实现（可能在 lib/ 下），diff 它们——**应当逐字一致**。
   Windows 侧弱一分就是凭证泄漏风险。差异是 blocker。
   再 grep Windows 侧所有文本展示入口：store/toast.ts、shell/ToastHost.tsx、
   store 或 shell 的 announce、命令面板的复制诊断报告、视图的错误详情。
   逐个确认文本在进入展示前过了 redactSecrets。漏一条是 blocker。
3. **错误不伪装**。grep ${WIN} 有没有「网络繁忙」「请稍后重试」「出错了」「系统异常」。
   有是 blocker。确认错误态展示 store 的 error[key] **原文**。
4. **文案逐字一致**。这是本批最容易出错的地方。
   - diff ${MAC}/data/degradeCatalog.ts ${WIN}/data/degradeCatalog.ts。
     **除快捷键符号外应无任何差异**（文件顶部注释明写「不要在移植时改写措辞——
     两个平台工程必须逐字一致」）。任何措辞差异是 blocker。
     数一下两侧各有多少个 HUB_DEGRADE_* 码，不等是 blocker。
   - 抽查视图层文案：对每个视图 diff 一遍，把所有中文字符串差异列出来，
     逐条判断是否属于「快捷键显示」这唯一合法差异。其他差异是 blocker。
5. **文案纪律**（两侧同标准）：grep ${WIN} 中文文案里的感叹号（！）、语气词（哦/啦/呢）、
   「暂无数据」。有是 major。
6. **macOS 侧未被改动**。本批 agent 只许改 ${WIN} 下的文件。
   检查 ${MAC} 下有没有被动过的痕迹——特别是 diff 结果里出现「Windows 领先」的地方，
   那可能意味着有人改了 macOS 侧。可疑处写进 notes；能确认是改了 macOS 侧的报 blocker。
7. **视图契约**：CONTRACT.md 6.1 节钉死七个视图的目录名与「默认导出无 props 组件」形式。
   确认 Windows 侧七个目录名与导出形式与 macOS 一致。`,
    { label: 'verify:win-contract', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

const all = verdicts.filter(Boolean).flatMap(v => v.violations ?? [])
const blockers = all.filter(x => x.severity === 'blocker')
const majors = all.filter(x => x.severity === 'major')
log(`复核完成：${verdicts.filter(Boolean).length}/3 返回，blocker ${blockers.length} / major ${majors.length}`)

return { batch: 6, base, ported, verdicts, blockers, majors }
