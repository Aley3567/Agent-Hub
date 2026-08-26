/**
 * 类名拼接。自己实现，README.md 的依赖白名单不含 clsx / classnames。
 */

export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

export function cx(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined || value === false || value === '') continue;
    if (typeof value === 'string') {
      out.push(value);
    } else if (typeof value === 'number') {
      // `count && styles.x` 在 count 为 0 时会得到 0，这里当假值跳过
      if (value !== 0) out.push(String(value));
    } else if (Array.isArray(value)) {
      const nested = cx(...value);
      if (nested) out.push(nested);
    } else {
      for (const key of Object.keys(value)) {
        if (value[key]) out.push(key);
      }
    }
  }
  return out.join(' ');
}
