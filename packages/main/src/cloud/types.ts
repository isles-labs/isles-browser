export interface CloudSyncConfig {
  enabled: boolean;
  /** Effective product mode after credentials and workspace validation. */
  mode?: 'local' | 'cloud';
  /** Stable storage namespace used for local caches and diagnostics. */
  storageScope?: string;
  apiBaseUrl: string;
  accessToken?: string;
  workspaceId?: string;
  userId?: string;
  deviceId: string;
  deviceName: string;
  protocolVersion: 1 | 2;
}

export interface ProfileLockOwner {
  user_id?: string;
  user_name?: string;
  device_id?: string;
  device_name?: string;
  locked_at?: string;
  heartbeat_at?: string;
}

export interface ProfileLockState extends ProfileLockOwner {
  lock_id?: string;
  workspace_id?: string;
  profile_cloud_id: string;
  app_instance_id?: string;
}

export interface ProfileLockResult {
  success: boolean;
  lock_id?: string;
  fencing_token?: number;
  reason?: 'disabled' | 'locked' | 'network_error' | 'missing_cloud_id' | 'unknown';
  message?: string;
  locked_by?: ProfileLockOwner;
}

export interface RuntimeCapabilityManifestEntry {
  version?: string;
  tag?: string;
  asset?: string;
  sha256?: string;
  executable?: string;
  capabilities?: string[];
}

export interface CloudRuntimeManifest {
  coreFamilies?: Record<
    string,
    Record<
      string,
      Record<string, RuntimeCapabilityManifestEntry | RuntimeCapabilityManifestEntry[]>
    >
  >;
}
