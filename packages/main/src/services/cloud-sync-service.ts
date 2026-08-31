import {ipcMain} from 'electron';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {cloudApiClient} from '../cloud/client';
import {getCloudSyncConfig} from '../cloud/config';
import {releaseAllProfileLocks} from '../cloud/profile-lock-service';
import {resolveCloudProfileConflict} from '../cloud/profile-data-sync';
import {db} from '../db';
import {ensureCloudSyncSchema} from '../cloud/schema';
import {
  listV2SyncConflicts,
  listV2SyncOutbox,
  retryV2OutboxNow,
  resolveV2SyncConflict,
} from '../cloud/sync-v2-outbox';
import {
  flushSyncOutbox,
  pullSyncEvents,
  getCloudSyncProgress,
  resetSyncCursor,
  rebuildCloudSyncOutboxForWorkspace,
  inspectCloudSyncRepair,
  exportCloudSyncAuthoritySnapshot,
  acceptAuthorityRepairOnThisDevice,
  startCloudSyncEngine,
  stopCloudSyncEngine,
} from '../cloud/sync-engine';
import type {ProfileLockState} from '../cloud/types';

const logger = createLogger(SERVICE_LOGGER_LABEL);

// The engine can take tens of seconds to boot (canonical snapshot download,
// 25s V2 long-polls) or stall entirely. Team entry and login must not wait
// on that in the foreground; the engine keeps running in the background.
const SYNC_ENGINE_START_BOUND_MS = 15_000;

const startCloudSyncEngineBounded = async (
  boundMs: number,
  options?: {forceCanonicalSnapshot?: boolean},
) => {
  const enginePromise = startCloudSyncEngine(options);
  const timer = setTimeout(() => {
    logger.warn(
      `Cloud sync engine start did not finish within ${boundMs}ms; continuing in the background`,
    );
  }, boundMs);
  enginePromise
    .catch(error => {
      logger.error('Cloud sync engine start failed in the background', error);
    })
    .finally(() => clearTimeout(timer));
  await Promise.race([
    enginePromise.catch(() => undefined),
    new Promise<void>(resolve => setTimeout(resolve, boundMs)),
  ]);
};

