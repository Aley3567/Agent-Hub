/**
 * 历史项目选择器（DESIGN.md 4.5）：`~/.claude/projects` 下的一个目录 = 一份可回放的历史。
 *
 * 选中即调 select_chat_project，由 store 连带刷新 chatProjects 与 chat——列表里的历史
 * 会话会整批换成新项目的内容（本地会话不受影响）。选项 label 用真实项目路径：目录名
 * 为了能放进文件名做过转义，拿它当 label 用户认不出是哪个项目。
 *
 * 显示值取「本地乐观选择 → 真值」：点完立刻显示新项目，等后端回执与刷新到位再交给真值；
 * 失败时乐观值撤销、选择回退——接口没换，界面也不许先换。
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { Select } from '../../../components';
import { t } from '../../../i18n';
import { errorText, useApp } from '../../../store';
import { useToast } from '../../../store/toast';
import type { ChatProject } from '../../../types/contract';

export interface ProjectPickerProps {
  projects: ChatProject[];
  /** 当前选中项目的 key；null = 还没选中过（后端也没选过） */
  selectedKey: string | null;
  /** 项目列表还在读 */
  loading: boolean;
  /** 作用在包装元素上（宽度交给调用方定） */
  className?: string;
}

function ProjectPicker({ projects, selectedKey, loading, className }: ProjectPickerProps) {
  const selectChatProject = useApp((state) => state.selectChatProject);
  const toastError = useToast((state) => state.error);
  /** 点下去到真值跟上之间显示的选择；真值一到就退场 */
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (picked !== null && selectedKey === picked) setPicked(null);
  }, [picked, selectedKey]);

  const change = useCallback(
    (key: string): void => {
      if (key === '') return;
      setPicked(key);
      selectChatProject(key).catch((cause: unknown) => {
        setPicked(null);
        toastError(errorText(cause));
      });
    },
    [selectChatProject, toastError],
  );

  return (
    <Select
      wrapperClassName={className}
      selectSize="sm"
      mono
      aria-label={t('回放哪个项目的历史')}
      title={t('换项目只换回放的历史内容；本地会话不受影响')}
      value={picked ?? selectedKey ?? ''}
      disabled={loading || projects.length === 0}
      placeholder={projects.length === 0 ? t('没有找到可回放的历史项目') : t('选择要回放的历史项目')}
      options={projects.map((project) => ({ value: project.key, label: project.path }))}
      onChange={(event) => change(event.target.value)}
    />
  );
}

export default memo(ProjectPicker);
