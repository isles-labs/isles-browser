import express from 'express';
import type {DB} from '../../../../shared/types/db';
import {WindowDB} from '/@/db/window';
import {ProxyDB} from '/@/db/proxy';
import {getProxyInfo} from '../../network/prepare';
import {getCloudSyncConfig} from '../../cloud/config';
import {enqueueSyncOutbox} from '../../cloud/sync-outbox';
import {randomUUID} from 'node:crypto';

const router = express.Router();

router.get('/info', async (req, res) => {
  const {windowId} = req.query;
  if (!windowId) {
    res.send({success: false, message: 'windowId is required.', windowData: {}, ipInfo: {}});
    return;
  }
  let windowData: DB.Window = {};
  let ipInfo = {};

  try {
    const config = await getCloudSyncConfig();
    windowData = await WindowDB.getByIdInScope(
      Number(windowId),
      config.enabled ? config.workspaceId : undefined,
    );
    if (!windowData) {
      res.send({windowData: {}, ipInfo: {}});
      return;
    }
    let proxyData: DB.Proxy = {};
    if (windowData.proxy_id) {
      proxyData = await ProxyDB.getByIdInScope(
        windowData.proxy_id,
        windowData.workspace_id || undefined,
      );
    }
    ipInfo = await getProxyInfo(proxyData);
  } catch (error) {
    console.error(error);
  }
  res.send({windowData, ipInfo});
});

router.delete('/delete', async (req, res) => {
  const {windowId} = req.query;
  if (!windowId) {
    res.send({success: false, message: 'windowId is required.'});
    return;
  }
  const config = await getCloudSyncConfig();
  const result = await WindowDB.remove(
    Number(windowId),
    config.enabled ? config.workspaceId : undefined,
  );
  res.send({
    success: result === 1,
  });
});

router.get('/all', async (_, res) => {
  const config = await getCloudSyncConfig();
  const windows = await WindowDB.all(config.enabled ? config.workspaceId : undefined);
  res.send(windows);
});

router.get('/opened', async (_, res) => {
  const config = await getCloudSyncConfig();
  const windows = await WindowDB.getOpenedWindows(config.enabled ? config.workspaceId : undefined);
  res.send(windows);
});

router.post('/create', async (req, res) => {
  if (!req.body) {
    res.send({success: false, message: 'window is required.'});
    return;
  }
  const config = await getCloudSyncConfig();
  const window = req.body as DB.Window;
  const payload: DB.Window = config.enabled
    ? {
        ...window,
        cloud_id: randomUUID(),
        workspace_id: config.workspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      }
    : {
        ...window,
        cloud_id: null,
        workspace_id: null,
        sync_dirty: false,
        sync_deleted_at: null,
        updated_by_device_id: null,
      };
  const result = await WindowDB.create(payload);
  if (result.success && result.data?.id) {
    await enqueueSyncOutbox(
      'window',
      'create',
      {
        localId: result.data.id,
        cloudId: result.data.cloud_id,
        data: result.data,
      },
      config,
    );
  }
  res.send(result);
});

router.put('/update', async (req, res) => {
  const {id, window} = req.body;
  if (!id || !window) {
    res.send({success: false, message: 'id and window is required.'});
    return;
  }
  const config = await getCloudSyncConfig();
  const workspaceId = config.enabled ? config.workspaceId : undefined;
  const originalWindow = await WindowDB.getByIdInScope(id, workspaceId);
  if (!originalWindow) {
    res.status(404).send({success: false, message: '当前工作区中不存在该窗口'});
    return;
  }
  const result = await WindowDB.update(id, {...originalWindow, ...window}, workspaceId);
  res.send(result);
});

export default router;
