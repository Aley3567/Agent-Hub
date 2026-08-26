/**
 * 降级码人话目录 —— 唯一文案来源。
 *
 * 协议桥遇到上游方言时默认放行并记一条 `HUB_DEGRADE_*`（见仓库 AGENTS.md 的三档策略）。
 * 这些码是给机器看的；本文件把每一个码翻译成三句人话：发生了什么、对你的影响、该怎么办。
 *
 * 严重度口径：
 *   info     —— 纯噪音过滤，上游多说了几句我们没听，结果没变。不用管。
 *   notice   —— 语义等价映射，换了个说法表达同一件事。知道就行。
 *   degraded —— 确实少了东西，但这轮结果仍然可用。
 *   lossy    —— 少掉的东西你会在意：钱、可复现性或原始证据。值得处理。
 *
 * 内容由编排者审定，不要在移植时改写措辞——两个平台工程必须逐字一致。
 */
import type { StatusTone } from '../components';

export type DegradeSeverity = 'info' | 'notice' | 'degraded' | 'lossy';

export interface DegradeEntry {
  code: string;
  title: string;
  what: string;
  impact: string;
  action: string;
  severity: DegradeSeverity;
}

export const SEVERITY_ORDER: Record<DegradeSeverity, number> = {
  lossy: 0,
  degraded: 1,
  notice: 2,
  info: 3,
};

export const SEVERITY_LABEL: Record<DegradeSeverity, string> = {
  lossy: '有损',
  degraded: '降级',
  notice: '已换算',
  info: '提示',
};

/**
 * 严重度 → StatusDot 语义色，DESIGN.md 第 4.4 节写死：
 * info 灰点、notice 青点、degraded 琥珀点、lossy 琥珀点（标题另外加粗）。
 * 单点定义在这里，channels 与 diagnostics 视图都从本文件取，不再各写一份。
 */
export const SEVERITY_TONE: Record<DegradeSeverity, StatusTone> = {
  info: 'off',
  notice: 'current',
  degraded: 'degraded',
  lossy: 'degraded',
};

