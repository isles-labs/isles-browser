import {ipcMain} from 'electron';
import {existsSync, readFileSync} from 'fs';
import {rm} from 'fs/promises';
import {txtToJSON} from '../utils/txt-to-json';
import * as XLSX from 'xlsx';
import type {IWindowTemplate} from '../types/window-template';
import type {DB} from '../../../shared/types/db';
import {WindowDB} from '../db/window';
import {closeBrowserWindow, openBrowserWindow} from '../browser/index';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import path, {isAbsolute, relative, resolve as resolvePath} from 'path';
import puppeteer from 'puppeteer';
import {presetCookie} from '../puppeteer/helpers';
import {ExtensionDB} from '../db/extension';
import * as ExcelJS from 'exceljs';
import {getSettings} from '../utils/get-settings';
import {randomUUID} from 'crypto';
import {getCloudSyncConfig, isExpiredLocalRetentionMode} from '../cloud/config';
import {getProfileDataDir} from '../cloud/profile-data-sync';
import {cloudApiClient} from '../cloud/client';
import {cloudEntitlementErrorMessage} from '../cloud/entitlement-error-message';
import {enqueueSyncOutbox} from '../cloud/sync-outbox';
import {flushSyncOutbox} from '../cloud/sync-engine';
import {buildWindowDeleteTombstone} from '../cloud/sync-safety';
import {GroupDB} from '../db/group';
import {ProxyDB} from '../db/proxy';
import {TagDB} from '../db/tag';
import {randomUniqueProfileId} from '../../../shared/utils/random';
const logger = createLogger(SERVICE_LOGGER_LABEL);

const flushWindowSyncSoon = () => {
  flushSyncOutbox().catch(() => {
    // The scheduled sync loop will retry.
  });
};

const reserveWindowCapacity = async (
  cloudConfig: Awaited<ReturnType<typeof getCloudSyncConfig>>,
  cloudIds: string[],
) => {
  if (!cloudConfig.enabled || !cloudConfig.workspaceId) return;
  try {
    await cloudApiClient.request(
      'post',
      `/teams/${encodeURIComponent(cloudConfig.workspaceId)}/window-capacity/reservations`,
      {cloud_ids: cloudIds},
    );
  } catch (error) {
    throw new Error(cloudEntitlementErrorMessage(error));
  }
};

const isPathInside = (root: string, target: string) => {
  const relativePath = relative(root, target);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath);
};

const isPidAlive = (pid: number | null | undefined): boolean => {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // EPERM means process exists but current process has no permission
    if (code === 'EPERM') return true;
    return false;
  }
};

const clearWindowCache = async (ids: number[]) => {
  const settings = getSettings();
  const cloudConfig = await getCloudSyncConfig();
  const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
  const cachePath = resolvePath(settings.profileCachePath);
  const results = {
    cleared: [] as number[],
    skipped: [] as {id: number; reason: string}[],
    failed: [] as {id: number; reason: string}[],
  };

  for (const id of ids) {
    try {
      const windowData = await WindowDB.getByIdInScope(id, workspaceId);

      if (!windowData) {
        results.skipped.push({id, reason: 'Window not found'});
        continue;
      }

      if (windowData.status && windowData.status > 1) {
        results.skipped.push({id, reason: 'Window is running'});
        continue;
      }

      if (!windowData.profile_id) {
        results.skipped.push({id, reason: 'Profile ID is empty'});
        continue;
      }

      const targetPath = resolvePath(getProfileDataDir(windowData));
      if (!isPathInside(cachePath, targetPath)) {
        results.failed.push({id, reason: 'Invalid cache path'});
        continue;
      }

      if (existsSync(targetPath)) {
        await rm(targetPath, {recursive: true, force: true});
      }

      results.cleared.push(id);
    } catch (error) {
      logger.error(`Failed to clear window cache ${id}`, error);
      results.failed.push({id, reason: (error as Error)?.message || String(error)});
    }
  }

  return {
    success: results.failed.length === 0,
    message: `Cleared ${results.cleared.length} window cache(s).`,
    data: results,
  };
};

