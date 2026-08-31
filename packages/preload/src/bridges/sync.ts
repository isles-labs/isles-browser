import {ipcRenderer} from 'electron';

export interface SyncOptions {
  enableMouseSync?: boolean;
  enableKeyboardSync?: boolean;
  enableWheelSync?: boolean;
  enableCdpSync?: boolean;
  mouseMoveThrottleMs?: number;
  mouseMoveThresholdPx?: number;
  wheelThrottleMs?: number;
  cdpSyncIntervalMs?: number;
}

export interface MonitorInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
  index: number;
}

export interface CloudSyncProgress {
  enabled: boolean;
  pendingOutbox: number;
  progressPercent: number;
  syncing: boolean;
  lastSyncActivityAt: number | null;
}

export interface CloudProfileSyncDiagnostic {
  window_id: number;
  cloud_id?: string;
  cloud_revision?: string;
  uploaded_bytes?: number;
  downloaded_bytes?: number;
  last_file_count?: number;
  last_cookie_count?: number;
  offline_dirty?: boolean | number;
  conflict_status?: string;
  last_error?: string;
  updated_at?: string;
  window_name?: string;
  window_status?: number;
}

export interface CloudSyncV2Conflict {
  id: number;
  entity_type: string;
  cloud_id: string;
  status: string;
  entity_name?: string;
  local_id?: number;
  can_recreate_current_workspace: boolean;
  conflicting_fields: string[];
  field_values: Array<{
    field: string;
    local_value: string;
    cloud_value: string;
  }>;
}

export interface CloudSyncV2OutboxItem {
  id: number;
  entity_type: 'group' | 'tag' | 'proxy' | 'window';
  operation: 'create' | 'patch' | 'delete';
  state: 'pending' | 'sending' | 'retry_wait' | 'conflict';
  entity_name?: string;
  attempt_count: number;
  retry_at?: string | null;
  last_error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export const SyncBridge = {
  // Window arrangement (legacy)
  arrangeWindows: (args: {
    mainPid: number;
    childPids: number[];
    columns: number;
    size: {width: number; height: number};
    spacing: number;
    monitorIndex?: number;
  }) => {
    return ipcRenderer.invoke('window-arrange', args);
  },

  // Get available monitors
  getMonitors: (): Promise<{success: boolean; monitors: MonitorInfo[]; error?: string}> => {
    return ipcRenderer.invoke('window-get-monitors');
  },

  // Multi-window synchronization
  startSync: (args: {masterWindowId: number; slaveWindowIds: number[]; options?: SyncOptions}) => {
    return ipcRenderer.invoke('multi-window-sync-start', args);
  },

  stopSync: () => {
    return ipcRenderer.invoke('multi-window-sync-stop');
  },

  getSyncStatus: () => {
    return ipcRenderer.invoke('multi-window-sync-status');
  },

  getCloudSyncStatus: () => {
    return ipcRenderer.invoke('cloud-sync-status');
  },

  refreshCloudSyncConfig: () => {
    return ipcRenderer.invoke('cloud-sync-refresh-config');
  },

  preflightCloudModeSwitch: (): Promise<{success: boolean; message?: string}> => {
    return ipcRenderer.invoke('cloud-sync-mode-switch-preflight');
  },

  flushCloudSyncOutbox: () => {
    return ipcRenderer.invoke('cloud-sync-flush-outbox');
  },

  pullCloudSync: () => {
    return ipcRenderer.invoke('cloud-sync-pull');
  },

  repullCurrentCloudWorkspace: (): Promise<{
    success: boolean;
    workspaceId?: string;
    message?: string;
  }> => {
    return ipcRenderer.invoke('cloud-sync-repull-current-workspace');
  },

  getCloudSyncProgress: (): Promise<CloudSyncProgress> => {
    return ipcRenderer.invoke('cloud-sync-progress');
  },

  getCloudSyncV2Outbox: (): Promise<CloudSyncV2OutboxItem[]> => {
    return ipcRenderer.invoke('cloud-sync-v2-outbox');
  },

  retryCloudSyncV2OutboxNow: (
    outboxId: number,
  ): Promise<{success: boolean; count?: number; message?: string}> => {
    return ipcRenderer.invoke('cloud-sync-v2-outbox-retry-now', outboxId);
  },

  getCloudSyncDiagnostics: (): Promise<{
    profiles: CloudProfileSyncDiagnostic[];
    failedOutbox: number;
    v2Conflicts: CloudSyncV2Conflict[];
  }> => {
    return ipcRenderer.invoke('cloud-sync-diagnostics');
  },

  resolveCloudSyncV2Conflict: (conflictId: number, resolution: 'keep_cloud' | 'keep_local') => {
    return ipcRenderer.invoke('cloud-sync-v2-resolve-conflict', conflictId, resolution);
  },

  resolveCloudProfileConflict: (windowId: number, resolution: 'keep_cloud' | 'keep_local') => {
    return ipcRenderer.invoke('cloud-sync-profile-resolve-conflict', windowId, resolution);
  },

  getCloudSyncLocks: () => {
    return ipcRenderer.invoke('cloud-sync-locks');
  },

  resetCloudSyncCursor: (workspaceId?: string) => {
    return ipcRenderer.invoke('cloud-sync-reset-cursor', workspaceId);
  },

  rebuildCloudSyncOutbox: () => {
    return ipcRenderer.invoke('cloud-sync-rebuild-outbox');
  },

  dryRunCloudSyncRepair: () => {
    return ipcRenderer.invoke('cloud-sync-repair-dry-run');
  },

  exportCloudSyncAuthoritySnapshot: () => {
    return ipcRenderer.invoke('cloud-sync-export-authority-snapshot');
  },

  submitCloudSyncRepairDryRun: (authoritySnapshot: unknown) => {
    return ipcRenderer.invoke('cloud-sync-submit-repair-dry-run', authoritySnapshot);
  },

  acceptCloudAuthorityRepair: (repairId: string) => {
    return ipcRenderer.invoke('cloud-sync-accept-authority-repair', repairId);
  },

  releaseCloudSyncLocks: () => {
    return ipcRenderer.invoke('cloud-sync-release-locks');
  },

  // Listen to global shortcuts from main process
  onShortcutStart: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('sync-shortcut-start', listener);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('sync-shortcut-start', listener);
    };
  },

  onShortcutStop: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('sync-shortcut-stop', listener);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('sync-shortcut-stop', listener);
    };
  },
};
