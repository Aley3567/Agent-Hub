/**
 * 失败记录的人话层。纯函数，不碰 React。
 *
 * 错误流水里躺着的是 status / exc / phase 这几个机器字段，直接摆出来等于把排查工作全丢给用户。
 * 这里做三件事，且只做这三件：
 *   1. 把 phase 翻成中文阶段名（原值仍然显示，机器码绝不隐藏）；
 *   2. status 为空而 exc 有值时说清「连接中断，上游未给出错误体」，而不是留一格空白；
 *   3. 给一句下一步该看哪里。
 * 不做的事：不改写上游的 message（原样脱敏后交给 CodeBlock），不猜上游为什么失败。
 */
import type { StatusToneInput } from '../../../components';
import { redactSecrets } from '../../../lib';
import type { ErrorRow } from '../../../types/contract';

/** 失败分档。tone 的取法：5xx 与连接中断算红（链路坏了），4xx 算琥珀（上游明确回绝了），其余灰 */
export type FailureKind = 'server' | 'client' | 'aborted' | 'unknown';

export const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
  server: '上游服务端错误',
  client: '请求被拒',
  aborted: '连接中断',
  unknown: '状态不明',
};

export const FAILURE_KINDS: FailureKind[] = ['server', 'client', 'aborted', 'unknown'];

export const FAILURE_KIND_TONE: Record<FailureKind, StatusToneInput> = {
  server: 'fail',
  client: 'degraded',
  aborted: 'fail',
  unknown: 'off',
};

/** journal 的 phase 字段翻成中文阶段名；不认识的原样显示 */
const PHASE_LABEL: Record<string, string> = {
  connect: '建立连接',
  request: '发送请求',
  response: '读取响应',
  stream: '流式传输',
};

/** 连接断在哪个阶段，决定「已经拿到的东西还算不算数」，这是最值钱的一句 */
const PHASE_STORY: Record<string, string> = {
  connect: '还没连上上游就断了，这一轮什么都没发出去。',
  request: '请求已经发出去，上游没有把回应说完。',
  response: '上游回了响应头，读响应体时断了。',
  stream: '流已经开始，中途被切断——之前收到的内容是真的，但这一轮没有正常收尾。',
};

interface StatusGloss {
  /** 状态码的一句中文注解 */
  note: string;
  /** 下一步该看哪里 */
  hint: string;
}

const STATUS_GLOSS: Record<number, StatusGloss> = {
  400: {
    note: '上游认为请求本身不合法',
    hint: '看下面的原文：多半是某个字段的形状上游不接受。协议桥默认放行方言，所以这类拒绝通常来自上游而不是转换。',
  },
  401: {
    note: '凭证被拒',
    hint: '桌面端只显示凭证「已配置 / 未配置」，具体值要去 CC Switch 里核对，本工具不读也不显示 key。',
  },
  403: {
    note: '凭证有效但没有权限',
    hint: '确认这个 key 是否开通了该模型；换个模型或换渠道试一轮就能区分是账号权限还是模型权限。',
  },
  404: {
    note: '上游没有这个路径',
    hint: '核对渠道端点：BASE_URL 末尾是否多写或漏写了 /v1 这类路径段。',
  },
  405: {
    note: '上游不接受这个请求方法',
    hint: '端点对得上却报 405 时，多半是上游网关的路由问题而不是本机配置；隔一段时间用同一渠道再跑一轮，看是不是一直如此。',
  },
  408: {
    note: '上游等超时了',
    hint: '缩短单轮输入或降低并发再试；连续超时就换渠道，本机改不动上游的等待时间。',
  },
  413: {
    note: '请求体超过上游上限',
    hint: '这一轮的上下文太大。裁历史、或换一个上下文窗口更大的渠道。',
  },
  422: {
    note: '上游校验不通过',
    hint: '看原文里指的是哪个字段；工具参数 schema 被规整过的场景会记 HUB_DEGRADE_SCHEMA_NORMALIZED，可以到降级区对一下时间。',
  },
  429: {
    note: '被限流',
    hint: '降低并发或等一会儿再试。配了账号池的渠道会自动轮换，可以到账号池视图看是不是所有成员都在冷却。',
  },
  500: { note: '上游内部错误', hint: '上游服务端的问题，本机配置改不动它；换渠道或换槽位继续干活，回头再看是不是一直如此。' },
  502: { note: '上游网关拿不到后端', hint: '同 500：这是上游链路的问题。连续出现就先换渠道。' },
  503: { note: '上游暂时不可用', hint: '通常是过载或维护，隔几分钟再试；同一时间点多个渠道都 503 才需要怀疑本机出网。' },
  504: { note: '上游网关超时', hint: '上游后端没在网关的时限内回话。缩短单轮输入或换渠道。' },
};

const CLASS_HINT: Record<FailureKind, string> = {
  server: '上游服务端的问题，本机配置改不动它；换渠道或换槽位继续干活。',
  client: '上游明确回绝了这次请求，状态码与错误体都是原样转下来的，按上游文档解读下面的原文。',
  aborted: '没有 HTTP 状态可查，只能按时间点去 hub 日志里对齐同一轮请求。',
  unknown: '这条记录既没有状态码也没有异常类型，能给出的线索只有时间、渠道和阶段。',
};

