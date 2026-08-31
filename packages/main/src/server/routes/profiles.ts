import express from 'express';
import {WindowDB} from '/@/db/window';
import {closeBrowserWindow, openBrowserWindow} from '/@/browser';
import {getCloudSyncConfig} from '../../cloud/config';

const router = express.Router();

router.get('', async (req, res) => {
  const config = await getCloudSyncConfig();
  const windows = await WindowDB.all(config.enabled ? config.workspaceId : undefined);
  res.send(windows);
});

router.post('/open', async (req, res) => {
  const windowId = Number(req.body?.windowId);
  if (!Number.isInteger(windowId) || windowId <= 0) {
    res.status(400).send({error: 'windowId 无效，必须是正整数'});
    return;
  }
  const config = await getCloudSyncConfig();
  const window = await WindowDB.getByIdInScope(
    windowId,
    config.enabled ? config.workspaceId : undefined,
  );
  if (!window) {
    res.status(404).send({error: '当前工作区中不存在该窗口'});
    return;
  }
  const result = await openBrowserWindow(windowId);

  res.send({
    window,
    browser: result,
  });
});

router.get('/open', (_req, res) => {
  res.status(405).send({error: '打开窗口必须使用 POST，并在 JSON body 中传入 windowId'});
});

router.post('/close', async (req, res) => {
  const windowId = Number(req.body?.windowId);
  if (!Number.isInteger(windowId) || windowId <= 0) {
    res.status(400).send({error: 'windowId 无效，必须是正整数'});
    return;
  }
  const config = await getCloudSyncConfig();
  const window = await WindowDB.getByIdInScope(
    windowId,
    config.enabled ? config.workspaceId : undefined,
  );
  if (!window) {
    res.status(404).send({error: '当前工作区中不存在该窗口'});
    return;
  }
  await closeBrowserWindow(windowId, true);
  res.send({
    window,
  });
});

router.get('/close', (_req, res) => {
  res.status(405).send({error: '关闭窗口必须使用 POST，并在 JSON body 中传入 windowId'});
});

export default router;
