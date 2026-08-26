import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * 量出容器的真实像素宽度，让 viewBox 与像素 1:1 对齐。
 *
 * 这样 `preserveAspectRatio="none"` 不会产生任何拉伸（比例恒为 1），
 * 图里的文字与线宽都保持原样——DESIGN.md 要的是自适应，不是被拉扁的字。
 */
export function useChartWidth(fallback: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => {
      const next = node.clientWidth;
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
