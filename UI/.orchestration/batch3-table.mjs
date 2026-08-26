export const meta = {
  name: 'ui-batch3-table',
  description: '第三批：渠道表列宽策略、sticky 操作列不透明、横向溢出消除',
  phases: [
    { title: 'Spec', detail: 'DESIGN.md 表格规范 + tokens.css 列宽 token' },
    { title: 'Fix', detail: 'Table 原语与渠道视图落地' },
    { title: 'Verify', detail: '三路独立复核' },
  ],
}

const ROOT = '/Users/admin/Desktop/claude-hub/UI'

const PREAMBLE = `你在改 ${ROOT} 下的 macOS 桌面端（Tauri v2 + React + TypeScript + CSS Modules，构建目标 safari15）。

【不可越界的硬约束】
1. 只改分配给你的文件路径，其他一个字都不许动。文件所有权见 ${ROOT}/CONTRACT.md 第 6 节。
2. CONTRACT.md 的契约面不可动：第 2 节 TypeScript 数据类型、6.2 节 AppState/NavState 形状、第 3 节 IPC 签名。组件自身的 props 接口可以向后兼容地扩展（加可选字段），但不得删改已有字段。
3. DESIGN.md 是唯一视觉真理来源。改视觉值的顺序是：先 DESIGN.md 第 2 节 → 再 tokens.css → 最后组件。不允许视图自创色值、间距、圆角，一律走 token（1px 边框宽度除外）。
4. 构建目标 safari15：不要用 :has()、容器查询、@property。需要遮罩用 -webkit-mask-image 并同时写标准 mask-image，或改用伪元素叠 linear-gradient。
5. redactSecrets 脱敏边界不可绕过（CONTRACT.md 1.2 节，fail-closed）。任何新增文本展示路径都要过它。
6. 错误原样暴露，不伪装、不吞掉。禁止把上游错误改写成「网络繁忙」这类话术。
7. 代码注释保持中文，与现有工程一致；注释密度和措辞跟周围代码看齐。

【禁止伪造证据】
注释里引用 DESIGN.md 章节前，必须先 grep 确认该章节/该措辞真实存在。上一批出现过 agent 自创名词再拿「DESIGN.md 2.2.1」给它背书的情况，那比不写注释更有害。引用不到就不引用。

【报告要求】
你的最终文本就是返回值，不是给人看的话。按被要求的 schema 返回结构化数据，claims 里写你实际做过的事和实际测出的数字，不确定就标不确定。`

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_changed', 'claims', 'open_questions'],
  properties: {
    files_changed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'what'],
        properties: {
          path: { type: 'string' },
          what: { type: 'string', description: '这个文件里改了什么，具体到类名/属性名' },
        },
      },
    },
    claims: { type: 'array', items: { type: 'string' }, description: '可被独立验证的断言，含实测数字' },
    open_questions: { type: 'array', items: { type: 'string' }, description: '规则未覆盖、需要人决策的缺口；没有就空数组' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'violations', 'notes'],
  properties: {
    pass: { type: 'boolean', description: '全部检查通过才为 true' },
    violations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'path', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          path: { type: 'string' },
          detail: { type: 'string', description: '问题 + 证据（grep 到的行、算出的数字）' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

/* ── 现状基线（已由编排者实测，不要重新猜） ──────────────────────────
   渠道表 scrollWidth = 1787px，1733px 宽窗口下 clientWidth 仍只有 1733 → 永远溢出。
   根因是两列吃掉 988px：模型名列 378px（承载 claude-opus-4-1-20250805 这类长 id）、
   备注列 610px。
   操作列是 position:sticky; right:0; z-index:2，背景 --bg-base 系半透明叠色，
   横滚时底层单元格文字从操作列底下透出，两层字叠在一起。
   渠道表的 <Table> 不在 <Card> 内，而 Table.module.css 自身没有外框 border——
   这是第二批记在 DESIGN.md 2.2.1 节的第 2 条缺口，本批要一并解决。
   表头共 7 列，顺序：状态 / 渠道 / 协议 / 模型 / 上下文窗口 / 备注 / 动作。
   ────────────────────────────────────────────────────────────────── */

const WIDTH_BUDGET = `【宽度预算，必须算得上】
1440px 窗口下可用宽 = 1440 − 侧栏 232 − 内容区左右 padding 48（var(--sp-6) ×2）= 1160px。
七列预算（固定列 + 一个 flexible 列）：
  状态 88 / 渠道 150 / 协议 96 / 模型 240(上限) / 上下文窗口 104 / 备注 160~320(flex) / 动作 132
固定列合计 810px。备注取 min 160 → 970px；取 max 320 → 1130px。两种都 ≤ 1160，因此
1440px 下默认不横滚。这组数字是硬预算：要调整某列就得从别的列匀出来，总和不许越过 1130。`

const STICKY_COLOR = `【sticky 操作列的不透明等价色，先验算再写】
操作列现在的背景是半透明叠色，必须换成完全不透明。
非当前行：直接用 var(--bg-base)（表格底就是它，视觉无变化但不再透字）。
当前行：需要 --bg-selected-table 叠在 --bg-base 上的不透明等价色，新增 token
  --bg-selected-table-solid。按 c = a·前景 + (1−a)·背景 逐通道算：
  深色 rgba(62,214,227,0.08) over #101116 →
    #101116 的通道值：R 0x10=16、G 0x11=17、B 0x16=22。
    R .08·62+.92·16=19.68→20=0x14；G .08·214+.92·17=32.76→33=0x21；B .08·227+.92·22=38.40→38=0x26
    得 #142126
  浅色 rgba(10,157,176,0.07) over #f3f4f6（R 243 G 244 B 246）→
    R .07·10+.93·243=226.69→227=0xe3；G .07·157+.93·244=237.91→238=0xee；B .07·176+.93·246=241.10→241=0xf1
    得 #e3eef1
你必须自己复算一遍这六个通道再落值。算出来跟上面不一致就以你的算式为准，并在 claims 里说明差异。
tokens.css 里要在深色 :root、浅色 media 段、浅色 [data-theme="light"] 段三处都加这个 token
（三处都加是刻意的，缺一处就有一种主题组合失效——见 tokens.css 顶部注释）。`

phase('Spec')
const spec = await agent(`${PREAMBLE}

你的角色：spec。你名下的文件只有两个——
  ${ROOT}/DESIGN.md
  ${ROOT}/macos/src/styles/tokens.css
先把这两个文件和 ${ROOT}/macos/src/components/Table.module.css、
${ROOT}/macos/src/views/channels/index.module.css 读完（后两个只读不改）。

任务：为第三批（表格）定规范并落 token。

1. DESIGN.md 第 4 节新增一个小节「4.1.1 表格的列宽与 sticky 操作列」，写清：
   - 列宽策略：固定列给定宽、只留一个 flexible 列（备注），用 <colgroup> 声明而不是靠内容撑。
   - 模型名列上限 240px，超出走**中截断**（保留头部与尾部，例：claude-opus-4-1-…0805），
     完整值进 title/tooltip 并提供复制。**绝不能用 text-overflow: ellipsis 砍尾部**——
     尾部日期是用户区分模型版本的依据。
   - 备注列 min 160 / max 320，多行走两行截断。
   - sticky 操作列：背景完全不透明、左侧 1px 分隔线、向左的渐变遮罩表明「下面还有内容」。
   - 表格外框：Table 自身补 1px var(--border-default) 外轮廓 + var(--radius-md)，
     解决 DESIGN.md 2.2.1 节记的第 2 条缺口（渠道表不在 Card 内、无外框可归位）。
     补完后回到 2.2.1 节把那条缺口标记为已解决，并写清是怎么解决的。
   - 把下面的宽度预算原样写进这一小节，让下一轮重构者能复算。

2. tokens.css 新增 token（三个主题段都要加颜色类 token；尺寸类 token 只加在裸 :root
   的「布局与控件尺寸」区）：
   --table-col-status / --table-col-channel / --table-col-protocol / --table-col-model-max /
   --table-col-context / --table-col-note-min / --table-col-note-max / --table-col-action
   --table-sticky-fade-w（渐变遮罩宽，建议 24px）
   --bg-selected-table-solid（见下方算式）
   每个 token 上方写一行中文注释说明它对应 DESIGN.md 的哪条规范。

3. 同步 DESIGN.md 第 2 节的 token 表：--bg-selected-table-solid 要出现在 2.1/2.2 两段色表里，
   否则 ${ROOT}/tools/token-drift.py 会报漂移。改完自己跑一遍：
   python3 ${ROOT}/tools/token-drift.py ${ROOT}
   退出码必须是 0。把它的输出写进 claims。

${WIDTH_BUDGET}

${STICKY_COLOR}`, { label: 'spec:design+tokens', phase: 'Spec', schema: FIX_SCHEMA })

log(`spec 完成：改了 ${spec?.files_changed?.length ?? 0} 个文件`)

phase('Fix')
const prim = await agent(`${PREAMBLE}

你的角色：mac-primitives。你名下只有这两个文件——
  ${ROOT}/macos/src/components/Table.module.css
  ${ROOT}/macos/src/components/Table.tsx
（同目录其他组件、views/** 一律不许动。）

前一步 spec 已经改完 ${ROOT}/DESIGN.md 与 ${ROOT}/macos/src/styles/tokens.css。
**先把这两个文件读一遍**，拿到新增 token 的准确名字，再动手。spec 的自述如下（仅供定位，
以文件实际内容为准）：
${JSON.stringify(spec?.claims ?? [], null, 1)}

任务：把表格原语升级到 DESIGN.md 新的 4.1.1 节规范。

1. Table 外框：.scroll 或 .table 补 1px var(--border-default) 外轮廓 + var(--radius-md)，
   注意 border-collapse: collapse 与圆角同时用会让圆角被单元格边覆盖——自己验证一下，
   必要时把外框放在 .scroll 上（推荐），并让 .scroll 带 overflow: hidden 之外仍能横滚
   （横滚容器不能被 overflow:hidden 掐死，想清楚再写）。
2. 中截断能力：Table.tsx 导出一个新组件（建议 MidTruncate）或给 Td 加可选 prop，
   实现「保留头尾、中间用 … 」的截断。要点：
   - 纯 CSS 做不到中截断，需要 JS 按可用宽度裁字符，或用「前段 flex 收缩 + 后段固定」的
     双 span 方案（后段 white-space: nowrap、flex-shrink: 0，前段 overflow hidden +
     text-overflow ellipsis）。**双 span 的纯 CSS 方案更稳，优先它**，尾部保留字符数做成参数。
   - 完整值必须挂在 title 属性上。
   - 不要引入新依赖。
3. sticky 操作列：新增 .stickyAction（表头与单元格共用或各一个类），做到
   - 背景完全不透明（非当前行 var(--bg-base)、当前行 var(--bg-selected-table-solid)）
   - 左侧 1px solid var(--border-subtle) 分隔线（这是容器内部的列分隔线，按 DESIGN.md
     2.2.1 节的规则用 subtle，不是 default——别升级它）
   - 向左的渐变遮罩：用伪元素在 sticky 列左外侧叠一层
     linear-gradient(to left, <底色>, transparent)，宽 var(--table-sticky-fade-w)。
     伪元素方案比 mask-image 更稳，safari15 下也没有兼容问题。
   - z-index 用 var(--z-sticky) 体系内的值，不写魔法数字。
4. 列宽由调用方用 <colgroup> 声明，原语只需保证 table-layout 能让 colgroup 生效
   （需要 table-layout: fixed 吗？自己验证：fixed 会让所有列严格按 colgroup 走但内容不再
   撑开；auto 下 colgroup 的 width 只是建议值。结合宽度预算选一个，并在注释里写清理由）。
5. 现有 API 必须向后兼容：.truncate、numeric、mono、dense、stickyHeader、minWidth 的行为
   一个都不许变。先 grep 出全工程所有 <Table / <Th / <Td 的使用处，确认你的改动不会
   影响其他视图的既有表格。

${WIDTH_BUDGET}`, { label: 'fix:table-primitive', phase: 'Fix', schema: FIX_SCHEMA })

const chan = await agent(`${PREAMBLE}

你的角色：view-channels。你名下只有这个目录——
  ${ROOT}/macos/src/views/channels/**
（components/**、styles/**、DESIGN.md 一律只读不改。）

前两步已完成：spec 落了 token 与 DESIGN.md 4.1.1 节规范，mac-primitives 升级了
Table 原语。**动手前先读这四个文件**拿到准确的 token 名与新 API：
  ${ROOT}/DESIGN.md（第 4.1.1 节）
  ${ROOT}/macos/src/styles/tokens.css
  ${ROOT}/macos/src/components/Table.tsx
  ${ROOT}/macos/src/components/Table.module.css
mac-primitives 的自述（仅供定位，以文件实际内容为准）：
${JSON.stringify(prim?.claims ?? [], null, 1)}

任务：把渠道表的溢出 bug 修掉。

1. 在 <Table> 里加 <colgroup>，七列按宽度预算给宽。备注列是唯一 flexible 的那一列。
2. 模型列换用原语的中截断能力，尾部至少保留能看出版本日期的字符数
   （claude-opus-4-1-20250805 的尾部 8 位日期必须可见）。完整值进 title。
   如果视图里已有复制按钮/复制能力就复用，没有就不要为此新造交互——这批只修溢出与截断。
3. 备注列按 min 160 / max 320 走，内容两行截断（-webkit-line-clamp: 2 + display: -webkit-box，
   safari15 支持这套前缀写法）。
4. 操作列换用原语的 .stickyAction。视图里现有的 .actionHeader（position:sticky; right:0;
   z-index:3; background: var(--bg-base); border-left: 1px solid var(--border-subtle)）
   要么删掉改用原语类，要么只保留视图特有的部分——**不许出现两套 sticky 实现并存**。
   当前行（aria-selected 或视图自己的当前行标记）的 sticky 单元格必须用
   var(--bg-selected-table-solid)，不能是半透明。
5. 检查 .groupCell / .groupRow 这些已隐藏分区的行：它们的背景是 var(--bg-surface)，
   在 sticky 列下面横滚时也会透字。一并处理成不透明。
6. 改完静态复算一遍：七列宽度合计（备注取 min 与 max 两种）是否都 ≤ 1160px。
   把算式和结果写进 claims。

${WIDTH_BUDGET}`, { label: 'fix:view-channels', phase: 'Fix', schema: FIX_SCHEMA })

log('两步 fix 完成，进入独立复核')

const VERIFY_PREAMBLE = `你在复核 ${ROOT} 下 macOS 桌面端第三批（表格）的改动。

【你的立场是对抗式的】
默认改动**有问题**，你的任务是找出问题。不要采信任何 agent 的自述——自己 cat 文件、自己
grep、自己算数字。上一批复核抓到过 fix agent 在注释里伪造 DESIGN.md 章节引用，这类问题
必须报出来（severity: major 起）。

【只读】
你不许修改任何文件。只 cat / grep / python3 算数 / 跑现成的校验工具。

【判定尺度】
- blocker：功能坏了、契约被破、越界改了别人的文件、伪造文档引用、safari15 不支持的语法。
- major：规范没落地、数字不达标、两套实现并存。
- minor：注释缺失、命名不一致。
pass 只有在 violations 为空时才是 true。`

phase('Verify')
const verdicts = await parallel([
  () => agent(`${VERIFY_PREAMBLE}

你负责 spec 层：${ROOT}/DESIGN.md 与 ${ROOT}/macos/src/styles/tokens.css。

1. 跑 python3 ${ROOT}/tools/token-drift.py ${ROOT}，记下退出码与完整输出。非 0 即 blocker。
2. 复算 --bg-selected-table-solid 两个主题的值。公式 c = a·前景 + (1−a)·背景，逐通道四舍五入。
   深色：rgba(62,214,227,0.08) over #101116；浅色：rgba(10,157,176,0.07) over #f3f4f6。
   自己用 python3 算，跟 tokens.css 里落的值比。差 1 以内算通过，差更多是 major。
3. 检查新 token 是否在深色 :root、浅色 @media 段、浅色 [data-theme="light"] 段**三处**都有
   （颜色类 token 必须三处齐全；纯尺寸 token 只在裸 :root 一处是正确的）。缺一处是 blocker。
4. 检查 DESIGN.md 新增的 4.1.1 节：宽度预算的数字加得起来吗？固定列合计和总和自己加一遍。
5. 检查 DESIGN.md 2.2.1 节第 2 条缺口（渠道表无外框）是否被正确标记为已解决，且解决方式与
   实际代码一致（去 Table.module.css 核对）。
6. grep 两个文件里所有形如「DESIGN.md 第 X 节」「§X」的注释引用，逐条确认被引章节真实存在
   且说的是那回事。伪造引用报 major。`, { label: 'verify:spec', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

你负责原语层：${ROOT}/macos/src/components/Table.tsx 与 Table.module.css。

1. 回归面：grep 全工程（${ROOT}/macos/src）所有 <Table、<Th、<Td 的使用处，逐个视图确认
   原语改动不会破坏它们既有的表现。特别检查 .truncate、numeric、mono、dense、stickyHeader、
   minWidth 这六个既有 API 的行为有没有被改变。有任何一个被改是 blocker。
2. 外框与圆角：如果 border 加在 .table 上而 border-collapse 是 collapse，圆角会被单元格边
   覆盖——检查实现落在哪里、是否真能显示圆角。如果 .scroll 同时有 overflow-x: auto 和
   border-radius，验证圆角处内容是否被正确裁切（需要 overflow: hidden 才裁，但那会杀掉横滚，
   正确解法通常是 overflow-x: auto + overflow-y: hidden 或不裁）。把你的判断写进 notes。
3. table-layout 的选择：看它选了 fixed 还是 auto，注释里的理由站得住吗？
   fixed 下 colgroup 严格生效但内容不撑开；auto 下 colgroup 只是建议值、长内容仍会撑宽列。
   如果选了 auto 却指望 colgroup 限死 240px，那 1440px 不横滚的目标就落不了地——报 major。
4. sticky 遮罩：确认用的是伪元素叠 linear-gradient 而不是 mask-image。
   如果用了 mask-image 且没写 -webkit- 前缀，报 blocker（safari15）。
   grep 有没有 :has()、容器查询、@property——有就是 blocker。
5. 中截断：确认它真的保留尾部。如果实现退化成 text-overflow: ellipsis（砍尾部），
   报 blocker——尾部日期是这条需求的全部意义。
6. z-index 有没有写魔法数字而不是 var(--z-sticky)。`, { label: 'verify:primitive', phase: 'Verify', schema: VERIFY_SCHEMA }),

  () => agent(`${VERIFY_PREAMBLE}

你负责视图层：${ROOT}/macos/src/views/channels/**。

1. 宽度预算复算。读 <colgroup> 里每列的实际宽度值（解析 token 要去 tokens.css 查数值），
   用 python3 加两遍：备注取 min、备注取 max。两个结果都必须 ≤ 1160px
   （1440 − 侧栏 232 − padding 48）。超了报 blocker，把算式写进 detail。
2. sticky 不透明。grep views/channels 下所有 sticky 相关的 background，确认没有任何
   rgba(...) 半透明值残留，也没有 var(--bg-selected-table)（那是半透明的，
   solid 版才对）。半透明残留是 blocker——这是本批要修的核心 bug。
3. 两套 sticky 实现并存检查：视图的 .actionHeader 与原语的 .stickyAction 是不是都还在、
   都还生效？并存报 major。
4. 已隐藏分区行（.groupRow / .groupCell）的背景在横滚时会不会透字？确认已处理成不透明。
5. 模型列：确认尾部日期可见（中截断而非 ellipsis），且完整值挂在 title 上。
6. 备注列：确认两行截断用的是 -webkit-line-clamp + display: -webkit-box（safari15 可用），
   而不是 line-clamp 无前缀写法。
7. 越界检查：view-channels 只许改 views/channels/**。grep 一下它有没有顺手改别处
   （看不到别的文件的修改时间就靠内容判断：视图里有没有出现应该在 tokens.css 定义的新色值、
   有没有内联十六进制色值）。视图自创色值是 blocker。`, { label: 'verify:channels', phase: 'Verify', schema: VERIFY_SCHEMA }),
])

const blockers = verdicts.filter(Boolean).flatMap(v => (v.violations ?? []).filter(x => x.severity === 'blocker'))
log(`复核完成：${verdicts.filter(Boolean).length}/3 返回，blocker ${blockers.length} 个`)

return {
  batch: 3,
  spec,
  primitive: prim,
  channels: chan,
  verdicts,
  blockers,
}
