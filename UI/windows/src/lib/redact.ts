/**
 * 前端兜底脱敏。
 *
 * 凭证本该在 Rust 侧就被剥离（CONTRACT.md 第 1.2 节），这里是 fail-closed 的第二道闸：
 * 任何要渲染成文本的上游内容（错误 message、命令回显、notes）都先过一遍。
 *
 * 长串规则刻意只吃 [A-Za-z0-9+/] 这一类连续串，不把 `-` 与 `_` 纳入串内：
 * 否则 `claude-opus-4-1-20250805` 这类模型 id 会被整段打码，用户就看不见自己到底跑了什么模型了。
 * 带前缀的凭证（sk-、Bearer、key=value）由前面三条专门规则兜住，不依赖长串规则。
 */

/** 脱敏后的替代文本 */
export const MASK = '••••';

const SENSITIVE_KEY = [
  'authorization',
  'x-api-key',
  'api[-_]?key',
  'auth[-_]?token',
  'access[-_]?token',
  'refresh[-_]?token',
  'bearer[-_]?token',
  'session[-_]?key',
  'secret[-_]?key',
  'private[-_]?key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'cookie',
].join('|');

// key: "值" / KEY=值 —— 值的字符类不含引号，所以右引号留在匹配之外，替换后 JSON 依旧配对。
// 中间那段可选的 bearer/basic/token 是为了让 `Authorization: Bearer <jwt>` 整段被吃掉，
// 而不是只打掉 "Bearer" 四个字母把真正的 token 留在界面上。
const KEY_VALUE = new RegExp(
  `((?:${SENSITIVE_KEY})["']?\\s*[:=]\\s*)(["']?)(?:(?:bearer|basic|token)\\s+)?([^\\s"',;)}\\]]{4,})`,
  'gi',
);
const SK_PREFIX = /\bsk-[A-Za-z0-9_-]{6,}/g;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._+/=-]{6,}/gi;
const LONG_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;

/**
 * 返回脱敏后的字符串。入参为空返回空串——调用方要显示占位文案时自己决定说什么。
 */
export function redactSecrets(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  let out = String(s);
  out = out.replace(KEY_VALUE, (_match, head: string, quote: string) => `${head}${quote}${MASK}`);
  out = out.replace(SK_PREFIX, `sk-${MASK}`);
  out = out.replace(BEARER, (_match, scheme: string) => `${scheme} ${MASK}`);
  out = out.replace(LONG_RUN, MASK);
  return out;
}
