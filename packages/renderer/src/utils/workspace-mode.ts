type WorkspaceMode = 'local' | 'cloud';

export const workspaceModePresentation = (mode: WorkspaceMode) =>
  mode === 'local'
    ? {
        label: '本地工作区',
        description: '数据仅保存在当前设备，不会同步到云端',
        tone: 'local' as const,
      }
    : {
        label: '云端工作区',
        description: '数据按团队工作区同步',
        tone: 'cloud' as const,
      };