export interface FailureNarrative {
  kind: FailureKind;
  tone: StatusToneInput;
  /** 状态列显示值：有状态码就是数字，没有就是「连接中断」这类中文说明 */
  statusText: string;
  /** 状态列下面那行小字，没有就 null */
  statusNote: string | null;
  /** 阶段的中文名 */
  phaseLabel: string;
  /** 阶段原值，机器码不隐藏；journal 没写时为 null */
  phaseRaw: string | null;
  /** 原因列显示的一行：有 message 就是 message 的首行，没有就用人话解释顶上 */
  headline: string;
  /** 这条失败在说什么，一句人话，永不为空 */
  explain: string;
  /** 下一步该看哪里。分档兜底保证它永不为空 */
  hint: string;
  /** 脱敏后的原始 message；journal 没记就是 null */
  message: string | null;
}

function firstLine(text: string): string {
  const index = text.indexOf('\n');
  return index < 0 ? text : text.slice(0, index);
}

function classify(status: number | null, exc: string): FailureKind {
  if (status === null) return exc === '' ? 'unknown' : 'aborted';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}

/**
 * 把一行错误流水翻成可读的叙述。message 在这里就过一遍脱敏（CONTRACT.md 第 1.2 节要求
 * UI 渲染前再脱一次），下游的 CodeBlock 还会再脱一次，两道闸都留着。
 */
export function describeFailure(row: ErrorRow): FailureNarrative {
  const exc = (row.exc ?? '').trim();
  const code = (row.code ?? '').trim();
  const rawMessage = redactSecrets(row.message).trim();
  const message = rawMessage === '' ? null : rawMessage;
  const phaseRaw = row.phase === '' ? null : row.phase;
  const phaseLabel = phaseRaw === null ? '未记录' : (PHASE_LABEL[phaseRaw] ?? phaseRaw);
  const kind = classify(row.status, exc);
  const gloss = row.status === null ? undefined : STATUS_GLOSS[row.status];

  let statusText: string;
  let statusNote: string | null;
  let explain: string;

  if (row.status !== null) {
    statusText = String(row.status);
    statusNote = gloss?.note ?? null;
    const head = gloss === undefined ? `上游返回了 HTTP ${row.status}` : `上游返回 HTTP ${row.status}：${gloss.note}`;
    // 只说流水里确实有什么，不替协议桥宣称「原样转给了下游」——
    // 那件事有 HUB_DEGRADE_UPSTREAM_ERROR_DETAIL_DROPPED 这种反例，不能一概而论。
    const tail =
      message !== null
        ? '下面是错误流水里记下的原文（已脱敏）。'
        : code !== ''
          ? `错误流水里没有 message，只记下了错误 code ${code}。`
          : '错误流水里连 message 都没有记下。';
    explain = `在「${phaseLabel}」阶段，${head}。${tail}`;
  } else if (exc !== '') {
    statusText = '连接中断';
    statusNote = '上游未给出错误体';
    const story = PHASE_STORY[phaseRaw ?? ''] ?? '连接在中途断开了。';
    explain = `${story}没有 HTTP 状态，journal 里只留下异常类型 ${exc}。`;
  } else {
    statusText = '状态未记录';
    statusNote = null;
    explain = `在「${phaseLabel}」阶段记下了一次失败，但 journal 既没有状态码也没有异常类型。`;
  }

  return {
    kind,
    tone: FAILURE_KIND_TONE[kind],
    statusText,
    statusNote,
    phaseLabel,
    phaseRaw,
    headline: message === null ? explain : firstLine(message),
    explain,
    hint: gloss?.hint ?? CLASS_HINT[kind],
    message,
  };
}

/** 搜索用的干草堆：状态、阶段、异常类型、渠道、模型、原文、降级码都能搜到 */
export function failureHaystack(row: ErrorRow, narrative: FailureNarrative): string {
  return [
    narrative.statusText,
    row.status === null ? '' : String(row.status),
    narrative.phaseLabel,
    row.phase,
    row.exc ?? '',
    row.code ?? '',
    row.channel ?? '',
    row.model ?? '',
    row.format ?? '',
    row.route ?? '',
    narrative.message ?? '',
    ...row.deg,
  ]
    .join(' ')
    .toLowerCase();
}

/** 一行失败记录 + 它的叙述 + 搜索干草堆，一次算好，渲染时不再重复计算 */
export interface FailureItem {
  key: string;
  row: ErrorRow;
  narrative: FailureNarrative;
  haystack: string;
}

export function buildFailureItems(rows: readonly ErrorRow[]): FailureItem[] {
  return rows.map((row, index) => {
    const narrative = describeFailure(row);
    return { key: `fail-${index}`, row, narrative, haystack: failureHaystack(row, narrative) };
  });
}

/** 按失败类型统计条数，供汇总条使用 */
export function tallyFailureKinds(items: readonly FailureItem[]): Record<FailureKind, number> {
  const tally: Record<FailureKind, number> = { server: 0, client: 0, aborted: 0, unknown: 0 };
  for (const item of items) tally[item.narrative.kind] += 1;
  return tally;
}