type WindowRelationCloudIds = {
  groupCloudIds: Map<number, string | null>;
  proxyCloudIds: Map<number, string | null>;
  tagCloudIds: Map<number, string>;
};

const withWindowRelationCloudIds = async (
  windowData?: DB.Window | null,
  relations?: WindowRelationCloudIds,
) => {
  if (!windowData) {
    return windowData;
  }

  let groupCloudId: string | null = null;
  let proxyCloudId: string | null = null;
  const tagCloudIds: string[] = [];

  if (windowData.group_id) {
    groupCloudId = relations
      ? relations.groupCloudIds.get(windowData.group_id) || null
      : (await GroupDB.getByIdInScope(windowData.group_id, windowData.workspace_id || undefined))
          ?.cloud_id || null;
  }
  if (windowData.proxy_id) {
    proxyCloudId = relations
      ? relations.proxyCloudIds.get(windowData.proxy_id) || null
      : (await ProxyDB.getByIdInScope(windowData.proxy_id, windowData.workspace_id || undefined))
          ?.cloud_id || null;
  }
  const localTagIds = String(windowData.tags || '')
    .split(',')
    .map(value => Number(value))
    .filter(Number.isFinite);
  for (const tagId of localTagIds) {
    const cloudId = relations
      ? relations.tagCloudIds.get(tagId)
      : (await TagDB.getByIdInScope(tagId, windowData.workspace_id || undefined))?.cloud_id;
    if (cloudId) tagCloudIds.push(String(cloudId));
  }

  return {
    ...windowData,
    group_cloud_id: groupCloudId,
    proxy_cloud_id: proxyCloudId,
    tag_cloud_ids: tagCloudIds,
  };
};

const getWindowRelationCloudIds = async (windows: DB.Window[]): Promise<WindowRelationCloudIds> => {
  const groupIds = [
    ...new Set(
      windows.map(windowData => windowData.group_id).filter((id): id is number => Boolean(id)),
    ),
  ];
  const proxyIds = [
    ...new Set(
      windows.map(windowData => windowData.proxy_id).filter((id): id is number => Boolean(id)),
    ),
  ];
  const tagIds = [
    ...new Set(
      windows.flatMap(windowData =>
        String(windowData.tags || '')
          .split(',')
          .map(value => Number(value))
          .filter(Number.isFinite),
      ),
    ),
  ];
  const [groups, proxies, tags] = await Promise.all([
    groupIds.length
      ? Promise.all(
          groupIds.map(id => GroupDB.getByIdInScope(id, windows[0]?.workspace_id || undefined)),
        )
      : [],
    proxyIds.length
      ? Promise.all(
          proxyIds.map(id => ProxyDB.getByIdInScope(id, windows[0]?.workspace_id || undefined)),
        )
      : [],
    tagIds.length
      ? Promise.all(
          tagIds.map(id => TagDB.getByIdInScope(id, windows[0]?.workspace_id || undefined)),
        )
      : [],
  ]);

  return {
    groupCloudIds: new Map(
      groups.filter(Boolean).map(group => [group!.id!, group!.cloud_id || null]),
    ),
    proxyCloudIds: new Map(
      proxies.filter(Boolean).map(proxy => [proxy!.id!, proxy!.cloud_id || null]),
    ),
    tagCloudIds: new Map(
      tags
        .filter(Boolean)
        .flatMap(tag => (tag!.cloud_id ? [[tag!.id!, String(tag!.cloud_id)] as const] : [])),
    ),
  };
};

