// types/models.d.ts

export namespace DB {
  export interface Window {
    id?: number;
    profile_id?: string;
    name?: string;
    group_id?: number | null;
    group_name?: string;
    group_cloud_id?: string | null;
    tags?: number[] | string[] | null | string;
    tag_cloud_ids?: string[] | string | null;
    remark?: string;
    opened_at?: string;
    created_at?: string;
    updated_at?: string;
    ua?: string;
    browser_engine?: 'chrome' | 'chromium' | string;
    cookie?: string;
    /** 0: removed; 1: closed; 2: running; 3: Preparing  */
    status?: number;

    ip?: string;
    port?: number | null;
    pid?: number | null;
    local_proxy_port?: number;

    proxy_id?: number | null;
    proxy_cloud_id?: string | null;
    proxy?: string;
    proxy_type?: string;
    ip_country?: string;
    ip_checker?: string;
    tags_name?: string[];

    cloud_id?: string | null;
    workspace_id?: string | null;
    sync_version?: number;
    sync_dirty?: boolean | number;
    sync_deleted_at?: string | null;
    last_synced_at?: string | null;
    updated_by_device_id?: string | null;
  }

  export interface Proxy {
    id?: number;
    ip?: string;
    proxy?: string;
    host?: string;
    proxy_type?: string;
    ip_checker?: 'ip2location' | 'geoip';
    ip_country?: string;
    check_result?: string;
    checking?: boolean;
    remark?: string;
    usageCount?: number;
    cloud_id?: string | null;
    workspace_id?: string | null;
    sync_version?: number;
    sync_dirty?: boolean | number;
    sync_deleted_at?: string | null;
    last_synced_at?: string | null;
    updated_by_device_id?: string | null;
    // ... other properties
  }

  export interface Group {
    id?: number;
    name?: string;
    cloud_id?: string | null;
    workspace_id?: string | null;
    sync_version?: number;
    sync_dirty?: boolean | number;
    sync_deleted_at?: string | null;
    last_synced_at?: string | null;
    updated_by_device_id?: string | null;
  }

  export interface Tag {
    id?: number;
    name?: string;
    color?: string;
    cloud_id?: string | null;
    workspace_id?: string | null;
    sync_version?: number;
    sync_dirty?: boolean | number;
    sync_deleted_at?: string | null;
    last_synced_at?: string | null;
    updated_by_device_id?: string | null;
  }

  export interface Extension {
    id?: number;
    name: string;
    version: string;
    path: string;
    windows?: number[] | string;
    icon?: string;
    description?: string;
    source_type?: 'chrome_web_store' | 'custom' | string;
    source_url?: string;
    chrome_extension_id?: string;
    distribution_mode?: 'global' | 'manual' | string;
    auto_update?: boolean | number;
    created_at?: string;
    updated_at?: string;
    cloud_id?: string | null;
    workspace_id?: string | null;
    sync_version?: number;
    sync_dirty?: boolean | number;
    sync_deleted_at?: string | null;
    last_synced_at?: string | null;
    updated_by_device_id?: string | null;
  }

  export interface WindowExtension {
    id?: number;
    extension_id?: number;
    window_id?: number;
    cloud_id?: string | null;
    workspace_id?: string | null;
    window_cloud_id?: string | null;
    extension_cloud_id?: string | null;
    sync_version?: number;
    sync_dirty?: boolean | number;
    sync_deleted_at?: string | null;
    last_synced_at?: string | null;
    updated_by_device_id?: string | null;
    enabled?: boolean | number;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SafeAny = any;
