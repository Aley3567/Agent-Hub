/**
 * 通用组件原语出口（CONTRACT.md 第 6.3 节）。
 *
 * 这一层是纯展示层：不取数据、不 import store、不 import api，一切靠 props 传进来。
 * 视图需要自己的新原语时放在各自目录的 parts/ 下，不要往这里加。
 */

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { IconButton, type IconButtonProps, type IconButtonVariant } from './IconButton';
export { Input, type InputProps } from './Input';
export { Textarea, type TextareaProps } from './Textarea';
export { Select, type SelectProps, type SelectOption } from './Select';
export { Switch, type SwitchProps } from './Switch';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './SegmentedControl';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { StatusDot, type StatusDotProps, type StatusTone, type StatusToneInput } from './StatusDot';
export { Tooltip, type TooltipProps, type TooltipSide } from './Tooltip';
export { Dialog, type DialogProps } from './Dialog';
export {
  Table,
  Th,
  Td,
  MidTruncate,
  type TableProps,
  type ThProps,
  type TdProps,
  type MidTruncateProps,
} from './Table';
export { EmptyState, type EmptyStateProps, type EmptyStateAction } from './EmptyState';
export { CodeBlock, type CodeBlockProps } from './CodeBlock';
export { Spinner, type SpinnerProps, type SpinnerSize } from './Spinner';
export { Field, type FieldProps } from './Field';
export { Card, type CardProps } from './Card';
export { SectionHeader, type SectionHeaderProps } from './SectionHeader';
export { Toolbar, type ToolbarProps } from './Toolbar';
export { SearchInput, type SearchInputProps } from './SearchInput';
export { Icon, type IconProps, type IconName } from './Icon';
export { BrandMark, type BrandMarkProps } from './BrandMark';

/** 图表原语的正规入口是 './charts'，这里一并转出，省得调用方两处 import */
export {
  Sparkline,
  BarChart,
  TimeSeries,
  Donut,
  type SparklineProps,
  type SparklinePoint,
  type BarChartProps,
  type BarChartDatum,
  type TimeSeriesProps,
  type TimeSeriesPoint,
  type TimeSeriesKey,
  type DonutProps,
} from './charts';
