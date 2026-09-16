import { t } from '../../i18n';
/**
 * 计划任务三种 kind 的中文人话与徽章配色（DESIGN.md 第 4.7 节）。
 * 卡片与新建/编辑对话框共用，避免两处各写一套。
 */
import type { BadgeTone } from '../../components';
import type { ScheduledTask } from '../../types/contract';

export type TaskKind = ScheduledTask['kind'];

export const KIND_LABEL: Record<TaskKind, string> = {
  get 'launch-channel'() { return t("启动渠道"); },
  get 'launch-slot'() { return t("启动槽位"); },
  get 'doctor-reminder'() { return t("体检提醒"); },
};

/** 颜色只表达语义（DESIGN.md 第 1 节）：启动类用 accent/violet 区分目标粒度，提醒类用中性灰 */
export const KIND_TONE: Record<TaskKind, BadgeTone> = {
  'launch-channel': 'accent',
  'launch-slot': 'violet',
  'doctor-reminder': 'neutral',
};
