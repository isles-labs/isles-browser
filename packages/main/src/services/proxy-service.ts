import {ipcMain} from 'electron';
import type {DB} from '../../../shared/types/db';
import {ProxyDB} from '../db/proxy';
import {WindowDB} from '../db/window';
import {testProxy} from '../network/prepare';
import {randomUUID} from 'crypto';
import {getCloudSyncConfig} from '../cloud/config';
import {enqueueSyncOutbox} from '../cloud/sync-outbox';
import {flushSyncOutbox} from '../cloud/sync-engine';
import {deduplicateProxyImport} from './proxy-import';

const flushProxySyncSoon = () => {
  flushSyncOutbox().catch(() => {
    // The scheduled sync loop will retry.
  });
};

interface ProxyImportResult {
  createdIds: number[];
  skippedDuplicates: number;
}

let proxyImportInFlight: Promise<ProxyImportResult> | undefined;

const importUniqueProxies = async (proxies: DB.Proxy[]): Promise<ProxyImportResult> => {
  const cloudConfig = await getCloudSyncConfig();
  const {uniqueProxies, duplicateCount: duplicateRowsInFile} = deduplicateProxyImport(proxies);
  const proxiesToCreate: DB.Proxy[] = [];
  let skippedDuplicates = duplicateRowsInFile;

  for (const proxy of uniqueProxies) {
    const existing = await ProxyDB.getByProxy(
      proxy.proxy_type,
      proxy.proxy,
      cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
    );
    if (existing) {
      skippedDuplicates += 1;
      continue;
    }

    proxiesToCreate.push(
      cloudConfig.enabled
        ? {
            ...proxy,
            cloud_id: proxy.cloud_id || randomUUID(),
            workspace_id: cloudConfig.workspaceId,
            sync_dirty: true,
            updated_by_device_id: cloudConfig.deviceId,
          }
        : {
            ...proxy,
            cloud_id: null,
            workspace_id: null,
            sync_dirty: false,
            sync_deleted_at: null,
            updated_by_device_id: null,
          },
    );
  }

  const createdIds = proxiesToCreate.length ? await ProxyDB.importProxies(proxiesToCreate) : [];
  for (let index = 0; index < proxiesToCreate.length; index++) {
    const proxy = proxiesToCreate[index];
    await enqueueSyncOutbox('proxy', 'create', {
      localId: createdIds[index],
      cloudId: proxy.cloud_id,
      data: proxy,
    });
  }
  if (createdIds.length) flushProxySyncSoon();

  return {createdIds, skippedDuplicates};
};

export const initProxyService = () => {
  ipcMain.handle('proxy-create', async (_, proxy: DB.Proxy) => {
    const cloudConfig = await getCloudSyncConfig();
    const payload = cloudConfig.enabled
      ? {
          ...proxy,
          cloud_id: proxy.cloud_id || randomUUID(),
          workspace_id: cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : {
          ...proxy,
          cloud_id: null,
          workspace_id: null,
          sync_dirty: false,
          sync_deleted_at: null,
          updated_by_device_id: null,
        };
    const result = await ProxyDB.create(payload);
    await enqueueSyncOutbox('proxy', 'create', {
      localId: result?.[0],
      cloudId: payload.cloud_id,
      data: payload,
    });
    flushProxySyncSoon();
    return result;
  });

  ipcMain.handle('proxy-import', async (_, proxies: DB.Proxy[]) => {
    if (!proxyImportInFlight) {
      proxyImportInFlight = importUniqueProxies(proxies).finally(() => {
        proxyImportInFlight = undefined;
      });
    }
    return await proxyImportInFlight;
  });

  ipcMain.handle('proxy-update', async (_, id: number, proxy: DB.Proxy) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const existing = await ProxyDB.getByIdInScope(id, workspaceId);
    const payload = cloudConfig.enabled
      ? {
          ...existing,
          ...proxy,
          cloud_id: proxy.cloud_id || existing?.cloud_id || randomUUID(),
          workspace_id: cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : {
          ...proxy,
          cloud_id: null,
          workspace_id: null,
          sync_dirty: false,
          updated_by_device_id: null,
        };
    const result = await ProxyDB.update(id, payload, workspaceId);
    await enqueueSyncOutbox('proxy', 'update', {
      localId: id,
      cloudId: payload.cloud_id,
      data: payload,
      previousData: existing,
      expectedRevision: existing?.sync_version,
    });
    flushProxySyncSoon();
    return result;
  });

  ipcMain.handle('proxy-delete', async (_, proxy: DB.Proxy) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const existing = await ProxyDB.getByIdInScope(proxy.id!, workspaceId);
    if (!existing) throw new Error('当前工作区中不存在该代理');
    const result = await ProxyDB.remove(proxy.id!, workspaceId);
    await enqueueSyncOutbox('proxy', 'delete', {
      localId: proxy.id,
      cloudId: proxy.cloud_id,
      data: proxy,
    });
    flushProxySyncSoon();
    return result;
  });

  ipcMain.handle('proxy-getAll', async () => {
    const cloudConfig = await getCloudSyncConfig();
    return await ProxyDB.all(cloudConfig.enabled ? cloudConfig.workspaceId : undefined);
  });
  ipcMain.handle('proxy-batchDelete', async (_, ids: number[]) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const proxies = await Promise.all(ids.map(id => ProxyDB.getByIdInScope(id, workspaceId)));
    const windowsBeforeDetach = await WindowDB.findByProxyIds(ids, workspaceId);
    const previousWindows = new Map(windowsBeforeDetach.map(window => [window.id, window]));
    const result = await ProxyDB.batchDelete(ids, workspaceId);
    if (result.success) {
      // Sync the profiles first, otherwise another device can receive the proxy
      // deletion while its profile still points to that proxy's cloud id.
      for (const windowId of result.detachedWindowIds || []) {
        const window = await WindowDB.getByIdInScope(windowId, workspaceId);
        const previousWindow = previousWindows.get(windowId);
        if (!window || !cloudConfig.enabled) continue;

        const windowPayload = {
          ...window,
          proxy_id: null,
          proxy_cloud_id: null,
          cloud_id: window.cloud_id || randomUUID(),
          workspace_id: window.workspace_id || cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        };
        await WindowDB.update(windowId, windowPayload, workspaceId);
        const latestWindow = await WindowDB.getByIdInScope(windowId, workspaceId);
        await enqueueSyncOutbox('window', 'update', {
          localId: windowId,
          cloudId: latestWindow?.cloud_id || windowPayload.cloud_id,
          data: latestWindow || windowPayload,
          previousData: previousWindow,
          expectedRevision: previousWindow?.sync_version,
        });
      }

      for (const proxy of proxies) {
        if (!proxy) continue;
        await enqueueSyncOutbox('proxy', 'delete', {
          localId: proxy.id,
          cloudId: proxy.cloud_id,
          data: proxy,
        });
      }
      flushProxySyncSoon();
    }
    return result;
  });

  ipcMain.handle('proxy-getById', async (_, id: number) => {
    const cloudConfig = await getCloudSyncConfig();
    return await ProxyDB.getByIdInScope(
      id,
      cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
    );
  });

  ipcMain.handle('proxy-test', async (_, testParams: number | DB.Proxy) => {
    if (typeof testParams === 'number') {
      const cloudConfig = await getCloudSyncConfig();
      const proxy = await ProxyDB.getByIdInScope(
        testParams,
        cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
      );
      if (!proxy) {
        return {
          connectivity: [],
          error: `Proxy ${testParams} not found`,
        };
      }
      return await testProxy(proxy);
    } else {
      return await testProxy(testParams);
    }
  });
};
