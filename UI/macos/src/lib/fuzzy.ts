/**
 * 子序列模糊匹配，供命令面板高亮用（DESIGN.md 第 4.3 节：子序列匹配即可，不引 fuse.js）。
 */

export interface FuzzyMatchResult {
  /** 是否命中 */
  matched: boolean;
  /** matched 的别名，方便调用方任选写法 */
  hit: boolean;
  /** 命中的字符在 text 中的下标，升序，用于高亮 */
  indices: number[];
  /** 越大越靠前：连续命中与词首命中加分 */
  score: number;
}

const WORD_BOUNDARY = new Set([' ', '-', '_', '.', '/', ':', '(', ')', '[', ']', '，', '、', '：']);

const NO_MATCH: FuzzyMatchResult = { matched: false, hit: false, indices: [], score: 0 };

/**
 * query 的字符按顺序出现在 text 中即命中（大小写不敏感）。
 * 空 query 视为全部命中且无高亮，这样列表在没输入时显示全量。
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatchResult {
  const rawQuery = (query ?? '').trim();
  const target = text ?? '';
  if (rawQuery === '') return { matched: true, hit: true, indices: [], score: 0 };
  if (target === '') return { ...NO_MATCH };

  const q = rawQuery.toLowerCase();
  const t = target.toLowerCase();
  const indices: number[] = [];
  let cursor = 0;
  let score = 0;
  let previous = -2;

  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    if (ch === ' ') continue;
    let found = -1;
    while (cursor < t.length) {
      if (t[cursor] === ch) {
        found = cursor;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    if (found < 0) return { ...NO_MATCH };
    indices.push(found);
    score += 1;
    if (found === previous + 1) score += 3;
    if (found === 0 || WORD_BOUNDARY.has(t[found - 1])) score += 2;
    previous = found;
  }

  if (indices.length === 0) return { matched: true, hit: true, indices: [], score: 0 };
  // 命中位置越靠前越好，用很小的权重做微调，避免压过连续命中的加分
  score -= indices[0] * 0.05;
  return { matched: true, hit: true, indices, score };
}
