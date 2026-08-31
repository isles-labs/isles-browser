import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'fs';
import {join} from 'path';
import type {SettingOptions} from '../../../shared/types/common';
import {getChromePath} from '../utils/chrome-path';
import {app} from 'electron';
import {CONFIG_FILE_PATH} from '../constants';
export const getSettings = (): SettingOptions => {
  const configFilePath = CONFIG_FILE_PATH;
  const isMac = process.platform === 'darwin';
  const defaultCachePath = isMac
    ? `${app.getPath('documents')}/ChromePowerCache`
    : join(app.getPath('appData'), 'ChromePowerCache');
  let settings = {
    profileCachePath: defaultCachePath,
    useLocalChrome: true,
    localChromePath: '',
    chromiumBinPath: '',
    runtimeDownload: {
      proxyUrl: '',
    },
    cloudSync: {
      enabled: false,
      apiBaseUrl: '',
      accessToken: '',
      workspaceId: '',
      userId: '',
      deviceId: '',
      deviceName: '',
    },
    automationConnect: false,
  };

  try {
    if (existsSync(configFilePath)) {
      const fileContent = readFileSync(configFilePath, 'utf8');
      settings = JSON.parse(fileContent);
    } else {
      if (!existsSync(defaultCachePath)) {
        mkdirSync(defaultCachePath, {recursive: true, mode: 0o755});
      }
      writeFileSync(configFilePath, JSON.stringify(settings), 'utf8');
    }

    if (!existsSync(settings.profileCachePath)) {
      mkdirSync(settings.profileCachePath, {recursive: true, mode: 0o755});
    }
  } catch (error) {
    console.error('Error handling the settings file:', error);
  }

  if (!settings.localChromePath) {
    settings.localChromePath = getChromePath() as string;
  }
  const envCloudAccessToken = process.env.CLOUD_SYNC_ACCESS_TOKEN || '';
  const savedCloudAccessToken = settings.cloudSync?.accessToken || '';
  const preferSavedCloudIdentity = Boolean(savedCloudAccessToken && !envCloudAccessToken);
  settings.cloudSync = {
    ...(settings.cloudSync || {}),
    enabled: process.env.CLOUD_SYNC_ENABLED === '1' || Boolean(settings.cloudSync?.enabled),
    apiBaseUrl: process.env.CLOUD_SYNC_API_BASE_URL || settings.cloudSync?.apiBaseUrl || '',
    accessToken: envCloudAccessToken || savedCloudAccessToken,
    workspaceId: preferSavedCloudIdentity
      ? settings.cloudSync?.workspaceId || process.env.CLOUD_SYNC_WORKSPACE_ID || ''
      : process.env.CLOUD_SYNC_WORKSPACE_ID || settings.cloudSync?.workspaceId || '',
    userId: preferSavedCloudIdentity
      ? settings.cloudSync?.userId || process.env.CLOUD_SYNC_USER_ID || ''
      : process.env.CLOUD_SYNC_USER_ID || settings.cloudSync?.userId || '',
    deviceId: process.env.CLOUD_SYNC_DEVICE_ID || settings.cloudSync?.deviceId || '',
    deviceName: process.env.CLOUD_SYNC_DEVICE_NAME || settings.cloudSync?.deviceName || '',
  };
  if (!settings.chromiumBinPath || settings.chromiumBinPath === 'Chrome-bin\\chrome.exe') {
    if (import.meta.env.DEV) {
      settings.chromiumBinPath = 'Chrome-bin\\chrome.exe';
    } else {
      settings.chromiumBinPath = join(process.resourcesPath, 'Chrome-bin', 'chrome.exe');
    }
  }
  return settings;
};