const ensureCloudProxyForWindow = async (
  windowData: DB.Window,
  cloudConfig: Awaited<ReturnType<typeof getCloudSyncConfig>>,
) => {
  if (!cloudConfig.enabled || !windowData.proxy_id) {
    return;
  }

  const proxy = await ProxyDB.getByIdInScope(windowData.proxy_id, cloudConfig.workspaceId);
  if (!proxy) {
    return;
  }

  const belongsToAnotherWorkspace = Boolean(
    proxy.cloud_id && proxy.workspace_id !== cloudConfig.workspaceId,
  );
  const nextCloudId = belongsToAnotherWorkspace || !proxy.cloud_id ? randomUUID() : proxy.cloud_id;
  if (
    proxy.cloud_id !== nextCloudId ||
    proxy.workspace_id !== cloudConfig.workspaceId ||
    !proxy.sync_dirty
  ) {
    await ProxyDB.update(
      proxy.id!,
      {
        ...proxy,
        cloud_id: nextCloudId,
        workspace_id: cloudConfig.workspaceId,
        sync_dirty: true,
        updated_by_device_id: cloudConfig.deviceId,
      },
      cloudConfig.workspaceId,
    );
  }

  const refreshedProxy = await ProxyDB.getByIdInScope(proxy.id!, cloudConfig.workspaceId);
  await enqueueSyncOutbox(
    'proxy',
    belongsToAnotherWorkspace || !proxy.cloud_id ? 'create' : 'update',
    {
      localId: refreshedProxy?.id,
      cloudId: refreshedProxy?.cloud_id || nextCloudId,
      data: refreshedProxy || {
        ...proxy,
        cloud_id: nextCloudId,
        workspace_id: cloudConfig.workspaceId,
        sync_dirty: true,
        updated_by_device_id: cloudConfig.deviceId,
      },
    },
    cloudConfig,
  );
};