export const DEGRADE_CATALOG: DegradeEntry[] = [
  {
    code: 'HUB_DEGRADE_CACHE_CONTROL_DROPPED',
    title: '提示缓存标记被丢弃',
    what: '请求顶层带了 cache_control，但这个渠道的协议没有等价字段，标记没能发出去。',
    impact: '这一轮不会命中提示缓存，长上下文会按全量输入计费，账单明显变高。',
    action: '把重活固定到 anthropic 原生格式的渠道；跨协议渠道适合放短上下文任务。',
    severity: 'lossy',
  },
  {
    code: 'HUB_DEGRADE_CONTENT_METADATA_DROPPED',
    title: '内容块上的缓存标记被丢弃',
    what: '某个内容块自带 cache_control，目标协议无处安放。',
    impact: '该块不进缓存，重复发送同一段长文本要反复付输入费。',
    action: '同上：需要缓存命中的会话别走跨协议渠道。',
    severity: 'lossy',
  },
  {
    code: 'HUB_DEGRADE_THINKING_SIGNATURE_DROPPED',
    title: '思考签名未转发',
    what: 'thinking 块带着 Anthropic 的签名，但这条链路无法安全转发它——签名绝不伪造。',
    impact: '思考内容还在，可验证性没了；依赖签名回放思考链的场景会失效。',
    action: '需要签名完整时走原生 anthropic 渠道。',
    severity: 'lossy',
  },
  {
    code: 'HUB_DEGRADE_UNSIGNED_THINKING',
    title: '思考内容没有签名',
    what: '上游给了思考文本但没给签名，我们照原样交付，不补造。',
    impact: '思考可读但不可验证，不能作为可信凭据回传。',
    action: '当参考读物看，别当审计证据用。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_CITATION_METADATA_DROPPED',
    title: '引用出处被丢弃',
    what: '内容带 citations，目标协议没有承载引用的结构，文本保留、出处丢失。',
    impact: '看得到结论，看不到它引自哪一段——需要溯源的工作会卡住。',
    action: '要引用链就走原生渠道；这里的引文不要直接采信。',
    severity: 'lossy',
  },
  {
    code: 'HUB_DEGRADE_DOCUMENT_PLACEHOLDER',
    title: '文档无法提取，只发了占位说明',
    what: '附件是合法的 base64 或 URL，但提不出文本，只能发一段占位描述过去。',
    impact: '模型实际上没读到文档内容，基于它的回答不可信。',
    action: '把文档转成纯文本或 Markdown 再发，或换支持原生附件的渠道。',
    severity: 'lossy',
  },
  {
    code: 'HUB_DEGRADE_DOCUMENT_TEXT_EXTRACTED',
    title: '文档被抽成纯文本',
    what: '附件里能提取出文本，已按纯文本发送。',
    impact: '文字在，排版、表格结构和页码定位没了。',
    action: '表格密集的文档建议自己整理成 Markdown 再发，效果更稳。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_DOCUMENT_CONTEXT_TEXTIFIED',
    title: '文档的上下文说明被转成文本',
    what: 'document.context 是模型的阅读提示，目标协议没有对应字段，已并入正文文本。',
    impact: '提示还在，但和文档正文混在一起，模型可能当成内容而非指引。',
    action: '关键指引写进 system 或用户消息里更可靠。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_SEARCH_RESULT_TEXTIFIED',
    title: '搜索结果被转成文本',
    what: 'search_result 结构被展平成文本发送。',
    impact: '内容保留，来源与结果边界变模糊。',
    action: '一般无需处理；需要结构化引用时走原生渠道。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_TOOL_RESULT_CONTENT_ENVELOPED',
    title: '工具结果被包了一层可见外壳',
    what: 'tool_result 的内容不是纯字符串（通常是内容块数组），已包成可见的文本外壳。',
    impact: '信息不丢，但模型看到的是被包装过的形状，极少数情况下会影响它的解析。',
    action: '不用处理。工具反复误读结果时，把工具输出改成纯文本。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_TOOL_RESULT_ERROR_ENVELOPED',
    title: '工具失败状态改用文本表达',
    what: 'tool_result 标了 is_error，目标协议没有错误位，改为在文本里显式说明失败。',
    impact: '模型仍能看出工具失败了，但不再是结构化标志。',
    action: '不用处理。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_SYNTHETIC_TOOL_ID',
    title: '工具调用 id 由本地补发',
    what: '上游没给 tool_use id，为了维持调用与结果的因果配对，本地生成了一个。',
    impact: '本轮配对正确；但这个 id 在上游侧不存在，跨系统对账会找不到。',
    action: '排查上游行为时以时间与模型名为线索，别拿这个 id 去上游查。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_SCHEMA_NORMALIZED',
    title: '工具参数 schema 被规整',
    what: '工具的 JSON Schema 里有目标不接受的写法（如 format: "uri"），已清理后照常发送。',
    impact: '工具照常可用，个别格式校验由模型自行把握，可能放松。',
    action: '不用处理。参数格式很严格时，在工具描述里用文字重申。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_TOOL_METADATA_DROPPED',
    title: '工具的附加元数据被丢弃',
    what: '工具定义带了 cache_control 或 input_examples，目标协议无处安放。',
    impact: '工具能用；示例没传到，模型少了几个照着学的样例。',
    action: '把关键示例写进工具的 description 里，那个字段一定会送到。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_DEFERRED_TOOL_EAGERLY_LOADED',
    title: '延迟加载的工具被一次性全量加载',
    what: '工具声明了 defer_loading，目标协议不支持按需加载，只能全部提前送上。',
    impact: '功能不变，但工具定义占满输入 token，长工具集会明显推高成本。',
    action: '在这类渠道上精简工具集；工具很多时优先用原生渠道。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_TOOL_SEARCH_OMITTED',
    title: '工具搜索能力被省略',
    what: '请求要求用 tool_search 动态检索工具，目标渠道没有这个能力，控制项被省略。',
    impact: '模型只能用已经明确给出的工具，不会再去检索更多。',
    action: '把这轮真正需要的工具直接列出来。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_BATCH_TOOL_OMITTED',
    title: '批量工具未传递',
    what: '请求含 BatchTool，目标协议没有能安全对应的表达，已省略。',
    impact: '并行批量调用退化为逐个调用，慢一些，结果不变。',
    action: '不用处理；对延迟敏感时走原生渠道。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_THINKING_TO_REASONING',
    title: '思考被换算成 reasoning',
    what: 'Anthropic 的 thinking 块转成了目标协议的 reasoning 表达。',
    impact: '语义等价，思考内容照常返回。',
    action: '不用处理。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_THINKING_TO_EFFORT',
    title: 'thinking.effort 换算为 reasoning effort',
    what: '旧式 thinking.effort 被映射到目标的 reasoning effort 档位。',
    impact: '档位对应，思考深度大体保持。',
    action: '不用处理。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_THINKING_BUDGET_TO_EFFORT',
    title: '思考预算换算为 effort 档位',
    what: '请求给的是 budget_tokens（具体 token 数），目标只认 low/medium/high 这类档位，已按量换档。',
    impact: '思考量不再精确等于你指定的 token 数，只是最接近的一档。',
    action: '要精确控制思考预算就走原生渠道；否则直接用 effort 表达意图更省心。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_ADAPTIVE_THINKING_TO_EFFORT',
    title: '自适应思考换算为默认档位',
    what: 'thinking 是 adaptive 且没给预算或档位，目标协议需要一个具体档位，已取默认值。',
    impact: '思考量由默认档决定，不再随任务自动伸缩。',
    action: '对思考深度有要求时显式指定 effort。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_EMPTY_THINKING_SIGNATURE_IGNORED',
    title: '空的思考签名被忽略',
    what: 'thinking 块的 signature 是空字符串，按无签名处理，思考文本保留。',
    impact: '没有实际影响。',
    action: '不用处理。',
    severity: 'info',
  },
  {
    code: 'HUB_DEGRADE_REASONING_FENCE_EXTRACTED',
    title: '推理内容从正文围栏中提取',
    what: '上游把推理塞在正文的围栏标记里，已识别并提取为独立的思考块。',
    impact: '正文更干净；提取依赖上游格式，个别写法可能漏提。',
    action: '正文里出现残留的思考片段时，反馈给作者补规则。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_SYSTEM_ROLE_PROMOTED',
    title: 'system 消息被提升为顶层',
    what: '消息列表里出现 system 角色，已提升为目标接受的顶层 system 形式。',
    impact: '指令仍然生效，位置从对话中间移到了开头。',
    action: '不用处理。依赖"中途换 system"的用法要留意生效时机变了。',
    severity: 'notice',
  },
  {
    code: 'HUB_DEGRADE_SYSTEM_METADATA_DROPPED',
    title: 'system 块的附加字段被丢弃',
    what: 'system 文本块除了 type/text 还带了别的字段，正文保留、附加字段丢弃。',
    impact: '提示词内容完整，附加语义（如缓存标记）没送到。',
    action: '通常不用处理；若丢的是 cache_control，参见缓存标记条目。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_METADATA_DROPPED',
    title: '请求 metadata 被丢弃',
    what: '请求的 metadata（如 user_id）在这个目标协议里没有等价载体。',
    impact: '模型行为不变；上游侧按用户维度的统计与限流会丢失归属。',
    action: '需要按用户归因时走原生或 Responses 格式渠道。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_CONTEXT_MANAGEMENT_DROPPED',
    title: '上下文管理指令被丢弃',
    what: '请求带 context_management，目标适配器无法表达，已丢弃。',
    impact: '上下文不会按你要求的策略自动裁剪，长会话更容易撞窗口上限。',
    action: '自己控制历史长度，或走支持该字段的渠道。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_STOP_SEQUENCES_DROPPED',
    title: '停止序列被丢弃',
    what: 'stop_sequences 在目标协议里没有对应字段。',
    impact: '模型不会在你指定的字符串处刹车，输出可能超出预期长度或格式。',
    action: '在提示里用文字约定结束标记，并自行截断。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_TOP_K_DROPPED',
    title: 'top_k 被丢弃',
    what: '目标协议没有 top_k 采样参数。',
    impact: '采样分布略有不同，输出随机性可能比预期高。',
    action: '用 temperature 或 top_p 达到近似效果。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_UNKNOWN_REQUEST_FIELD_DROPPED',
    title: '请求里有不认识的字段，已丢弃',
    what: '顶层出现协议桥不认识的字段，按"默认放行"策略丢弃该字段后照常发送。',
    impact: '大多数情况没影响；如果那个字段承载了你真正需要的能力，本轮就没生效。',
    action: '这个码频繁出现且结果不对时，把它连同你的请求形状报给作者补支持。',
    severity: 'degraded',
  },
  {
    code: 'HUB_DEGRADE_LATE_INPUT_USAGE',
    title: '输入用量在流末才到',
    what: '上游没在开头给输入 token 数，直到流结束才补上。',
    impact: '记账最终是准的；流进行中的实时用量显示会偏低。',
    action: '不用处理，看最终统计即可。',
    severity: 'info',
  },
  {
    code: 'HUB_DEGRADE_STREAM_SEQUENCE_METADATA_DROPPED',
    title: '流里的序号类元数据被跳过',
    what: '上游 SSE 带了自有的序号或批次字段，转换时未使用。',
    impact: '不影响内容与终态。',
    action: '不用处理。',
    severity: 'info',
  },
  {
    code: 'HUB_DEGRADE_UPSTREAM_RESPONSE_METADATA_DROPPED',
    title: '上游响应的额外字段被跳过',
    what: '上游在响应或 SSE 里附了我们不消费的字段（如 token_ids、prompt_text 之类的调试信息）。',
    impact: '不影响内容。这条码存在的意义是：以前这种情况会直接报 502，现在放行。',
    action: '不用处理。',
    severity: 'info',
  },
  {
    code: 'HUB_DEGRADE_DUPLICATE_TERMINAL_SKIPPED',
    title: '重复的流终态被跳过',
    what: '上游发了不止一次结束事件，只采信第一个真实终态。',
    impact: '下游拿到一个干净的结束信号，不影响内容。',
    action: '不用处理。',
    severity: 'info',
  },
  {
    code: 'HUB_DEGRADE_UPSTREAM_ERROR_DETAIL_DROPPED',
    title: '上游错误详情部分丢失',
    what: '上游错误体里有无法安全转成 Anthropic 错误形状的细节，已丢弃那部分。',
    impact: '错误类型和状态码是真的，但排查线索可能少了一截。',
    action: '要看完整原始错误，去 ~/.cc-switch/logs/ 下的 hub 日志里查同一时间点。',
    severity: 'degraded',
  },
];

