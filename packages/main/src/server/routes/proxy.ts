import express from 'express';
import {ProxyDB} from '/@/db/proxy';
import type {DB} from '../../../../shared/types/db';
import {getCloudSyncConfig} from '../../cloud/config';
import {enqueueSyncOutbox} from '../../cloud/sync-outbox';
import {randomUUID} from 'node:crypto';

const router = express.Router();

router.get('/info', async (req, res) => {
  const {proxyId} = req.query;
  if (!proxyId) {
    res.send({success: false, message: 'proxyId is required.'});
    return;
  }

  const config = await getCloudSyncConfig();
  const proxyData = await ProxyDB.getByIdInScope(
    Number(proxyId),
    config.enabled ? config.workspaceId : undefined,
  );
  res.send(proxyData);
});

router.get('/all', async (_, res) => {
  const config = await getCloudSyncConfig();
  const proxies = await ProxyDB.all(config.enabled ? config.workspaceId : undefined);
  res.json(proxies);
});

router.post('/create', async (req, res) => {
  const config = await getCloudSyncConfig();
  const proxy = req.body as DB.Proxy;
  const payload: DB.Proxy = config.enabled
    ? {
        ...proxy,
        cloud_id: randomUUID(),
        workspace_id: config.workspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
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
  if (config.enabled && result.length) {
    const created = await ProxyDB.getByIdInScope(result[0], config.workspaceId);
    await enqueueSyncOutbox(
      'proxy',
      'create',
      {
        localId: result[0],
        cloudId: payload.cloud_id,
        data: created || payload,
      },
      config,
    );
  }
  res.send({
    success: result.length,
    id: result[0],
  });
});

router.put('/update', async (req, res) => {
  const {id, proxy} = req.body;
  const config = await getCloudSyncConfig();
  const result = await ProxyDB.update(id, proxy, config.enabled ? config.workspaceId : undefined);
  res.send({
    success: result === 1,
  });
});

router.delete('/delete', async (req, res) => {
  const {proxyId} = req.query;
  if (!proxyId) {
    res.send({success: false, message: 'proxyId is required.'});
    return;
  }
  const config = await getCloudSyncConfig();
  const result = await ProxyDB.remove(
    Number(proxyId),
    config.enabled ? config.workspaceId : undefined,
  );
  res.send({
    success: result === 1,
  });
});

export default router;
