import {app, BrowserWindow, ipcMain} from 'electron';
import {autoUpdater, type ProgressInfo, type UpdateInfo} from 'electron-updater';
import type {AppUpdateStatus} from '../../shared/types/update';
import {createLogger} from '../../shared/utils/logger';
import {MAIN_LOGGER_LABEL} from './constants';

const logger = createLogger(MAIN_LOGGER_LABEL);
const UPDATE_STATUS_CHANNEL = 'app-update-status';

const state: AppUpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
};

let initialized = false;
let checkInFlight: Promise<void> | undefined;
let updateAvailable = false;

// macOS auto-update stays disabled until signed and notarized ZIP artifacts are published
// through an architecture-safe feed. The local ad-hoc packages must never be distributed.
const isUpdateSupported = () =>
  app.isPackaged && process.platform === 'win32' && process.env.DISABLE_AUTO_UPDATE !== '1';

const formatReleaseNotes = (releaseNotes: UpdateInfo['releaseNotes']) => {
  if (typeof releaseNotes === 'string') return releaseNotes;
  if (!releaseNotes) return undefined;
  return releaseNotes.map(note => note.note).filter(Boolean).join('\n\n');
};

const snapshot = (): AppUpdateStatus => ({...state});

const publish = (next: Partial<AppUpdateStatus>) => {
  Object.assign(state, next);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(UPDATE_STATUS_CHANNEL, snapshot());
  }
};

const updateDetails = (info: UpdateInfo): Partial<AppUpdateStatus> => ({
  version: info.version,
  releaseDate: info.releaseDate,
  releaseNotes: formatReleaseNotes(info.releaseNotes),
});

const checkForUpdates = async () => {
  if (!isUpdateSupported()) {
    publish({phase: 'unsupported', error: undefined});
    return;
  }
  if (checkInFlight) return checkInFlight;

  publish({phase: 'checking', error: undefined});
  checkInFlight = autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch(error => {
      logger.warn(`App update check failed: ${error instanceof Error ? error.message : String(error)}`);
      publish({phase: 'error', error: '检查更新失败，请稍后重试。'});
    })
    .finally(() => {
      checkInFlight = undefined;
    });
  return checkInFlight;
};

const downloadUpdate = async () => {
  if (!isUpdateSupported() || !updateAvailable) return snapshot();
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    logger.warn(`App update download failed: ${error instanceof Error ? error.message : String(error)}`);
    publish({phase: 'error', error: '下载更新失败，请检查网络后重试。'});
  }
  return snapshot();
};

export const initUpdateService = () => {
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => publish({phase: 'checking', error: undefined}));
  autoUpdater.on('update-available', info => {
    updateAvailable = true;
    publish({phase: 'available', ...updateDetails(info), error: undefined});
  });
  autoUpdater.on('update-not-available', info => {
    updateAvailable = false;
    publish({phase: 'not-available', ...updateDetails(info), error: undefined});
  });
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    publish({
      phase: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      error: undefined,
    });
  });
  autoUpdater.on('update-downloaded', info => {
    publish({phase: 'downloaded', ...updateDetails(info), percent: 100, error: undefined});
  });
  autoUpdater.on('error', error => {
    logger.warn(`App updater error: ${error.message}`);
    publish({phase: 'error', error: '更新服务暂不可用，请稍后重试。'});
  });

  ipcMain.handle('app-update-status', () => snapshot());
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('app-update-check', checkForUpdates);
  ipcMain.handle('app-update-download', downloadUpdate);
  ipcMain.handle('app-update-install', () => {
    if (state.phase !== 'downloaded') return false;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });
};

export const checkForAppUpdatesAfterLaunch = () => {
  if (!isUpdateSupported()) {
    publish({phase: 'unsupported', error: undefined});
    return;
  }
  setTimeout(() => void checkForUpdates(), 2_000);
};
