import {ipcMain} from 'electron';
import type {DB} from '../../../shared/types/db';
import {GroupDB} from '../db/group';
import {WindowDB} from '../db/window';
import {randomUUID} from 'crypto';
import {getCloudSyncConfig} from '../cloud/config';
import {enqueueSyncOutbox} from '../cloud/sync-outbox';
export const initGroupService = () => {
  ipcMain.handle('group-create', async (_, group: DB.Group) => {
    const cloudConfig = await getCloudSyncConfig();
    const payload = cloudConfig.enabled
      ? {
          ...group,
          cloud_id: group.cloud_id || randomUUID(),
          workspace_id: cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : {
          ...group,
          cloud_id: null,
          workspace_id: null,
          sync_dirty: false,
          sync_deleted_at: null,
          updated_by_device_id: null,
        };
    const result = await GroupDB.create(payload);
    await enqueueSyncOutbox('group', 'create', {
      localId: result?.[0],
      cloudId: payload.cloud_id,
      data: payload,
    });
    return result;
  });

  ipcMain.handle('group-update', async (_, group: DB.Group) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const existing = await GroupDB.getByIdInScope(group.id!, workspaceId);
    const payload = cloudConfig.enabled
      ? {
          ...group,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : {
          ...group,
          cloud_id: null,
          workspace_id: null,
          sync_dirty: false,
          updated_by_device_id: null,
        };
    const result = await GroupDB.update(group.id!, payload, workspaceId);
    await enqueueSyncOutbox('group', 'update', {
      localId: group.id,
      cloudId: payload.cloud_id || existing?.cloud_id,
      data: payload,
      previousData: existing,
      expectedRevision: existing?.sync_version,
    });
    return result;
  });

  ipcMain.handle('group-delete', async (_, id: number) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    // group_id = id,  status > 0
    const windows = await WindowDB.find({group_id: id}, workspaceId);
    if (windows.filter(window => window.status > 0).length > 0) {
      return {
        success: false,
        message: 'Group is used by some windows',
      };
    }
    const group = await GroupDB.getByIdInScope(id, workspaceId);
    const res = await GroupDB.remove(id, workspaceId);
    await enqueueSyncOutbox('group', 'delete', {
      localId: id,
      cloudId: group?.cloud_id,
      data: group,
    });
    return {
      success: true,
      message: 'Group deleted successfully',
      data: res,
    };
  });

  ipcMain.handle('group-getAll', async () => {
    const cloudConfig = await getCloudSyncConfig();
    return await GroupDB.all(cloudConfig.enabled ? cloudConfig.workspaceId : undefined);
  });
  ipcMain.handle('group-getById', async (_, id: number) => {
    const cloudConfig = await getCloudSyncConfig();
    return await GroupDB.getByIdInScope(
      id,
      cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
    );
  });
};