const ensureCloudGroupForWindow = async (
  windowData: DB.Window,
  cloudConfig: Awaited<ReturnType<typeof getCloudSyncConfig>>,
) => {
  if (!cloudConfig.enabled || !windowData.group_id) {
    return;
  }

  const group = await GroupDB.getByIdInScope(windowData.group_id, cloudConfig.workspaceId);
  if (!group) {
    return;
  }

  const belongsToAnotherWorkspace = Boolean(
    group.cloud_id && group.workspace_id !== cloudConfig.workspaceId,
  );
  const nextCloudId = belongsToAnotherWorkspace || !group.cloud_id ? randomUUID() : group.cloud_id;
  if (
    group.cloud_id !== nextCloudId ||
    group.workspace_id !== cloudConfig.workspaceId ||
    !group.sync_dirty
  ) {
    await GroupDB.update(
      group.id!,
      {
        ...group,
        cloud_id: nextCloudId,
        workspace_id: cloudConfig.workspaceId,
        sync_dirty: true,
        updated_by_device_id: cloudConfig.deviceId,
      },
      cloudConfig.workspaceId,
    );
  }

  const refreshedGroup = await GroupDB.getByIdInScope(group.id!, cloudConfig.workspaceId);
  await enqueueSyncOutbox(
    'group',
    belongsToAnotherWorkspace || !group.cloud_id ? 'create' : 'update',
    {
      localId: refreshedGroup?.id,
      cloudId: refreshedGroup?.cloud_id || nextCloudId,
      data: refreshedGroup || {
        ...group,
        cloud_id: nextCloudId,
        workspace_id: cloudConfig.workspaceId,
        sync_dirty: true,
        updated_by_device_id: cloudConfig.deviceId,
      },
    },
    cloudConfig,
  );
};
export const initWindowService = () => {
  logger.info('init window service...');
  ipcMain.handle('window-import', async (_, filePath: string) => {
    if (isExpiredLocalRetentionMode())
      throw new Error('会员权益已到期，本地保留模式不能导入新的窗口');
    let fileData: IWindowTemplate[] = [];
    if (filePath.endsWith('xlsx') || filePath.endsWith('xls')) {
      const workbook = XLSX.readFile(filePath);
      const sheet_name_list = workbook.SheetNames;
      // Keep blank cells so an exported column can intentionally clear a value
      // (for example, remove a proxy by clearing its Proxy cell).
      fileData = XLSX.utils.sheet_to_json(workbook.Sheets[sheet_name_list[0]], {defval: null});
    } else {
      const fileContent = readFileSync(filePath, 'utf-8');
      const data = txtToJSON(fileContent);
      fileData = data.filter(f => f.id);
    }
    const cloudConfig = await getCloudSyncConfig();
    if (cloudConfig.enabled && !cloudConfig.workspaceId) {
      throw new Error(
        'Cloud sync is enabled, but no team is selected. Select a team before importing windows.',
      );
    }
    fileData = fileData.map(row => ({
      ...row,
      id:
        (typeof row.id === 'string' && row.id) ||
        (typeof row.profile_id === 'string' && row.profile_id) ||
        randomUniqueProfileId(),
    }));
    const reservedWindowCloudIds: string[] = [];
    if (cloudConfig.enabled && cloudConfig.workspaceId) {
      for (const row of fileData) {
        const exportedId = String(row.ID || '').trim();
        if (!exportedId) {
          reservedWindowCloudIds.push(randomUUID());
          continue;
        }
        const existingWindow = await WindowDB.getByIdInScope(
          Number(exportedId),
          cloudConfig.workspaceId,
        );
        if (existingWindow?.cloud_id && existingWindow.workspace_id !== cloudConfig.workspaceId) {
          reservedWindowCloudIds.push(randomUUID());
        }
      }
      if (reservedWindowCloudIds.length)
        await reserveWindowCapacity(cloudConfig, reservedWindowCloudIds);
    }
    const result = await WindowDB.externalImport(
      fileData,
      cloudConfig.enabled && cloudConfig.workspaceId
        ? {
            workspaceId: cloudConfig.workspaceId,
            deviceId: cloudConfig.deviceId,
            reservedWindowCloudIds: [...reservedWindowCloudIds],
          }
        : undefined,
    );
    if (cloudConfig.enabled && result.data?.length) {
      const importedWindows = await WindowDB.getByIds(result.data, cloudConfig.workspaceId);
      const createdWindowIds = new Set(result.createdWindowIds || []);

      // Ensure related proxies are cloud-aware first so window payload can carry proxy_cloud_id.
      const groupWindows = new Map<number, DB.Window>();
      const proxyWindows = new Map<number, DB.Window>();
      for (const importedWindow of importedWindows) {
        if (importedWindow.group_id) groupWindows.set(importedWindow.group_id, importedWindow);
        if (importedWindow.proxy_id) proxyWindows.set(importedWindow.proxy_id, importedWindow);
      }
      for (const importedWindow of groupWindows.values()) {
        await ensureCloudGroupForWindow(importedWindow, cloudConfig);
      }
      for (const importedWindow of proxyWindows.values()) {
        await ensureCloudProxyForWindow(importedWindow, cloudConfig);
      }
      const relations = await getWindowRelationCloudIds(importedWindows);

      for (const importedWindow of importedWindows) {
        const id = importedWindow.id!;
        const cloudId = importedWindow.cloud_id || randomUUID();
        const syncPayload = await withWindowRelationCloudIds(importedWindow, relations);
        await enqueueSyncOutbox(
          'window',
          createdWindowIds.has(id) ? 'create' : 'update',
          {
            localId: id,
            cloudId,
            data: syncPayload,
          },
          cloudConfig,
        );
      }
      flushWindowSyncSoon();
    }
    return result;
  });

  ipcMain.handle('window-create', async (_, window: DB.Window) => {
    if (isExpiredLocalRetentionMode())
      throw new Error('会员权益已到期，本地保留模式不能新建窗口');
    logger.info(
      'try to create window',
      JSON.stringify({
        ...window,
        cookie: window?.cookie ? `preset ${window.cookie.length} cookies` : [],
      }),
    );
    console.log(window);
    const cloudConfig = await getCloudSyncConfig();
    const reservedCloudId = cloudConfig.enabled ? window.cloud_id || randomUUID() : undefined;
    if (reservedCloudId) await reserveWindowCapacity(cloudConfig, [reservedCloudId]);
    const windowPayload = cloudConfig.enabled
      ? {
          ...window,
          cloud_id: reservedCloudId,
          workspace_id: cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : {
          ...window,
          cloud_id: null,
          workspace_id: null,
          sync_dirty: false,
          sync_deleted_at: null,
          updated_by_device_id: null,
        };
    const result = await WindowDB.create(windowPayload);
    if (result.success && result.data?.id) {
      const syncPayload = await withWindowRelationCloudIds(result.data);
      await enqueueSyncOutbox('window', 'create', {
        localId: result.data.id,
        cloudId: result.data.cloud_id,
        data: syncPayload,
      });
    }
    return result;
  });

  ipcMain.handle('window-update', async (_, id: number, window: DB.Window) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const existingWindow = await WindowDB.getByIdInScope(id, workspaceId);
    if (!existingWindow) throw new Error('当前工作区中不存在该窗口');
    const previousSyncPayload = await withWindowRelationCloudIds(existingWindow);
    const windowPayload = cloudConfig.enabled
      ? {
          ...window,
          workspace_id: cloudConfig.workspaceId,
          sync_dirty: true,
          updated_by_device_id: cloudConfig.deviceId,
        }
      : {
          ...window,
          cloud_id: null,
          workspace_id: null,
          sync_dirty: false,
          updated_by_device_id: null,
        };
    const result = await WindowDB.update(id!, windowPayload, workspaceId);
    if (result.success) {
      const latestWindow = await WindowDB.getByIdInScope(id, workspaceId);
      const syncPayload = await withWindowRelationCloudIds(latestWindow || windowPayload);
      await enqueueSyncOutbox('window', 'update', {
        localId: id,
        cloudId: latestWindow?.cloud_id || windowPayload.cloud_id,
        data: syncPayload,
        previousData: previousSyncPayload,
        expectedRevision: existingWindow?.sync_version,
      });
    }
    return result;
  });

  ipcMain.handle('window-delete', async (_, id: number) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const windowData = await WindowDB.getByIdInScope(id, workspaceId);
    if (!windowData) throw new Error('当前工作区中不存在该窗口');
    await ExtensionDB.deleteWindowReleted(id, workspaceId);
    const result = await WindowDB.remove(id, workspaceId);
    await enqueueSyncOutbox('window', 'delete', {
      localId: id,
      cloudId: windowData?.cloud_id,
      data: windowData,
    });
    flushWindowSyncSoon();
    return result;
  });
  ipcMain.handle('window-batchClear', async (_, ids: number[]) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const windows = await Promise.all(ids.map(id => WindowDB.getByIdInScope(id, workspaceId)));
    await ExtensionDB.deleteWindowReleted(ids, workspaceId);
    // A physical clear loses the cloud identity and cannot protect against a
    // stale create from another device. Keep a local tombstone instead.
    const result = await WindowDB.batchRemove(ids, workspaceId);
    if (result.success) {
      for (const windowData of windows) {
        if (!windowData) continue;
        await enqueueSyncOutbox('window', 'delete', {
          localId: windowData.id,
          cloudId: windowData.cloud_id,
          data: buildWindowDeleteTombstone(windowData, new Date().toISOString()),
        });
      }
      flushWindowSyncSoon();
    }
    return result;
  });
  ipcMain.handle('window-batchDelete', async (_, ids: number[]) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const windows = await Promise.all(ids.map(id => WindowDB.getByIdInScope(id, workspaceId)));
    await ExtensionDB.deleteWindowReleted(ids, workspaceId);
    const result = await WindowDB.batchRemove(ids, workspaceId);
    if (result.success) {
      for (const windowData of windows) {
        if (!windowData) continue;
        await enqueueSyncOutbox('window', 'delete', {
          localId: windowData.id,
          cloudId: windowData.cloud_id,
          data: windowData,
        });
      }
      flushWindowSyncSoon();
    }
    return result;
  });
  ipcMain.handle('window-clear-cache', async (_, ids: number[]) => {
    return await clearWindowCache(ids);
  });

  ipcMain.handle('window-getAll', async () => {
    const cloudConfig = await getCloudSyncConfig();
    return await WindowDB.all(cloudConfig.enabled ? cloudConfig.workspaceId : undefined);
  });

  ipcMain.handle('window-getOpened', async () => {
    const cloudConfig = await getCloudSyncConfig();
    const windows = await WindowDB.getOpenedWindows(
      cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
    );

    const aliveWindows: typeof windows = [];
    for (const win of windows) {
      if (isPidAlive(win.pid)) {
        aliveWindows.push(win);
        continue;
      }

      // Auto-heal stale running state if PID is no longer alive
      try {
        await WindowDB.update(
          win.id!,
          {
            ...win,
            status: 1,
            pid: null,
            port: null,
          },
          cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
        );
        logger.warn(
          `Detected stale window runtime state. Auto-reset window ${win.id} (pid=${win.pid})`,
        );
      } catch (error) {
        logger.error(`Failed to auto-reset stale window ${win.id} (pid=${win.pid})`, error);
      }
    }

    return aliveWindows;
  });

  ipcMain.handle('window-export', async () => {
    console.log('export windows');
    try {
      const cloudConfig = await getCloudSyncConfig();
      const windows = await WindowDB.all(cloudConfig.enabled ? cloudConfig.workspaceId : undefined);
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Windows');
      worksheet.addRow([
        'ID',
        'Profile ID',
        'Group',
        'Name',
        'Remark',
        'Proxy',
        'Last Open',
        'Created At',
      ]);
      windows.forEach(window => {
        worksheet.addRow([
          window.id,
          window.profile_id,
          window.group_name,
          window.name,
          window.remark,
          window.proxy,
          window.opened_at,
          window.created_at,
        ]);
      });
      workbook.xlsx.writeFile('windows.xlsx');
      return {
        success: true,
        message: 'Export windows successfully',
      };
    } catch (error) {
      logger.error('export windows error', error);
      return {
        success: false,
        message: 'Export windows failed',
      };
    }
  });

  ipcMain.handle('window-getById', async (_, id: number) => {
    const cloudConfig = await getCloudSyncConfig();
    return await WindowDB.getByIdInScope(
      id,
      cloudConfig.enabled ? cloudConfig.workspaceId : undefined,
    );
  });

  ipcMain.handle('window-open', async (_, id: number) => {
    return await openBrowserWindow(id);
  });
  ipcMain.handle('window-open-offline', async (_, id: number) => {
    return await openBrowserWindow(id, false, {allowOffline: true});
  });
  ipcMain.handle('window-close', async (_, id: number, force = false) => {
    return await closeBrowserWindow(id, force);
  });

  ipcMain.handle('window-set-cookie', async (_, id: number) => {
    const cloudConfig = await getCloudSyncConfig();
    const workspaceId = cloudConfig.enabled ? cloudConfig.workspaceId : undefined;
    const window = await WindowDB.getByIdInScope(id, workspaceId);
    if (!window) throw new Error('当前工作区中不存在该窗口');
    await WindowDB.update(
      id,
      {
        ...window,
        status: 3,
      },
      workspaceId,
    );
    const {webSocketDebuggerUrl} = await openBrowserWindow(id, true);

    const browser = await puppeteer.connect({
      browserWSEndpoint: webSocketDebuggerUrl,
      defaultViewport: null,
    });
    await presetCookie(id, browser);
    await browser.close();
    return {
      success: true,
      message: 'Set cookie successfully.',
    };
  });
};

export const randomUserAgent = () => {
  const uaPathCandidates = [
    path.join('assets', 'ua.txt'),
    path.join(process.cwd(), 'assets', 'ua.txt'),
    path.join(process.resourcesPath, 'app', 'assets', 'ua.txt'),
    path.join(process.resourcesPath, 'app.asar', 'assets', 'ua.txt'),
    // Backward compatibility for accidental filename typo in some packaged builds.
    path.join(process.resourcesPath, 'app', 'assets', 'uaa.txt'),
    path.join(process.resourcesPath, 'app.asar', 'assets', 'uaa.txt'),
  ];
  const uaPath = uaPathCandidates.find(candidate => existsSync(candidate));

  if (!uaPath) {
    throw new Error(`UA file not found. Checked paths: ${uaPathCandidates.join(', ')}`);
  }

  const uaFile = readFileSync(uaPath, 'utf-8');
  const uaList = uaFile.split('\n');
  const randomIndex = Math.floor(Math.random() * uaList.length);
  const ua = uaList[randomIndex];
  return ua;
};
