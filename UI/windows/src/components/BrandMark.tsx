import type { ReactNode } from 'react';
import { cx } from '../lib';
import styles from './BrandMark.module.css';

export interface BrandMarkProps {
  /** 折叠态只显示图形；展开态同时显示字标 */
  collapsed?: boolean;
  /** 大号用于空态 hero */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Agent Hub 品牌标识。
 *
 * mark.svg 转成的内联 SVG；渐变 id 加了 ah- 前缀，避免与页面其他 SVG 的
 * <defs> 冲突（CONTRACT.md：同页面多个 SVG 必须能共存）。
 */
export function BrandMark({ collapsed = false, size = 'sm', className }: BrandMarkProps): ReactNode {
  const markSize = size === 'lg' ? 48 : size === 'md' ? 32 : 28;
  return (
    <div className={cx(styles.root, styles[size], collapsed && styles.collapsed, className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 256 256"
        role="img"
        aria-label="Agent Hub"
        width={markSize}
        height={markSize}
      >
        <defs>
          <linearGradient id="ah-left" x1="39" y1="222" x2="144" y2="30" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#06B6D4" />
            <stop offset="0.48" stopColor="#168BEE" />
            <stop offset="1" stopColor="#2563FF" />
          </linearGradient>
          <linearGradient id="ah-right" x1="128" y1="34" x2="229" y2="220" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#2563FF" />
            <stop offset="0.5" stopColor="#5948F4" />
            <stop offset="1" stopColor="#7C3AED" />
          </linearGradient>
          <linearGradient id="ah-fold" x1="111" y1="180" x2="199" y2="219" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F8FAFC" />
            <stop offset="0.52" stopColor="#E2E8F0" />
            <stop offset="1" stopColor="#B8C6E0" />
          </linearGradient>
          <linearGradient id="ah-navy" x1="107" y1="101" x2="159" y2="221" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#0F172A" />
            <stop offset="1" stopColor="#102A56" />
          </linearGradient>
        </defs>
        <path d="M128 68 62 217h138L142 74c-3-8-10-10-14-6Z" fill="url(#ah-navy)" />
        <path d="M112 199c18-17 41-30 67-40l22 54c-15-6-30-9-45-7-14 1-27 6-38 14-8 6-17 8-29 7 7-11 14-20 23-28Z" fill="url(#ah-fold)" />
        <path d="M42 226c-15 0-24-16-17-29l78-148c8-15 23-24 40-24h16c-15 4-26 14-33 28L64 214c-4 8-12 12-22 12Z" fill="url(#ah-left)" />
        <path d="M125 53c6-17 21-28 39-28 15 0 28 9 34 23l36 147c7 15-4 31-20 31-11 0-19-6-23-16L137 72c-3-8-7-14-12-19Z" fill="url(#ah-right)" />
      </svg>
      {collapsed ? null : <span className={styles.wordmark}>Agent Hub</span>}
    </div>
  );
}
