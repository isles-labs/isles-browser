import {ipcMain} from 'electron';
import type {DB} from '../../../shared/types/db';
import {TagDB} from '../db/tag';
import {WindowDB} from '../db/window';
import {getCloudSyncConfig} from '../cloud/config';
import {enqueueSyncOutbox} from '../cloud/sync-outbox';
import {randomUUID} from 'crypto';

export const initTagService = () => {
  ipcMain.handle('tag-create', async (_, tag: DB.Tag) => {
    const config = await getCloudSyncConfig();
    const payload = config.enabled
      ? {
          ...tag,
          cloud_id: tag.cloud_id || randomUUID(),
          workspace_id: config.workspaceId,
          sync_dirty: true,
          updated_by_device_id: config.deviceId,
        }
      : {
          ...tag,
          cloud_id: null,
          workspace_id: null,
          sync_dirty: false,
          sync_deleted_at: null,
          updated_by_device_id: null,
        };
    const result = await TagDB.create(payload);
    await enqueueSyncOutbox('tag', 'create', {
      localId: result?.[0],
      cloudId: payload.cloud_id,
      data: payload,
    });
    return result;
  });

  ipcMain.handle('tag-update', async (_, tag: DB.Tag) => {
    const config = await getCloudSyncConfig();
    const workspaceId = config.enabled ? config.workspaceId : undefined;
    const existing = await TagDB.getByIdInScope(tag.id!, workspaceId);
    const payload = config.enabled
      ? {...tag, sync_dirty: true, updated_by_device_id: config.deviceId}
      : {...tag, cloud_id: null, workspace_id: null, sync_dirty: false, updated_by_device_id: null};
    const result = await TagDB.update(tag.id!, payload, workspaceId);
    await enqueueSyncOutbox('tag', 'update', {
      localId: tag.id,
      cloudId: payload.cloud_id || existing?.cloud_id,
      data: payload,
      previousData: existing,
      expectedRevision: existing?.sync_version,
    });
    return result;
  });

  ipcMain.handle('tag-delete', async (_, id: number) => {
    const config = await getCloudSyncConfig();
    const workspaceId = config.enabled ? config.workspaceId : undefined;
    const windows = await WindowDB.all(workspaceId);
    const windowsWithTag = windows.filter(window => {
      const tagIds = Array.isArray(window.tags)
        ? window.tags.map(Number)
        : String(window.tags || '')
            .split(',')
            .filter(Boolean)
            .map(Number);
      return tagIds.includes(id);
    });
    if (windowsWithTag.length > 0) {
      return {
        success: false,
        message: 'Tag is used by some windows',
      };
    }
    const tag = await TagDB.getByIdInScope(id, workspaceId);
    const res = await TagDB.remove(id, workspaceId);
    await enqueueSyncOutbox('tag', 'delete', {localId: id, cloudId: tag?.cloud_id, data: tag});
    return {
      success: true,
      message: 'Tag deleted successfully',
      data: res,
    };
  });

  ipcMain.handle('tag-getAll', async () => {
    const cloudConfig = await getCloudSyncConfig();
    return await TagDB.all(cloudConfig.enabled ? cloudConfig.workspaceId : undefined);
  });
  ipcMain.handle('tag-getById', async (_, id: number) => {
    const config = await getCloudSyncConfig();
    return await TagDB.getByIdInScope(id, config.enabled ? config.workspaceId : undefined);
  });
};