const BY_CODE = new Map(DEGRADE_CATALOG.map((entry) => [entry.code, entry]));

/** 未收录的码也要能显示——绝不因为不认识就藏起来。 */
export function lookupDegrade(code: string): DegradeEntry {
  const hit = BY_CODE.get(code);
  if (hit) return hit;
  return {
    code,
    // CONTRACT.md 第 5 节：未收录的码直接显示原码当标题，不转写成英文 slug
    title: code,
    what: '未收录的降级类型，请把这个码发给作者。',
    impact: '影响未知。协议桥选择了放行而不是报错，所以这一轮的结果应该是可用的。',
    action: '把这个码连同发生时间发给作者，补进目录。',
    severity: 'degraded',
  };
}

export function compareDegrade(a: string, b: string): number {
  return SEVERITY_ORDER[lookupDegrade(a).severity] - SEVERITY_ORDER[lookupDegrade(b).severity];
}

/** 一批码里最严重的那一档，用于给回合定色。 */
export function worstSeverity(codes: readonly string[]): DegradeSeverity | null {
  if (codes.length === 0) return null;
  return codes
    .map((c) => lookupDegrade(c).severity)
    .reduce((worst, s) => (SEVERITY_ORDER[s] < SEVERITY_ORDER[worst] ? s : worst));
}
