import {BrowserWindow} from 'electron';
import {existsSync, mkdirSync} from 'fs';
import {dirname, join} from 'path';
import {spawn, type ChildProcess} from 'child_process';
import * as portscanner from 'portscanner';
import type {DB} from '../../../shared/types/db';
import {WindowDB} from '../db/window';
import {ProxyDB} from '../db/proxy';
import {getSettings} from '../utils/get-settings';
import {getCloudSyncConfig} from '../cloud/config';
import {getProfileDataDir, ensureScopedProfileDataDir, getProfileScopeDirectory, startCloudCookieSync, stopCloudCookieSync, captureCloudCookiesOnce, uploadCloudProfileData, importCloudCookies} from '../cloud/profile-data-sync';
import {buildProxyUrl} from '../../../shared/utils';
import {createLogger} from '../../../shared/utils/logger';
import {WINDOW_LOGGER_LABEL} from '../constants';
import {buildBrowserLaunchArgs} from './launcher';

const logger = createLogger(WINDOW_LOGGER_LABEL);
const HOST = '127.0.0.1';
const processes = new Map<number, ChildProcess>();

const findPort = async () => portscanner.findAPortNotInUse(9222, 40222, HOST);

export async function openBrowserWindow(id: number, headless = false, _options: {allowOffline?: boolean} = {}) {
  const config = await getCloudSyncConfig();
  const windowData = await WindowDB.getByIdInScope(id, config.enabled ? config.workspaceId : undefined);
  if (!windowData) throw new Error(`Window ${id} was not found`);
  const settings = getSettings();
  const profileId = windowData.profile_id || String(id);
  await ensureScopedProfileDataDir(windowData);
  const profileDir = getProfileDataDir(windowData);
  mkdirSync(profileDir, {recursive: true});
  const proxyData = windowData.proxy_id ? await ProxyDB.getByIdInScope(windowData.proxy_id, windowData.workspace_id || undefined) : undefined;
  const finalProxy = proxyData?.proxy && proxyData.proxy_type ? buildProxyUrl(proxyData.proxy_type, proxyData.proxy) : undefined;
  const port = await findPort();
  const launch = buildBrowserLaunchArgs(settings, {chromePort: port, finalProxy, headless, profileId, profileRoot: join(settings.profileCachePath, getProfileScopeDirectory(windowData)), startUrl: undefined, windowData});
  if (!launch.executablePath || !existsSync(launch.executablePath)) throw new Error('Chromium executable not found. Configure a local browser path in Settings.');
  const child = spawn(launch.executablePath, launch.args, {cwd: dirname(launch.executablePath), stdio: ['ignore', 'pipe', 'pipe']});
  processes.set(id, child);
  child.once('error', error => logger.error(`Browser failed to start for window ${id}`, error));
  child.once('close', () => {
    processes.delete(id);
    void WindowDB.update(id, {...windowData, status: 1, port: null, pid: null}, config.enabled ? config.workspaceId : undefined);
  });
  const api = (await import('../../../shared/api/api')).default;
  let data: {webSocketDebuggerUrl?: string} | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { data = (await api.get(`http://${HOST}:${port}/json/version`, {timeout: 1000})).data; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!data?.webSocketDebuggerUrl) { child.kill(); throw new Error('Browser did not become ready'); }
  await WindowDB.update(id, {...windowData, status: 2, port, pid: child.pid || null, opened_at: new Date().toISOString()}, config.enabled ? config.workspaceId : undefined);
  await importCloudCookies(port, undefined);
  startCloudCookieSync(windowData, port);
  return data;
}

export async function closeBrowserWindow(id: number, force = false) {
  const config = await getCloudSyncConfig();
  const windowData = await WindowDB.getByIdInScope(id, config.enabled ? config.workspaceId : undefined);
  if (!windowData) return;
  const child = processes.get(id);
  stopCloudCookieSync(id);
  if (force && windowData.port) await captureCloudCookiesOnce(windowData, windowData.port).catch(() => undefined);
  if (child && !child.killed) child.kill();
  await uploadCloudProfileData(windowData, getProfileDataDir(windowData)).catch(() => undefined);
  await WindowDB.update(id, {...windowData, status: 1, port: null, pid: null}, config.enabled ? config.workspaceId : undefined);
  processes.delete(id);
  BrowserWindow.getAllWindows().forEach(window => window.webContents.send('window-closed', id));
}

export async function resetWindowStatus(id: number) {
  const config = await getCloudSyncConfig();
  const windowData = await WindowDB.getByIdInScope(id, config.enabled ? config.workspaceId : undefined);
  if (windowData) await WindowDB.update(id, {...windowData, status: 1, port: null, pid: null}, config.enabled ? config.workspaceId : undefined);
}

export default {openBrowserWindow, closeBrowserWindow};
