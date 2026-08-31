import {CommonBridge, SyncBridge} from '#preload';
import type {SettingOptions} from '../../../shared/types/common';

export type CloudTeam = {
  id: string;
  name: string;
  role?: string;
  invite_code?: string;
  entitlement_status?: 'active' | 'expired' | 'suspended' | null;
  cloud_enabled_until?: string | null;
  max_members?: number;
  max_devices?: number;
  max_windows?: number;
  member_count?: number;
  active_device_count?: number;
  active_window_count?: number;
};

export type TeamCreationGrant = {
  can_create_team: boolean;
  enabled_until?: string | null;
};

export type JoinRequest = {
  id: string;
  team_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  message?: string;
  created_at?: string;
  user?: {
    id: string;
    email: string;
    name: string;
  };
  team?: CloudTeam;
};

export type CloudTeamMember = {
  user_id: string;
  role: 'owner' | 'admin' | 'member' | string;
  joined_at?: string;
  user?: {
    id: string;
    email?: string;
    name?: string;
  };
};

export const getSavedSettings = async () => {
  return (await CommonBridge.getSettings()) as SettingOptions;
};

export const saveCloudSession = async (
  settings: SettingOptions,
  cloudSync: NonNullable<SettingOptions['cloudSync']>,
) => {
  const nextSettings: SettingOptions = {
    ...settings,
    cloudSync: {
      ...(settings.cloudSync || {}),
      ...cloudSync,
      // Authentication alone never enables cloud sync. A selected team is the
      // boundary that permits browser data to leave this device.
      enabled: Boolean(cloudSync.workspaceId),
    },
  };
  await CommonBridge.saveSettings(nextSettings);
  await SyncBridge.refreshCloudSyncConfig();
  return nextSettings;
};

export const clearCloudSession = async () => {
  const settings = await getSavedSettings();
  const nextSettings: SettingOptions = {
    ...settings,
    cloudSync: {
      ...(settings.cloudSync || {}),
      enabled: false,
      accessToken: '',
      workspaceId: '',
      userId: '',
    },
  };
  await CommonBridge.saveSettings(nextSettings);
  await SyncBridge.refreshCloudSyncConfig();
  return nextSettings;
};

export const normalizeApiBaseUrl = (apiBaseUrl?: string) => (apiBaseUrl || '').replace(/\/+$/, '');

export const fetchCloudJson = async <T>(
  apiBaseUrl: string,
  path: string,
  options: RequestInit = {},
) => {
  const response = await fetch(`${normalizeApiBaseUrl(apiBaseUrl)}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const result = (await response.json()) as T & {success?: boolean; message?: string};
  if (!response.ok || result.success === false) {
    throw new Error(result.message || 'Cloud request failed');
  }
  return result;
};

export const fetchTeams = async (apiBaseUrl: string, accessToken: string) => {
  const result = await fetchCloudJson<{success: boolean; data: CloudTeam[]}>(apiBaseUrl, '/teams', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return result.data || [];
};

export const fetchTeamCreationGrant = async (apiBaseUrl: string, accessToken: string) => {
  const result = await fetchCloudJson<{success: boolean; data: TeamCreationGrant}>(
    apiBaseUrl,
    '/team-creation-grant',
    {headers: {Authorization: `Bearer ${accessToken}`}},
  );
  return result.data;
};

export const isCloudTeamAvailable = (
  team: Pick<CloudTeam, 'entitlement_status' | 'cloud_enabled_until'>,
) => {
  if (team.entitlement_status !== 'active') return false;
  if (!team.cloud_enabled_until) return true;
  const enabledUntil = new Date(team.cloud_enabled_until);
  return Number.isFinite(enabledUntil.getTime()) && enabledUntil.getTime() > Date.now();
};

export const fetchTeamMembers = async (apiBaseUrl: string, accessToken: string, teamId: string) => {
  const result = await fetchCloudJson<{success: boolean; data: CloudTeamMember[]}>(
    apiBaseUrl,
    `/teams/${teamId}/members`,
    {headers: {Authorization: `Bearer ${accessToken}`}},
  );
  return result.data || [];
};
