type CloudSyncSettings = {
  enabled?: boolean;
  workspaceId?: string;
};

export const CLOUD_MODE_UPDATED_EVENT = 'cloak:cloud-mode-updated';

export const shouldShowLocalModeSwitch = (cloudSync?: CloudSyncSettings) =>
  Boolean(cloudSync?.enabled);

export const shouldShowCloudModeSwitch = (cloudSync?: CloudSyncSettings) => !cloudSync?.enabled;

export const shouldShowCloudSyncSettings = (cloudSync?: CloudSyncSettings) =>
  Boolean(cloudSync?.enabled);

export const shouldShowModeSwitch = (hasMembership: boolean) => hasMembership;

export const shouldBroadcastModeUpdate = (
  previous?: {cloudSync?: CloudSyncSettings},
  next?: {cloudSync?: CloudSyncSettings},
) =>
  previous?.cloudSync?.enabled !== next?.cloudSync?.enabled ||
  previous?.cloudSync?.workspaceId !== next?.cloudSync?.workspaceId;

export const buildLocalModeSettings = <T extends {cloudSync?: CloudSyncSettings}>(settings: T) => ({
  ...settings,
  cloudSync: {
    ...settings.cloudSync,
    enabled: false,
  },
});

export const buildCloudModeSettings = <T extends {cloudSync?: CloudSyncSettings}>(settings: T) => ({
  ...settings,
  cloudSync: {
    ...settings.cloudSync,
    enabled: true,
  },
});
