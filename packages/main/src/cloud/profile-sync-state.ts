import {db} from '../db';
import {ensureCloudSyncSchema} from './schema';

export type ProfileSyncState = {
  window_id: number;
  cloud_id?: string | null;
  local_manifest_hash?: string | null;
  cookie_hash?: string | null;
  pending_cookie_snapshot?: string | null;
  cloud_revision?: string | null;
  history_cursor?: string | null;
  history_uploaded_visit_time?: string | null;
  pending_mutation_id?: string | null;
  pending_mutation_scope?: 'profile' | 'cookies' | null;
  profile_dirty?: boolean | number | null;
  offline_dirty?: boolean | number | null;
  conflict_status?: string | null;
  uploaded_bytes?: number | null;
  downloaded_bytes?: number | null;
  last_file_count?: number | null;
  last_cookie_count?: number | null;
  last_error?: string | null;
  last_synced_at?: string | null;
};

export const getProfileSyncState = async (windowId: number) => {
  await ensureCloudSyncSchema();
  return (await db<ProfileSyncState>('profile_sync_state').where({window_id: windowId}).first()) || undefined;
};

export const updateProfileSyncState = async (windowId: number, values: Partial<ProfileSyncState>) => {
  await ensureCloudSyncSchema();
  const payload = {...values, updated_at: db.fn.now()};
  const existing = await db('profile_sync_state').where({window_id: windowId}).first();
  if (existing) {
    await db('profile_sync_state').where({window_id: windowId}).update(payload);
  } else {
    await db('profile_sync_state').insert({window_id: windowId, ...payload});
  }
};

export const markProfileOfflineDirty = async (windowId: number, cloudId?: string | null) =>
  updateProfileSyncState(windowId, {
    cloud_id: cloudId,
    offline_dirty: true,
    profile_dirty: true,
    conflict_status: 'pending_network_reconcile',
  });
