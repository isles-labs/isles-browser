import os from 'os';
import {randomUUID} from 'crypto';
import {db} from '../db';
import {getSettings} from '../utils/get-settings';
import {CONFIG_FILE_PATH} from '../constants';
import {writeFileSync} from 'fs';
import type {SettingOptions} from '../../../shared/types/common';
import type {CloudSyncConfig} from './types';
import {ensureCloudSyncSchema} from './schema';

type CloudSyncSettings = NonNullable<SettingOptions['cloudSync']> & {
  expiredLocalRetention?: boolean;
};

const cloudSyncSettings = (settings: SettingOptions) =>
  (settings.cloudSync || {}) as CloudSyncSettings;

export const isExpiredLocalRetentionMode = () =>
  cloudSyncSettings(getSettings()).expiredLocalRetention === true;

export const setExpiredLocalRetentionMode = (enabled: boolean) => {
  const settings = getSettings();
  const cloudSync = cloudSyncSettings(settings);
  writeFileSync(
    CONFIG_FILE_PATH,
    JSON.stringify({...settings, cloudSync: {...cloudSync, expiredLocalRetention: enabled}}),
    'utf8',
  );
};

const getOrCreateDeviceId = async () => {
  await ensureCloudSyncSchema();
  const settings = getSettings();
  const configuredDeviceId = settings.cloudSync?.deviceId;
  if (configuredDeviceId) {
    return configuredDeviceId;
  }

  const existing = await db('sync_device').first();
  if (existing?.device_id) {
    return existing.device_id as string;
  }

  const deviceId = randomUUID();
  await db('sync_device').insert({
    device_id: deviceId,
    device_name: os.hostname(),
    workspace_id: settings.cloudSync?.workspaceId || null,
    user_id: settings.cloudSync?.userId || null,
    updated_at: db.fn.now(),
  });

  return deviceId;
};

export const getCloudSyncConfig = async (): Promise<CloudSyncConfig> => {
  const settings = getSettings();
  const cloudSync = cloudSyncSettings(settings);
  const apiBaseUrl = settings.cloudSync?.apiBaseUrl || '';
  const enabled = Boolean(
    cloudSync.enabled &&
      !cloudSync.expiredLocalRetention &&
      apiBaseUrl &&
      settings.cloudSync?.accessToken &&
      settings.cloudSync?.workspaceId,
  );

  return {
    enabled,
    mode: enabled ? 'cloud' : 'local',
    storageScope: enabled
      ? `cloud:${cloudSync.workspaceId}`
      : `local:${await getOrCreateDeviceId()}`,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    accessToken: settings.cloudSync?.accessToken,
    workspaceId: settings.cloudSync?.workspaceId,
    userId: settings.cloudSync?.userId,
    deviceId: await getOrCreateDeviceId(),
    deviceName: settings.cloudSync?.deviceName || os.hostname(),
    protocolVersion: 2,
  };
};
