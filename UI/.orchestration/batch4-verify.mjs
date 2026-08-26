export const meta = {
  name: 'ui-batch4-verify',
  description: '第四批补跑：三路独立复核（原 workflow 的 Verify 阶段未执行）',
  phases: [
    { title: 'Verify', detail: '计数与阈值 / 语义合规 / 回归与兜底' },
  ],
}

const ROOT = '/Users/admin/Desktop/claude-hub/UI'

const PREAMBLE = `你在改 ${ROOT} 下的 macOS 桌面端（Tauri v2 + React + TypeScript + CSS Modules，构建目标 safari15）。

【不可越界的硬约束】
1. 只改分配给你的文件路径，其他一个字都不许动。文件所有权见 ${ROOT}/CONTRACT.md 第 6 节。
2. CONTRACT.md 的契约面不可动：第 2 节 TypeScript 数据类型、6.2 节 AppState/NavState 形状、第 3 节 IPC 签名。组件自身 props 可向后兼容地加可选字段，不得删改已有字段。
3. DESIGN.md 是唯一视觉真理来源。改视觉值的顺序是：先 DESIGN.md → 再 tokens.css → 最后组件。不允许自创色值、时长、间距、圆角，一律走 token。
4. 构建目标 safari15：不要用 :has()、容器查询、@property。
5. 错误原样暴露，不伪装、不吞掉。
6. 代码注释保持中文，与现有工程一致。

【禁止伪造证据】
注释里引用 DESIGN.md 章节前，必须先 grep 确认该章节与措辞真实存在。上一批出现过 agent 自创名词再拿章节号给它背书，那比不写注释更有害。引用不到就不引用。

【报告要求】
最终文本就是返回值。按 schema 返回结构化数据，claims 里写实际做过的事与实际数出的数字。`

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_changed', 'claims', 'counts', 'open_questions'],
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
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['dur_fast_added', 'dur_normal_added', 'dur_slow_added', 'keyframes_added'],
      properties: {
        dur_fast_added: { type: 'integer', description: '本 agent 新增的 var(--dur-fast) 使用处数' },
        dur_normal_added: { type: 'integer' },
        dur_slow_added: { type: 'integer' },
        keyframes_added: { type: 'integer' },
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
    measured: { type: 'object', additionalProperties: true, description: '你自己 grep 数出来的计数，键名自定' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

/* ── 现状基线（编排者 2026-08-21 实测，口径是 grep -rho "var(--dur-X)" 的出现次数） ──
   --dur-instant  80ms → 27 次
   --dur-fast    140ms →  3 次   目标 ≥ 8
   --dur-normal  220ms →  2 次   目标 ≥ 8
   --dur-slow    320ms → 不存在，本批新增
   @keyframes 全工程 4 个：CommandPalette.module.css 的 palette-in、global.css 的
   app-progress-slide、Dialog.module.css 的 fade、Spinner.module.css 的 spin。目标 ≥ 8。
   即：80ms 在感知上就是「瞬间」，全站 27 处反馈都是瞬时切换，等于没有动效体系。
   ──────────────────────────────────────────────────────────────────────────── */

const SEMANTICS = `【时长语义，按语义选值，不许为了凑数乱用】
--dur-instant 80ms  —— 仅限 hover 的背景色/文字色变化。
--dur-fast   140ms  —— 按钮按下、开关拨动、chip/tab 选中、图标旋转翻转。
--dur-normal 220ms  —— 面板/抽屉/对话框入场、视图切换、折叠展开的尺寸位移。
--dur-slow   320ms  —— 命令面板入场、首屏内容浮现。仅此两类，不要扩散。
缓动只用两条既有曲线：入场/位移用 var(--ease-out)，双向状态用 var(--ease-in-out)。**禁止新增曲线。**
上限 320ms，不许出现比它更慢的过渡。不做视差、不做弹跳 overshoot、不做循环装饰动画。
这是运维工具，动效服务于「状态变化被看见」，不是炫技。`

const QUOTA = `【配额是下限，不是上限；每一处都要有语义理由】
全批目标：var(--dur-fast) 总数 ≥ 8（现 3）、var(--dur-normal) 总数 ≥ 8（现 2）、@keyframes ≥ 8（现 4）。
按所有权域分配的新增下限：
  mac-primitives    fast +5  normal +3
  mac-shell         fast +2  normal +4  slow +2
  views(channels+slots)            fast +2  normal +1
  views(usage+diagnostics+accounts+doctor+settings)  fast +2  normal +2
达不到下限要在 open_questions 里说清为什么（比如该域确实没有那么多对应语义的交互），
**不要把 hover 背景色改成 140ms 来凑数**——那违反语义表第一条，复核会报 major。`


/* 原 wf_12e65279-def 在 Apply 之后中断（checkpoint 无法恢复），Spec / Keyframes / Apply 四路的
   文件改动已落盘，但 Verify 三路从未启动。本脚本只补跑复核，不重跑任何 fix——
   fix agent 的 result 没进 journal，续跑会在已改过的文件上再改一遍。
   编排者已独立验过的部分（复核仍需自己重验，不要采信这段）：
     tsc --noEmit 干净；token-drift.py 0 项；border-audit.py 0 违规；unittest 800 OK；
     计数 grep -rho "var(--dur-X)"：fast 30 / normal 18 / slow 2（基线 3 / 2 / 0）；
     @keyframes 实际定义 8 个（palette-in / app-progress-slide / view-enter / list-stagger-in /
     value-flash / accent-bar-in / fade / spin），分布在 global.css 5 + CommandPalette 1 +
     Dialog 1 + Spinner 1，全部在白名单内。注意 grep '@keyframes' 会数到 16——
     多出的 8 处是注释里提到这个词的行，数的时候要剔除注释。 */

const VERIFY_PREAMBLE = `你在复核 ${ROOT} 下 macOS 桌面端第四批（动效与精细度）的改动。

【你的立场是对抗式的】
默认改动**有问题**。不要采信任何 agent 的自述——自己 cat、自己 grep、自己数。
上一批复核抓到过 fix agent 在注释里伪造 DESIGN.md 章节引用，这类问题报 major 起。

【只读】不许修改任何文件。只 cat / grep / python3 算数 / 跑现成校验工具。

【判定尺度】
- blocker：功能坏了、契约被破、越界改了别人的文件、伪造文档引用、safari15 不支持的语法、
  回退了第三批的成果、可达性兜底（reduced-motion）被改坏。
- major：规范没落地、配额没达标、为凑数违反语义表、新增了禁止的曲线或关键帧。
- minor：注释缺失、命名不一致。
pass 只有在 violations 为空时才是 true。`

const BASELINE = `【基线，口径必须一致】
计数口径是 grep -rho "var(--dur-X)" 在 ${ROOT}/macos/src 下的出现次数，
**不含 tokens.css 里的定义行本身**（定义写的是 --dur-fast: 140ms，不是 var(--dur-fast)，
所以自然不会被计入，但你要确认自己的 grep 没把定义行算进去）。
改动前：instant 27 / fast 3 / normal 2 / slow 0（不存在）。
@keyframes 改动前全工程 4 个，分布在 CommandPalette.module.css、global.css、
Dialog.module.css、Spinner.module.css。
验收阈值：fast ≥ 8、normal ≥ 8、@keyframes ≥ 8。`

const NO_REGRESS = `【不许回退第三批的成果】
第三批（已完成并经三路复核 + 编排者修复）改过这些地方，动它们时只准**新增
transition/animation**，不许改动其结构、类名、色值、宽度：
  components/Table.module.css、components/Table.tsx
    · 外框 1px var(--border-default) + var(--radius-md)，落在 .scroll 包裹层（不是 <table>，
      collapse 模式下 <table> 的圆角会被单元格边穿出）。可退：framed prop 默认 true，
      **Card 内必须传 framed={false}**——views/accounts/parts/PoolCard.tsx 与
      views/diagnostics/index.tsx 两处已传，删掉就会出现两条同色 1px 线。
    · sticky 操作列 .stickyAction：底色由局部变量 --sticky-action-bg 单点提供
      （非当前行 --bg-base、当前行 --bg-selected-table-solid #142126/#e3eef1），必须完全不透明。
    · 左侧分隔线是 **box-shadow: inset 1px 0 0 var(--border-subtle)**，**不是 border-left**
      ——.table 是 border-collapse: collapse，合并模式下单元格边框归 table 的 border grid
      绘制、横滚时不跟着钉住的列走。**不许改回 border-left。**
    · 渐变遮罩是 .stickyAction::before 叠 linear-gradient(to left, var(--sticky-action-bg),
      transparent)，right: 100%（分隔线不占盒宽了，所以不再让开 1px）。
    · 中截断 MidTruncate：双 span，头段吃 text-overflow: ellipsis、尾段 nowrap 不收缩，
      tail=8 保住日期戳。**不许换成整格 ellipsis。** 已进 components/index.ts 桶导出。
    · table-layout 由 hasColgroup() 自动判定：有 <colgroup> 切 fixed，没有保持 auto。
      四张没有 colgroup 的表（PoolCard / UsageTable / FailureTable / diagnostics 副表）保持 auto。
    · **.table thead th.align-left/center/right 的高特异性覆盖不许删**——表头分组规则里的
      text-align: left 特异性 (0,1,2) 会压死 (0,1,0) 的 .align-*，删了 <Th numeric> 与
      <Th align> 全部失效（8 处受害）。这是复核抓出的 blocker，已修。
  views/channels/**
    · <colgroup> 七列宽度全部走 --table-col-* token，视图里不写 px。
      预算 88/150/160/240/104/(160~256 flex)/132，固定列合计 874，总和上限 1130 ≤ 1160。
      **协议列是 160 不是 96**——96 只放得下 7.8 个 mono 字符，连 anthropic 都会被硬裁，
      那是切到 fixed 才暴露的回退，已从备注列上限（320→256）匀出 64px 修掉。
    · 模型列中截断 + title 里两行（完整 id \n 来源说明）。备注列 -webkit-line-clamp 两行截断。
    · sticky 单元格底色三处覆盖只改 --sticky-action-bg 变量，都是不透明色。
规范在 DESIGN.md 第 4.1.1 节（含宽度预算、fixed 布局的教训、stickyHeader 空转的已知缺口）。
特别地：如果你给 sticky 单元格加了 background-color 的 transition，过渡中间态不能出现
半透明——那会让第三批修的透字 bug 复现。`

phase('Verify')
const verdicts = await parallel([
  () => agent(`${VERIFY_PREAMBLE}

${BASELINE}

你负责**计数与阈值**。

1. 在 ${ROOT}/macos/src 下独立数出：var(--dur-instant) / var(--dur-fast) / var(--dur-normal) /
   var(--dur-slow) 各自的出现次数，以及 @keyframes 的总数与它们分别在哪个文件。
   把这些数字全部填进 measured。
2. 对阈值：fast ≥ 8、normal ≥ 8、@keyframes ≥ 8。不达标报 major，detail 里写实际数字。
3. 检查 --dur-slow 是否真的加进了 tokens.css 的裸 :root，值是否 320ms。
4. 检查有没有出现**新的缓动曲线**：grep 所有 cubic-bezier(，应当只有 --ease-out
   与 --ease-in-out 两条定义（在 tokens.css），组件里只准用 var(--ease-out) / var(--ease-in-out)。
   组件里出现裸 cubic-bezier( 或 ease-in-out 关键字是 major。
5. 检查有没有超过 320ms 的过渡时长：grep 所有形如 数字ms 的硬编码时长，
   凡 > 320ms 且不是 --dur-progress-loop（1100ms，indeterminate 循环，合法）的都报 major。
6. 检查 @keyframes 是否只存在于允许的文件里（global.css + CommandPalette + Dialog + Spinner）。
   视图或其他组件新造 @keyframes 报 major。
7. 跑 python3 ${ROOT}/tools/token-drift.py ${ROOT}，退出码非 0 报 blocker。`,
    { label: 'verify:counts', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

${BASELINE}

${SEMANTICS}

你负责**语义合规**——本批最容易出的错是「为了凑配额把 hover 背景色改成 140ms」。

1. 把 ${ROOT}/macos/src 下所有 var(--dur-fast) 与 var(--dur-normal) 的使用处逐个 grep 出来，
   看它所在的 CSS 规则：过渡的是什么属性、选择器是什么状态。
2. 逐条判定语义是否正确：
   - hover 状态下只过渡 background-color / color 的，**必须是 instant 80ms**。
     用了 fast 或 normal 是 major（凑数行为）。
   - :active、开关轨道、chip/tab 选中 → fast 140ms 正确。
   - 面板/对话框/抽屉入场、视图切换、折叠宽高位移 → normal 220ms 正确。
   - 命令面板入场、首屏浮现 → slow 320ms 正确。仅此两类；扩散到别处报 major。
3. 检查是否出现被禁止的效果：弹跳/overshoot（cubic-bezier 第二或第四个参数 > 1 或 < 0）、
   视差、循环装饰动画（animation 带 infinite 且不是 Spinner 与 RouteProgress 那两处合法的）。
4. 检查五态：抽查至少 6 个可交互元素（Button、IconButton、Switch、SegmentedControl、
   Select、侧栏导航项），确认 hover / active / selected / focus-visible / disabled 都有定义。
   任何一处 outline: none 且没有替代可见焦点样式的，报 blocker。
5. 检查 tabular-nums：抽查 usage 与 channels 两个视图的数值列，确认数值渲染点都带
   font-variant-numeric: tabular-nums（可能通过 .mono 类间接获得，要顺着类名查到底）。`,
    { label: 'verify:semantics', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

${NO_REGRESS}

你负责**回归与兜底**。

1. **第三批成果是否被回退**：读 ${ROOT}/DESIGN.md 第 4.1.1 节，再读
   components/Table.module.css、components/Table.tsx、views/channels/index.module.css、
   views/channels/index.tsx。逐条确认第三批的成果还在：
   - 表格外框 1px var(--border-default) + var(--radius-md)，且 PoolCard 与 diagnostics 副表
     仍传 framed={false}（删了会出现两条同色 1px 线）
   - sticky 操作列背景**完全不透明**；左侧分隔线是 box-shadow: inset 1px 0 0，
     **不是 border-left**（改回 border-left 是 blocker）
   - 渐变遮罩伪元素 .stickyAction::before，right: 100%
   - 模型列中截断（保留尾部日期），**不是**整格 ellipsis；MidTruncate 在 components 桶里
   - <colgroup> 列宽：协议列 160px、备注 max 256px（不是 96/320）
   - .table thead th.align-* 的高特异性覆盖还在（删了 <Th numeric> 全失效）
   任何一条丢失或被削弱是 blocker。
   特别检查：如果 sticky 单元格新增了 background-color 的 transition，
   过渡中间态会不会出现半透明？如果 transition 的是 background 简写且涉及 rgba，报 major。
2. **reduced-motion 兜底**：读 global.css 的 @media (prefers-reduced-motion: reduce) 分支。
   确认开启后：所有位移/缩放动画与过渡被关掉，不位移的透明度变化可以保留。
   如果这个分支被改成了空壳、被删掉、或改后不再覆盖新增的关键帧，报 blocker。
   自己逐个新增关键帧核对：view-enter（有 translateY，必须被关）、list-stagger-in、
   value-flash（无位移，可保留）、以及第四个关键帧。
3. **safari15 兼容**：grep 全工程有没有 :has(、@container、@property、无前缀的 line-clamp。
   有就是 blocker。另外确认 -webkit-line-clamp 的用法都配了 display: -webkit-box。
4. **越界检查**：四个 apply agent 各有自己的路径域（primitives=components+lib、
   shell=main/App/shell/store、views-a=channels+slots、views-b=usage+diagnostics+accounts+doctor+settings）。
   检查有没有视图里出现内联十六进制色值、硬编码 px 时长、自创 token——这类是越界或违规，
   报 blocker 或 major。
5. **CONTRACT 契约面**：grep ${ROOT}/macos/src/store/index.ts 与 nav.ts，
   对照 ${ROOT}/CONTRACT.md 第 6.2 节，确认 AppState / NavState 的字段一个都没被增删改。
   被改是 blocker。`,
    { label: 'verify:regress', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

const blockers = verdicts.filter(Boolean).flatMap(v => (v.violations ?? []).filter(x => x.severity === 'blocker'))
const majors = verdicts.filter(Boolean).flatMap(v => (v.violations ?? []).filter(x => x.severity === 'major'))
log(`复核完成：${verdicts.filter(Boolean).length}/3 返回，blocker ${blockers.length} / major ${majors.length}`)

return { batch: 4, verdicts, blockers, majors }