export const initCloudSyncService = () => {
  startCloudSyncEngine().catch(() => {
    // The engine is optional; failures are surfaced by explicit status/flush calls.
  });

  ipcMain.handle('cloud-sync-status', async () => {
    const config = await getCloudSyncConfig();
    return {
      enabled: config.enabled,
      apiBaseUrl: config.apiBaseUrl,
      workspaceId: config.workspaceId,
      userId: config.userId,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
    };
  });

  ipcMain.handle('cloud-sync-refresh-config', async () => {
    const config = await cloudApiClient.refreshConfig();
    stopCloudSyncEngine();
    // Wait at most SYNC_ENGINE_START_BOUND_MS for the engine's first pass so
    // that the caller (team selection / login) is never stuck on a slow or
    // stalled sync. If the bound elapses, the engine keeps booting in the
    // background and the scheduled loop will pick up the rest.
    await startCloudSyncEngineBounded(SYNC_ENGINE_START_BOUND_MS);
    return config;
  });

  ipcMain.handle('cloud-sync-mode-switch-preflight', async () => {
    const runningWindows = await db('window')
      .where('status', '>', 1)
      .count<{count: number}[]>('* as count')
      .first();
    let activeTasks = 0;
    if (await db.schema.hasTable('script_local_run')) {
      const runs = await db('script_local_run')
        .whereIn('status', ['queued', 'claimed', 'running', 'paused'])
        .count<{count: number}[]>('* as count')
        .first();
      activeTasks = Number(runs?.count || 0);
    }
    const windowCount = Number(runningWindows?.count || 0);
    if (windowCount || activeTasks) {
      return {
        success: false,
        message: `请先关闭运行中的指纹窗口并结束脚本任务后再切换模式（窗口 ${windowCount} 个，任务 ${activeTasks} 个）。`,
        runningWindows: windowCount,
        activeTasks,
      };
    }
    return {success: true, runningWindows: 0, activeTasks: 0};
  });

  ipcMain.handle('cloud-sync-flush-outbox', async () => {
    return await flushSyncOutbox();
  });

  ipcMain.handle('cloud-sync-pull', async () => {
    return await pullSyncEvents();
  });

  ipcMain.handle('cloud-sync-repull-current-workspace', async () => {
    const config = await getCloudSyncConfig();
    if (!config.enabled || !config.workspaceId) {
      return {success: false, message: 'cloud sync is disabled or workspace_id is empty'};
    }

    stopCloudSyncEngine();
    if (config.protocolVersion === 2) {
      // A V2 re-pull is a canonical snapshot reconciliation, not an event
      // history replay. A local cursor can already be current while a prior
      // client left same-revision fields or numeric references stale.
      await startCloudSyncEngineBounded(SYNC_ENGINE_START_BOUND_MS, {forceCanonicalSnapshot: true});
    } else {
      await resetSyncCursor(config.workspaceId);
      await startCloudSyncEngineBounded(SYNC_ENGINE_START_BOUND_MS);
    }
    return {success: true, workspaceId: config.workspaceId};
  });

  ipcMain.handle('cloud-sync-progress', async () => {
    return await getCloudSyncProgress();
  });

  ipcMain.handle('cloud-sync-v2-outbox', async () => {
    return await listV2SyncOutbox();
  });

  ipcMain.handle('cloud-sync-v2-outbox-retry-now', async (_event, outboxId: number) => {
    if (!Number.isSafeInteger(outboxId) || outboxId < 1) {
      return {success: false, message: '无效的同步队列项'};
    }
    const requeued = await retryV2OutboxNow(outboxId);
    if (!requeued.success) return requeued;
    const result = await flushSyncOutbox();
    return result.success
      ? {success: true, count: result.count}
      : {
          success: false,
          message: ('error' in result && result.error) || '立即同步失败，已保留在队列中等待重试',
        };
  });

  ipcMain.handle('cloud-sync-diagnostics', async () => {
    await ensureCloudSyncSchema();
    const config = await getCloudSyncConfig();
    const profileDiagnostics = config.workspaceId
      ? db('profile_sync_state as profile')
          .join('window as window', 'window.id', 'profile.window_id')
          .where('window.workspace_id', config.workspaceId)
          .whereNull('window.sync_deleted_at')
          .select('profile.*', 'window.name as window_name', 'window.status as window_status')
          .orderBy('profile.updated_at', 'desc')
          .limit(100)
      : Promise.resolve([]);
    const [profiles, failedOutbox, v2Conflicts] = await Promise.all([
      profileDiagnostics,
      db('sync_outbox')
        .whereNull('processed_at')
        .whereNotNull('last_error')
        .count<{count: number}[]>('* as count')
        .first(),
      listV2SyncConflicts(),
    ]);
    return {
      profiles,
      failedOutbox: Number(failedOutbox?.count || 0),
      v2Conflicts,
    };
  });

  ipcMain.handle(
    'cloud-sync-v2-resolve-conflict',
    async (_, conflictId: number, resolution: 'keep_cloud' | 'keep_local') => {
      if (!['keep_cloud', 'keep_local'].includes(resolution))
        return {success: false, message: 'Unknown conflict resolution'};
      const result = await resolveV2SyncConflict(conflictId, resolution);
      if (result.success && resolution === 'keep_local') {
        flushSyncOutbox().catch(() => {
          // The periodic sync loop will retry if this immediate flush fails.
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    'cloud-sync-profile-resolve-conflict',
    async (_, windowId: number, resolution: 'keep_cloud' | 'keep_local') => {
      return await resolveCloudProfileConflict(windowId, resolution);
    },
  );

  ipcMain.handle('cloud-sync-locks', async () => {
    const response = await cloudApiClient.request<{success: boolean; data: ProfileLockState[]}>(
      'get',
      '/debug/locks',
    );
    return response || {success: false, data: []};
  });

  ipcMain.handle('cloud-sync-reset-cursor', async (_, workspaceId?: string) => {
    return await resetSyncCursor(workspaceId);
  });

  ipcMain.handle('cloud-sync-rebuild-outbox', async () => {
    return await rebuildCloudSyncOutboxForWorkspace();
  });

  ipcMain.handle('cloud-sync-repair-dry-run', async () => {
    return await inspectCloudSyncRepair();
  });

  ipcMain.handle('cloud-sync-export-authority-snapshot', async () => {
    return await exportCloudSyncAuthoritySnapshot();
  });

  ipcMain.handle('cloud-sync-submit-repair-dry-run', async (_, authoritySnapshot: unknown) => {
    return await cloudApiClient.request('post', '/sync/repair/dry-run', {
      authority_snapshot: authoritySnapshot,
    });
  });

  ipcMain.handle('cloud-sync-accept-authority-repair', async (_, repairId: string) => {
    return await acceptAuthorityRepairOnThisDevice(repairId);
  });

  ipcMain.handle('cloud-sync-release-locks', async () => {
    await releaseAllProfileLocks();
    return {success: true};
  });
};
