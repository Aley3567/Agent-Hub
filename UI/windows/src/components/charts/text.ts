/**
 * SVG 里没有 text-overflow，长标签得自己截。
 * 按字符类别估宽：CJK 约等于字号，等宽拉丁字符约 0.6 倍字号。
 */
function charWidth(ch: string, fontSize: number): number {
  const code = ch.codePointAt(0) ?? 0;
  const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6);
  return wide ? fontSize : fontSize * 0.6;
}

export function approxTextWidth(text: string, fontSize: number): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch, fontSize);
  return total;
}

/** 超宽就截断并补省略号；完整值由调用方放到 title 里 */
export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return '';
  if (approxTextWidth(text, fontSize) <= maxWidth) return text;
  const ellipsis = '…';
  const budget = maxWidth - approxTextWidth(ellipsis, fontSize);
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = charWidth(ch, fontSize);
    if (used + w > budget) break;
    used += w;
    out += ch;
  }
  return `${out}${ellipsis}`;
}
