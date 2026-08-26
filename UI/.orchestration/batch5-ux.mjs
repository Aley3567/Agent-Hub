export const meta = {
  name: 'ui-batch5-ux',
  description: '第五批：诊断视图分段、命令面板补三项、最小 toast store、降级码人话、空态文案',
  phases: [
    { title: 'Spec', detail: 'DESIGN.md 补 toast 规范、分段规范、文案纪律' },
    { title: 'Fix', detail: '四路并行：降级文案 / 外壳(toast→面板) / 诊断分段 / 空态文案' },
    { title: 'Verify', detail: '三路独立复核' },
  ],
}

const ROOT = '/Users/admin/Desktop/claude-hub/UI'

const PREAMBLE = `你在改 ${ROOT} 下的 macOS 桌面端（Tauri v2 + React + TypeScript + CSS Modules，构建目标 safari15）。

【不可越界的硬约束】
1. 只改分配给你的文件路径，其他一个字都不许动。文件所有权见 ${ROOT}/CONTRACT.md 第 6 节。
2. **CONTRACT.md 第 6.2 节钉死的 AppState / NavState 形状一个字段都不许增删改**，第 2 节的
   TypeScript 数据类型、第 3 节 IPC 签名同样不可动。需要新状态就另开一个极小 store——
   工程里已有 store/ui.ts、store/announce.ts 两个先例，照它们的写法来。
3. **redactSecrets 是 fail-closed 的凭证脱敏边界，不可绕过**（CONTRACT.md 第 1.2 节）。
   任何新增的文本展示路径——toast、tooltip、复制内容、错误详情、播报——都必须先过它。
   store/announce.ts 的 announce() 就是范例：入口处 redactSecrets(text)。
4. **错误原样暴露，不伪装、不吞掉**（项目根 CLAUDE.md 硬规则）。上游错误原文照摆，
   前端只负责在原文**旁边**加一行「这通常意味着什么」。
   **禁止把上游 5xx 改写成「网络繁忙」「请稍后重试」这类话术。**
5. DESIGN.md 是唯一视觉真理来源。不允许自创色值、时长、间距、圆角，一律走 token。
6. 构建目标 safari15：不要用 :has()、容器查询、@property；-webkit-line-clamp 要配 display: -webkit-box。
7. 代码注释保持中文，与现有工程一致。

【禁止伪造证据】
注释里引用 DESIGN.md / CONTRACT.md 章节前，必须先 grep 确认该章节与措辞真实存在。
前面的批次抓到过 agent 自创名词再拿章节号给它背书，那比不写注释更有害。引用不到就不引用。

【禁止推翻已经做对的东西】
这个工程 2026-08-19 做过一轮 14 项修复，2026-08-20/21 做过前四批。你看到的很多东西
**已经是对的**。动手前先读，确认某个能力真的缺失再补——不要因为「原始需求文档说要补」
就去重复实现已存在的功能。原始需求文档的诊断已经被证伪过三次。

【报告要求】
最终文本就是返回值。按 schema 返回结构化数据，claims 里写实际做过的事与实测数字，
把「我核实后发现它本来就有、所以没动」也写进 claims——这类信息很有价值。`

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_changed', 'claims', 'already_correct', 'open_questions'],
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
    claims: { type: 'array', items: { type: 'string' } },
    already_correct: {
      type: 'array',
      items: { type: 'string' },
      description: '核实后发现本来就正确、因此没有改动的点。写清你是怎么核实的',
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

/* ── 现状基线（编排者 2026-08-21 逐项 grep 核实，**这是准确的，不要另起猜测**）──────
   命令面板 shell/CommandPalette.tsx：**已有**四个分组（nav / channel / slot / action）共 28 个
     动作——导航七视图、渠道启动会话、隐藏/取消隐藏、别名设置与清除、模型覆盖设置与清除、
     渠道管理入口、槽位设置/清除绑定/按槽位启动/绑到渠道+模型、主题切换、用量时间窗、
     用量分桶粒度、刷新当前视图、刷新全部数据、运行本机体检、打开日志目录、
     在 Finder 中显示配置文件、折叠/展开侧栏。已有 mode 嵌套（root / channel / slot）。
     **实测缺口只有三个**：界面大小三档（grep "density" 零命中，store/ui.ts 有状态但面板未接）、
     复制诊断报告（零命中）、最近使用分组（零命中）。
   快捷键 shell/keyboard.ts：**已有** ⌘K / ⌘, / ⌘R / ⌘B / ⌘1–⌘7 全部实现，且已处理
     「不与 Control/Option 组合」与 ⌘R 的 preventDefault（否则 WebView 整页重载）。
     **实测缺口只有**：表格内 ↑↓ 移动行 + Enter 触发主操作。
   toast：全工程只有 views/slots/parts/SlotRow.tsx:32 一处局部实现，注释写着「不做 toast 队列」。
     styles/global.css:178 已有 z-index: var(--z-toast) 的层，tokens.css:128 有 --z-toast: 400。
     **即层已备好、store 与组件缺失**。
   播报 store/announce.ts：**已有** redactSecrets 兜底脱敏，是 fail-closed 边界的范例。
   降级目录 data/degradeCatalog.ts：**结构已完备**——DegradeEntry 已有 code/title/what/impact/
     action/severity 六字段，即 DESIGN.md 4.4 节要求的「发生了什么 / 对你的影响 / 建议动作」
     三段已经落在类型里；已有 SEVERITY_ORDER 与 SEVERITY_LABEL。共 36 个 HUB_DEGRADE_* 码。
     **缺口是文案质量与覆盖完整性，不是结构。**
   诊断视图 views/diagnostics/index.tsx（455 行）：滚动容器 scrollHeight 3744px、clientHeight 683px，
     5.5 屏连续长页，无 sticky 小节头、无锚点跳转、无回到顶部。**这是真缺口。**
   空态门控：store 已有 loadedKeys 机制（CONTRACT.md 6.2 节：空态只准在 loadedKeys[key]===true
     且数据为空时出现）。**沿用它，不要新造标志位。**
   ──────────────────────────────────────────────────────────────────────────── */

const COPY_RULES = `【文案纪律（DESIGN.md 与项目根 CLAUDE.md 的硬规则）】
1. 全站中文文案统一为**陈述句**，无感叹号，不用「哦 / 啦 / 呢」这类语气词。
2. 推广已被验证好用的句式：「标签：解释」，例如「隐藏：普通列表不再列出它」。
3. 空态文案给**下一步动作**而不是描述现状。不写「暂无数据」，写「还没有渠道，按 ⌘K 添加」。
   每个空态 = 一行说明「为什么空」+ 一个可执行动作。
4. 错误文案**绝不伪装**：上游错误原文照摆，旁边加一行「这通常意味着什么」。
   禁止「网络繁忙」「出错了，请重试」这类抹掉信息的话术。
5. 播报文案要能被读屏完整念出：避免纯符号、避免依赖颜色表意（「绿色」→「正常」）。
6. 技术标识符（渠道名、模型 id、token 计数、降级码、端口号）一律 mono 字体。`

phase('Spec')
const spec = await agent(`${PREAMBLE}

你的角色：spec。你名下只有一个文件——
  ${ROOT}/DESIGN.md
（degradeCatalog.ts 归另一个 agent，代码一律不许动。）

**动手前先把上面基线里提到的文件都读一遍**，确认基线描述与代码一致。基线由编排者实测，
但你要自己验一遍；如果发现基线有错，写进 open_questions 并按实际情况调整规范。

任务：补三处规范。

1. **新增「4.5 反馈与 toast」小节**。现在全工程只有 SlotRow 一处局部成功反馈，
   而 --z-toast: 400 与 global.css 的 toast 层已经存在。规范要写清：
   - 最小实现：成功 / 失败两态，3 秒自动消失，可手动关闭。不做队列优先级、不做撤销。
   - 位置与层级：用 var(--z-toast)，具体落位（右下 / 底部居中）你定一个并写死。
   - 视觉：var(--bg-elevated) + var(--border-default) + var(--shadow-lg)（浮层三件套，
     与 DESIGN.md 2.2.1 节的浮层规则一致——先 grep 确认那条规则的原文再引用）。
   - 动效：入场属 --dur-normal（第四批刚定的语义表在 2.5 节，去读）。
   - **文本入口必须过 redactSecrets**，写成硬规则。
   - 哪三类操作走它：复制、启动会话、保存设置。
   - 与 announce.ts 的关系：toast 是视觉反馈，announce 是读屏播报，**两者并存不互相替代**，
     同一件事要同时走。这一条很重要，写清楚。
2. **新增「4.6 长视图的分段」小节**（或并入 3 节布局，你判断哪里更合适）。
   针对诊断视图 3744px / 5.5 屏的问题定规范：
   - sticky 小节头（用 var(--z-sticky)），滚动时钉在内容区顶部。
   - 右侧锚点导航或顶部 SegmentedControl 二选一，你定一个并说明理由。
   - 单段最大高度目标：≤ 2 屏（约 1400px）。超了就该再分或分页。
   - 回到顶部的可发现方式。
   - 长表格分页或虚拟滚动的取舍：这个工程的数据量级（诊断项、错误行）用分页还是虚拟滚动？
     给一个结论，别两个都留。
3. **4.3 命令面板小节补充**：把「界面大小三档」「复制诊断报告」「最近使用分组」三项写进
   动作清单。**注意 4.3 节现有内容描述的能力大部分已实现**，你是补充而不是重写；
   补充时明确写出「已实现」与「本批新增」的分界，让下一轮重构者不会重复实现。
   最近使用的规范要写清：存几条、存在哪（localStorage 键名照 claude1.desktop.* 的现有约定，
   去 grep 确认约定原文）、怎么排序、要不要跨会话保留。
4. **4.4 降级码呈现小节核对**：现在 degradeCatalog.ts 的 DegradeEntry 已有 what/impact/action
   三段，与 4.4 节要求一致。核对 4.4 节写的严重度颜色映射（info=灰点 / notice=青点 /
   degraded=琥珀点 / lossy=琥珀点+粗体标题）与代码里的 SEVERITY_TONE 是否一致，
   不一致的以代码为准还是以文档为准由你判断，但**必须消除不一致**并在 claims 里说明改了哪边。
5. 文案纪律：把下面这套规则收进 DESIGN.md 的一个明确位置（新增 2.6 或放进第 6 节可达性旁），
   让它成为可引用的条文——后续批次和 Windows 移植都要引用它。

${COPY_RULES}`, { label: 'spec:design', phase: 'Spec', schema: FIX_SCHEMA })

log(`spec 完成，改动 ${spec?.files_changed?.length ?? 0} 处，核实已正确 ${spec?.already_correct?.length ?? 0} 项`)

const NO_REGRESS = `【不许回退前面批次的成果】
第三批（表格，已完成并经三路复核 + 编排者修复）——动它们只准做加法：
  · 外框 1px var(--border-default) + var(--radius-md) 落在 .scroll 包裹层；framed prop 默认
    true，**Card 内必须传 framed={false}**（views/accounts/parts/PoolCard.tsx 与
    views/diagnostics/index.tsx 两处已传，删掉会出现两条同色 1px 线）。
  · sticky 操作列底色由 --sticky-action-bg 单点提供，非当前行 --bg-base、当前行
    --bg-selected-table-solid，**必须完全不透明**。
  · 左侧分隔线是 **box-shadow: inset 1px 0 0 var(--border-subtle)，不是 border-left**
    ——.table 是 border-collapse: collapse，合并模式下边框归 table 的 border grid 绘制、
    横滚时不跟着钉住的列走。**不许改回 border-left。**
  · 渐变遮罩 .stickyAction::before，right: 100%。
  · 中截断 MidTruncate 双 span（头段 ellipsis、尾段 nowrap，tail=8 保住日期戳），
    已进 components/index.ts 桶导出。**不许换成整格 ellipsis。**
  · table-layout 由 hasColgroup() 自动判定；四张无 colgroup 的表保持 auto。
  · **.table thead th.align-* 的高特异性覆盖不许删**——表头分组规则的 text-align: left
    特异性 (0,1,2) 会压死 .align-*，删了 <Th numeric> / <Th align> 全部失效。
  · <colgroup> 七列走 --table-col-* token：88/150/**160**/240/104/(160~**256** flex)/132。
    **协议列 160、备注 max 256**（原 96/320——96 连 anthropic 都硬裁，是切 fixed 才暴露的
    回退，已从备注上限匀出 64px）。
  规范在 DESIGN.md 第 4.1.1 节（含预算表、fixed 布局的教训、stickyHeader 空转的已知缺口）。
第四批（动效）：时长语义映射（instant 仅 hover 变色 / fast 按下拨动选中 / normal 面板入场与
  视图切换 / slow 命令面板与首屏浮现，上限 320ms）、只用 --ease-out 与 --ease-in-out 两条曲线、
  @keyframes 只允许存在于 global.css 与 CommandPalette/Dialog/Spinner 三处、
  reduced-motion 分支、五态定义、tabular-nums。规范在 DESIGN.md 第 2.4 / 2.5 节。
你新增的任何过渡与动画都要落进这套语义，**不许新造 @keyframes、不许新增缓动曲线**。
需要动画就用 global.css 已提供的关键帧与工具类。`

const FIX_COMMON = `${COPY_RULES}

${NO_REGRESS}

【工作方法】
1. 先读你名下的全部文件，再读 DESIGN.md 里 spec 刚写的相关小节（4.3 / 4.4 / 4.5 / 4.6 与文案纪律）。
2. 核实基线：某个能力是不是真的缺失？grep 确认后再写代码。发现「本来就有」的写进 already_correct。
3. 只改自己名下的路径。需要别人的能力就按现有类型 import，不去改它。`

phase('Fix')
const fixes = await parallel([
  // ── 路 A：降级码文案 ──────────────────────────────────────────────
  () => agent(`${PREAMBLE}

你的角色：文案审定（编排者域）。你名下只有一个文件——
  ${ROOT}/macos/src/data/degradeCatalog.ts
（DESIGN.md 归 spec，其他代码一律不许动。）

**这个文件的结构已经完备**：DegradeEntry 有 code/title/what/impact/action/severity 六字段，
SEVERITY_ORDER 与 SEVERITY_LABEL 都在，共 36 个 HUB_DEGRADE_* 码。
所以你的任务**不是建结构，是审文案**。

1. 逐条读完 36 个码的 title / what / impact / action，按文案纪律逐条审：
   - title 是人话中文短语，不是码的音译。
   - what 说「发生了什么」，一句话，陈述句。
   - impact 说「对你的影响」，要具体（少了什么、会不会影响钱/可复现性/原始证据）。
   - action 说「建议动作」，必须是**可执行的**——「检查配置」不算，「去渠道视图把 X 改成 Y」算。
     如果某个码真的不需要用户做任何事（severity=info），action 就明确写「不用处理」，
     不要编一个假动作。
2. 核对严重度分级是否与文件顶部注释的口径一致（info=纯噪音过滤 / notice=语义等价映射 /
   degraded=确实少了东西但结果可用 / lossy=少掉的你会在意：钱、可复现性或原始证据）。
   分错档的改过来，并在 claims 里逐条列出改了哪些码、从什么改到什么、依据是什么。
3. 覆盖完整性：去仓库根找协议桥实际会发出的降级码
   （grep -rn "HUB_DEGRADE" /Users/admin/Desktop/claude-hub --include=*.py | 看有哪些码），
   与本文件的 36 个对照。**目录里缺的码要补齐**——缺了码，界面就只能显示原始机器码。
   多出来的（代码里已不再发出的）不要删，标注一下即可，删了可能影响历史数据的展示。
4. 措辞纪律：文件顶部注释写着「内容由编排者审定，不要在移植时改写措辞——两个平台工程
   必须逐字一致」。你改完之后 Windows 侧要逐字同步（第六批的事），所以**措辞要一次定稳**。
5. 禁止伪装错误：任何 what/impact 里都不许把上游故障说成「网络波动」之类。

${FIX_COMMON}`, { label: 'fix:degrade-copy', phase: 'Fix', schema: FIX_SCHEMA }),

  // ── 路 B：外壳（toast → 命令面板），内部串行 ────────────────────
  async () => {
    const toast = await agent(`${PREAMBLE}

你的角色：mac-shell（第一步：toast）。你名下的路径——
  ${ROOT}/macos/src/store/**（新建 store/toast.ts）
  ${ROOT}/macos/src/shell/**（新建 ToastHost.tsx + ToastHost.module.css）
  ${ROOT}/macos/src/App.tsx（挂载 ToastHost）
（components/**、styles/**、views/** 一律不许动。）

先读 ${ROOT}/DESIGN.md 的 4.5 节（spec 刚写的 toast 规范）与 ${ROOT}/macos/src/store/announce.ts
（它是「极小 store + redactSecrets 入口」的范例，照它的形状写）。

任务：补最小 toast 机制。

1. store/toast.ts：zustand 极小 store，仿 announce.ts 的写法。
   - 两态：success / error。
   - 3 秒自动消失，可手动关闭。定时器要能被新 toast 重置，组件卸载时清掉。
   - **入口处必须 redactSecrets(text)**——这是 fail-closed 边界，和 announce.ts 一样。
   - **不许进 AppState / NavState**（CONTRACT.md 6.2 节钉死）。
2. shell/ToastHost.tsx + .module.css：渲染层。
   - 用 var(--z-toast)、var(--bg-elevated)、var(--border-default)、var(--shadow-lg)。
   - 入场动效用 global.css 已有的关键帧或 --dur-normal 过渡，**不许新造 @keyframes**。
   - 必须在 prefers-reduced-motion 下退化为无位移。
   - 关闭按钮要有 aria-label。
   - 错误态展示上游原文，**不截断成一句话**——原文可能很长，用两行截断 + title 挂全文，
     或者给一个「展开」。你选一个，理由写进 claims。
3. App.tsx 挂载 ToastHost（一次，全局）。
4. **toast 与 announce 并存**：同一件事既要 toast（视觉）也要 announce（读屏）。
   不要用 toast 替换 announce。
5. 本步**不要**去改 views/**（比如 SlotRow 的局部反馈）——那是视图 owner 的文件，
   本批不动它，第六批之后再统一收口。在 open_questions 里记下这个待办。`,
      { label: 'fix:toast', phase: 'Fix', schema: FIX_SCHEMA })

    const palette = await agent(`${PREAMBLE}

你的角色：mac-shell（第二步：命令面板与键盘）。你名下的路径——
  ${ROOT}/macos/src/shell/CommandPalette.tsx 与 .module.css
  ${ROOT}/macos/src/shell/keyboard.ts
  ${ROOT}/macos/src/shell/views.ts（只在需要时）
  ${ROOT}/macos/src/store/ui.ts（只在需要时，见下）
（上一步已建好 store/toast.ts 与 shell/ToastHost.tsx，你可以 import 它们但不要改。
 components/**、styles/**、views/** 一律不许动。）

上一步 toast 的自述（仅供定位，以文件为准）：
${JSON.stringify(toast?.claims ?? [], null, 1)}

**先读 ${ROOT}/DESIGN.md 4.3 节（spec 刚补充过）与现有 CommandPalette.tsx 全文。**
这个面板**已经有四个分组共 28 个动作**，写得相当完整。你的任务是补三项，**不是重写**。
任何对现有 28 个动作的改动都要在 claims 里单独说明理由。

1. **界面大小三档**：store/ui.ts 已有界面大小状态（标准/大/特大，localStorage 键
   claude1.desktop.density）。去读它，把三档切换接进面板的 action 分组，
   写法照现有「主题：${'${THEME_LABEL[candidate]}'}」那条动作的模式（显示的是「点它会变成什么」）。
2. **复制诊断报告**：把诊断信息拼成可粘贴的纯文本复制到剪贴板。
   - **复制内容必须过 redactSecrets**——诊断报告最可能带凭证，这是 fail-closed 边界。
   - 复制成功后走上一步新建的 toast（成功态）**并且** announce（读屏），两者都要。
   - 报告内容取什么：env、渠道列表、hub 配置、体检结论、最近错误。取现成 store 里的数据，
     不要新增 IPC。字段选择写进 claims。
3. **最近使用分组**：按 spec 在 4.3 节定的规范实现（存几条、存哪、怎么排序）。
   - localStorage 键名照 claude1.desktop.* 的现有约定。
   - 排在 nav 分组之前还是之后由 4.3 节的规范定，不要自己发明。
   - 空的时候不显示这个分组（不要显示一个空标题）。
4. **表格内键盘导航的对接**：Table 原语侧的 ↑↓/Enter 由另一个 agent 做（components/**）。
   你这边只需确认 Esc 逐层退出在面板的 mode 嵌套（root / channel / slot）下成立：
   在 channel 或 slot 子模式按 Esc 应退回 root 而不是直接关闭面板。
   实测一下现有行为，不对就修，本来就对就写进 already_correct。
5. keyboard.ts **已有** ⌘K / ⌘, / ⌘R / ⌘B / ⌘1–⌘7 全部实现。
   **不要重复实现它们。**只有在需要给新动作加快捷键时才动这个文件，
   且新键位不得与系统或终端常用组合冲突（现有代码已处理「不与 Control/Option 组合」）。

${FIX_COMMON}`, { label: 'fix:palette', phase: 'Fix', schema: FIX_SCHEMA })

    return { toast, palette }
  },

  // ── 路 C：诊断视图分段 ────────────────────────────────────────────
  () => agent(`${PREAMBLE}

你的角色：view-observability。你名下的路径——
  ${ROOT}/macos/src/views/diagnostics/**
  ${ROOT}/macos/src/views/usage/**
（components/**、styles/**、shell/**、其他 views/** 一律不许动。）

先读 ${ROOT}/DESIGN.md 的 4.6 节（spec 刚写的长视图分段规范）与 4.4 节（降级码呈现）。

任务：

1. **诊断视图分段**。实测 scrollHeight 3744px / clientHeight 683px，5.5 屏连续长页。
   按 4.6 节规范实现：sticky 小节头 + 锚点导航（或顶部 SegmentedControl，按规范选定的那个）
   + 回到顶部。目标：单段 ≤ 2 屏（约 1400px）。
   - sticky 小节头用 var(--z-sticky)，背景必须不透明（否则滚动时透字，这是第三批修过的同类 bug）。
   - 锚点导航要键盘可达，当前段要有视觉标识。
   - 长表格按 4.6 节定的取舍（分页或虚拟滚动）处理，**不要两个都做**。
2. **降级码呈现**按 4.4 节落地：列表显示中文标题 + 右侧 --fs-11 mono --text-tertiary 的原码
   （人话在前、机器码在后但绝不隐藏，可搜索可粘贴）；展开三段（发生了什么 / 对你的影响 /
   建议动作）；严重度按 SEVERITY_TONE 映射颜色 + 图形 + 文字**三重编码**（不只靠颜色）；
   同一回合的多个降级码折叠成一行「+N」。
   核实哪些已经实现——2026-08-19 那轮做过「SEVERITY_TONE 单点化」，所以颜色映射很可能已经对了。
3. **空态、加载态、错误态三件套**在这两个视图都要成立。
   **沿用 store 已有的 loadedKeys 门控**（空态只准在 loadedKeys[key]===true 且数据为空时出现），
   不要新造标志位。空态文案给下一步动作，不写「暂无数据」。
   错误态把 store 里的 error[key] 原文照摆，旁边加一行「这通常意味着什么」。
4. **usage 视图的数值**：确认 KPI 与表格数值都是 tabular-nums（第四批做过，核实即可）。
5. 图表配色如果还在用多语义色，按原始需求（DESIGN.md 4.2 节「同一图里最多 3 色，
   序列语义固定：输入=青、输出=紫、缓存=灰」）核对。**先 grep 4.2 节原文**再判断要不要动——
   4.2 节写的是固定语义色，而不是单色阶梯，以文档为准。

${FIX_COMMON}`, { label: 'fix:diagnostics', phase: 'Fix', schema: FIX_SCHEMA }),

  // ── 路 D：其余五视图的空态与文案 ──────────────────────────────────
  () => agent(`${PREAMBLE}

你的角色：view-channels + view-slots + view-ops。你名下的路径——
  ${ROOT}/macos/src/views/channels/**
  ${ROOT}/macos/src/views/slots/**
  ${ROOT}/macos/src/views/accounts/**
  ${ROOT}/macos/src/views/doctor/**
  ${ROOT}/macos/src/views/settings/**
（components/**、styles/**、shell/**、views/usage、views/diagnostics 一律不许动。）

任务：这五个视图的**空态 / 加载态 / 错误态三件套**与**文案纪律**。

1. 逐视图核对三态是否都成立。**沿用 store 已有的 loadedKeys 门控**
   （空态只准在 loadedKeys[key]===true 且数据为空时出现），不要新造标志位。
   2026-08-19 那轮做过「空态门控 loadedKeys」，很可能大部分已经对了——核实后把
   已正确的写进 already_correct，只补真缺的。
2. 空态文案改成「一行说明为什么空 + 一个可执行动作」。EmptyState 组件已存在
   （components/EmptyState.tsx，图标 + 一行说明 + 一个动作按钮），直接用，不要改它。
3. 错误态：store 的 error[key] 原文照摆，**旁边**加一行「这通常意味着什么」。
   channels 视图已有 .error 样式且注释写着「读取失败时把 store 里的中文原因原样摆出来，
   不换成加载失败」——这就是对的做法，推广它。
4. 全量审一遍这五个视图的中文文案，按文案纪律改：陈述句、无感叹号、无语气词、
   「标签：解释」句式、技术标识符 mono。
5. **不要动 SlotRow.tsx 的局部成功反馈逻辑**——toast store 本批刚建好但视图接入是后续的事，
   本批不做替换（避免与外壳路的改动撞车）。在 open_questions 里记下这个待办。
6. settings 视图的「外观」区：界面大小三档已存在（store/ui.ts），核实文案是否清楚，
   不要改功能。

${FIX_COMMON}`, { label: 'fix:empty-states', phase: 'Fix', schema: FIX_SCHEMA }),

  // ── 路 E：表格键盘导航 ───────────────────────────────────────────
  () => agent(`${PREAMBLE}

你的角色：mac-primitives。你名下只有这两个文件——
  ${ROOT}/macos/src/components/Table.tsx
  ${ROOT}/macos/src/components/Table.module.css
（其他 components/**、views/**、shell/** 一律不许动。）

任务：给表格补键盘导航——这是原始需求里键盘可达性**唯一真实的缺口**
（⌘K / ⌘, / ⌘R / ⌘B / ⌘1–⌘7 在 shell/keyboard.ts 里已全部实现，不要碰）。

1. 表格内 ↑↓ 移动行、Enter 触发该行的主操作、Esc 放弃选中。
   - 实现方式：给 Table 加可选 prop（例如 rowNavigable + onRowActivate），
     **向后兼容**——现有所有 <Table> 调用方不传新 prop 时行为必须一字不变。
   - 焦点管理：行要可聚焦（tabIndex），但整表只占一个 Tab 站点（roving tabindex 模式），
     不要让 Tab 键在几十行里逐行跳。
   - aria：行用 aria-selected 标记当前行（Table.module.css 已有
     tbody tr[aria-selected='true'] 的样式，复用它，不要新造）。
   - 视觉：当前行的主标识按 DESIGN.md 第 3 节是**左侧 2px accent 竖条**，背景色只是辅助。
     先 grep 确认这条原文再实现。
2. **绝不许回退第三批的表格成果**：外框（Card 内的两处 framed={false}）、sticky 不透明背景、
   左侧分隔线是 box-shadow: inset 不是 border-left、渐变遮罩、中截断保尾部、
   .table thead th.align-* 的高特异性覆盖、colgroup 的协议 160 / 备注 max 256。
   先读 DESIGN.md 第 4.1.1 节，再读这两个文件的现状，改动只做加法。
3. 焦点环：2px var(--accent) outline + 2px offset，**绝不 outline: none**。
4. 过渡时长按第四批的语义表（DESIGN.md 2.5 节）：行选中变化属 fast 140ms。
   不许新造 @keyframes、不许新增缓动曲线。
5. 先 grep 出全工程所有 <Table 使用处，确认新 prop 是纯可选、老调用方零影响。
   把使用处清单写进 claims。

${FIX_COMMON}`, { label: 'fix:table-keyboard', phase: 'Fix', schema: FIX_SCHEMA }),
])

log(`Fix 完成 ${fixes.filter(Boolean).length}/5 路`)

const VERIFY_PREAMBLE = `你在复核 ${ROOT} 下 macOS 桌面端第五批（UX 与文案）的改动。

【你的立场是对抗式的】
默认改动**有问题**。不要采信任何 agent 的自述——自己 cat、自己 grep、自己数。
前面的批次抓到过 fix agent 在注释里伪造 DESIGN.md 章节引用，这类问题报 major 起。

【只读】不许修改任何文件。只 cat / grep / python3 算数 / 跑现成校验工具。

【判定尺度】
- blocker：redactSecrets 边界被绕过、错误被伪装、CONTRACT 契约面被改、越界改别人的文件、
  伪造文档引用、safari15 不支持的语法、回退了第三/四批的成果、可达性倒退。
- major：规范没落地、重复实现了本来就有的功能、文案违反纪律、空态绕过 loadedKeys 门控。
- minor：注释缺失、命名不一致。
pass 只有在 violations 为空时才是 true。`

phase('Verify')
const verdicts = await parallel([
  () => agent(`${VERIFY_PREAMBLE}

${COPY_RULES}

你负责**文案与凭证边界**——本批最危险的两件事都在你这里。

1. **redactSecrets 边界**。grep 全工程（${ROOT}/macos/src）所有新增的文本展示路径：
   store/toast.ts、shell/ToastHost.tsx、命令面板的复制诊断报告、诊断视图的错误详情。
   逐个确认文本在**进入展示之前**过了 redactSecrets。
   参照 store/announce.ts 的写法（入口处 redactSecrets(text)）。
   任何一条路径漏掉是 **blocker**——这是 CONTRACT.md 1.2 节的 fail-closed 边界。
   特别检查「复制诊断报告」：它把 env、渠道、hub 配置拼成文本，最可能带凭证。
   如果它是先拼后脱敏，确认脱敏覆盖了拼进去的每一段；如果压根没过，blocker。
2. **错误伪装**。grep 全工程有没有出现「网络繁忙」「请稍后重试」「出错了」「系统异常」
   这类抹掉信息的话术。有就是 blocker（项目根 CLAUDE.md 硬规则：错误原样暴露）。
   再确认错误态确实在展示 store 的 error[key] **原文**，而不是改写版。
3. **degradeCatalog.ts 文案**。逐条抽查至少 12 个码：
   - action 是可执行的具体动作，还是「检查配置」这种空话？空话报 major。
   - severity=info 的 action 是否明确写「不用处理」而不是编一个假动作？
   - 有没有把上游故障说成「网络波动」？有就是 blocker。
   - 严重度分档是否符合文件顶部注释的口径？
   另外数一下现在共有多少个码，与改动前的 36 个比，报告增减。
4. **文案纪律全站抽查**。grep 全工程中文文案里的感叹号（！）、语气词（哦 / 啦 / 呢）、
   「暂无数据」。有就报 major，把行号写进 detail。
5. **播报文案**。读 store/announce.ts 的调用点，确认播报文本不依赖颜色表意
   （出现「绿色」「红色」这类词是 major），且不是纯符号。
6. **toast 与 announce 并存**。确认新增的复制/启动/保存三类操作**同时**走 toast 与 announce，
   不是用 toast 替换了 announce。只有 toast 没有 announce 是 major（读屏用户拿不到反馈）。`,
    { label: 'verify:copy', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

你负责**UX 达标与不重复实现**。

1. **诊断视图分段是否达标**。读 ${ROOT}/DESIGN.md 4.6 节与 views/diagnostics/**。
   - 有 sticky 小节头吗？它的背景是不是**不透明**？半透明会在滚动时透字（第三批修过同类 bug），
     半透明报 major。
   - 有锚点导航或顶部 SegmentedControl 吗？键盘可达吗？当前段有视觉标识吗？
   - 有回到顶部吗？
   - 单段是否 ≤ 2 屏？静态估算：数一下每段包含多少行/多少卡片，按行高 40px 粗算。
     算不出精确值就在 notes 里说明你的估算方法与结论，不要编一个数字。
   - 长表格是分页还是虚拟滚动？两个都做了报 major（规范要求选一个）。
2. **命令面板只补了三项吗**。这是本批最容易出的错——面板本来就有 28 个动作，
   改动前的分组是 nav / channel / slot / action。
   - 确认三项新增到位：界面大小三档（grep density）、复制诊断报告、最近使用分组。
   - **确认原有 28 个动作一个都没丢**。逐个数现在有多少个动作定义，与 28 比。
     变少了报 blocker，把丢掉的动作写进 detail。
   - 有没有把已经存在的功能重新实现一遍（例如重写主题切换、重写渠道启动）？报 major。
   - 最近使用分组为空时是否不显示（不该出现空标题）？
3. **快捷键没被重复实现**。读 shell/keyboard.ts，确认 ⌘K / ⌘, / ⌘R / ⌘B / ⌘1–⌘7 还在，
   且没有被重写成另一套。丢失是 blocker。
   确认 ⌘R 的 preventDefault 还在（丢了会导致 WebView 整页重载，blocker）。
   确认「不与 Control/Option 组合」的守卫还在。
4. **表格键盘导航**。读 components/Table.tsx：
   - 新 prop 是纯可选吗？grep 全工程所有 <Table 使用处，不传新 prop 的调用方行为会变吗？变了是 blocker。
   - 是 roving tabindex（整表一个 Tab 站点）还是每行一个 tabIndex=0？后者是 major（Tab 键会在几十行里跳）。
   - 当前行的主标识是左侧 accent 竖条吗？只有背景色是 minor。
   - 有 outline: none 且无替代可见焦点样式吗？blocker。
5. **空态门控**。grep 五个视图（channels/slots/accounts/doctor/settings）的空态渲染条件，
   确认都走 store 的 loadedKeys（空态只在 loadedKeys[key]===true 且数据为空时出现）。
   新造了标志位、或空态在加载中就闪出来，报 major。`,
    { label: 'verify:ux', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

${NO_REGRESS}

你负责**契约、回归与兼容**。

1. **CONTRACT 契约面**。读 ${ROOT}/CONTRACT.md 第 2 / 3 / 6.2 节，再读
   ${ROOT}/macos/src/store/index.ts、store/nav.ts、src/types/contract.ts、src/api/**。
   逐字确认：AppState / NavState 的字段一个都没被增删改；第 2 节的数据类型没变；
   IPC 命令签名没变。任何改动是 **blocker**。
   新增的 toast 状态必须在**独立的 store/toast.ts** 里，进了 AppState 是 blocker。
2. **第三批表格成果**。读 DESIGN.md 4.1.1 节 + components/Table.* + views/channels/**，
   逐条确认还在：表格外框（且 PoolCard 与 diagnostics 副表仍传 framed={false}）、
   sticky 操作列**完全不透明**背景、左侧分隔线是 **box-shadow: inset 1px 0 0** 而不是
   border-left（被改回 border-left 是 blocker）、渐变遮罩伪元素 right: 100%、
   模型列中截断（保留尾部日期，不是整格 ellipsis）、MidTruncate 在 components 桶里、
   .table thead th.align-* 的高特异性覆盖、<colgroup> 的协议 160px / 备注 max 256px。
   任何一条丢失是 blocker。
3. **第四批动效成果**。独立数一遍 ${ROOT}/macos/src 下：
   var(--dur-fast) / var(--dur-normal) / var(--dur-slow) 的出现次数、@keyframes 总数与分布。
   填进 measured。要求 fast ≥ 8、normal ≥ 8、@keyframes ≥ 8（第四批的验收线，不许倒退）。
   再检查：
   - 有没有新增 @keyframes 到不该有的文件（只允许 global.css + CommandPalette + Dialog + Spinner）。
   - 有没有新增缓动曲线（组件里出现裸 cubic-bezier( 或 ease-in-out 关键字是 major）。
   - 有没有超过 320ms 的过渡（--dur-progress-loop 的 1100ms 是 indeterminate 循环，合法）。
   - reduced-motion 分支还在且覆盖新增动效吗？被改坏是 blocker。
4. **safari15 兼容**。grep 全工程：:has(、@container、@property、无前缀 line-clamp、
   structuredClone、Array.prototype.at 之外的新 API。
   -webkit-line-clamp 必须配 display: -webkit-box。违反是 blocker。
5. **越界检查**。五路 fix agent 各自的路径域：
   A=data/degradeCatalog.ts；B=store/**+shell/**+App.tsx；C=views/usage+views/diagnostics；
   D=views/channels+slots+accounts+doctor+settings；E=components/Table.*。
   检查有没有交叉修改：视图里出现内联十六进制色值、硬编码 px 时长、自创 token 都是违规。
   特别检查 SlotRow.tsx 的局部成功反馈逻辑**有没有被动**——本批明确要求不动它。
6. **跑校验工具**：
   python3 ${ROOT}/tools/token-drift.py ${ROOT}
   python3 ${ROOT}/tools/border-audit.py ${ROOT}/macos/src
   两个的退出码与完整输出都写进 measured。token-drift 非 0 是 blocker；
   border-audit 报出「疑似独立容器仍用 subtle」是 major（第二批的成果被倒退）。`,
    { label: 'verify:contract', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

const all = verdicts.filter(Boolean).flatMap(v => v.violations ?? [])
const blockers = all.filter(x => x.severity === 'blocker')
const majors = all.filter(x => x.severity === 'major')
log(`复核完成：${verdicts.filter(Boolean).length}/3 返回，blocker ${blockers.length} / major ${majors.length}`)

return { batch: 5, spec, fixes, verdicts, blockers, majors }
