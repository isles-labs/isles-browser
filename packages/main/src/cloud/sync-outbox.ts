import {db} from '../db';
import {getCloudSyncConfig} from './config';
import {ensureCloudSyncSchema} from './schema';
import {randomUUID} from 'crypto';
import {enqueueV2SyncOutbox} from './sync-v2-outbox';
import type {CloudSyncConfig} from './types';
import {isDeviceLocalSyncEntity} from './sync-safety';

export type SyncEntityType =
  | 'group'
  | 'proxy'
  | 'tag'
  | 'window'
  | 'extension'
  | 'window_extension';

export type SyncOperation = 'create' | 'update' | 'delete';

const safeStringifyPayload = (value: unknown) => {
  const seen = new WeakSet<object>();

  return JSON.stringify(value ?? {}, (_key, currentValue) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
        code: (currentValue as NodeJS.ErrnoException).code,
      };
    }

    if (typeof currentValue === 'object' && currentValue !== null) {
      if (seen.has(currentValue)) {
        return '[Circular]';
      }
      seen.add(currentValue);
    }

    return currentValue;
  });
};

const toCloudPayload = (entityType: SyncEntityType, value: unknown) => {
  if (entityType !== 'extension' || !value || typeof value !== 'object') {
    return value;
  }

  // Extension packages are installed per device. Syncing an absolute local path
  // causes another device to point at a directory that cannot exist there.
  const {path: _localPath, ...cloudPayload} = value as Record<string, unknown>;
  return cloudPayload;
};

export const enqueueSyncOutbox = async (
  entityType: SyncEntityType,
  operation: SyncOperation,
  payload: {
    localId?: number;
    cloudId?: string | null;
    data?: unknown;
    previousData?: unknown;
    expectedRevision?: number | null;
  },
  knownConfig?: CloudSyncConfig,
) => {
  if (isDeviceLocalSyncEntity(entityType)) {
    return;
  }

  // Bulk callers already resolved the configuration and initialized the schema.
  // Reusing it prevents thousands of identical SQLite schema/config reads.
  if (!knownConfig) await ensureCloudSyncSchema();
  const config = knownConfig || (await getCloudSyncConfig());
  if (!config.enabled) {
    return;
  }

  if (config.protocolVersion === 2) {
    await enqueueV2SyncOutbox(entityType, operation, payload, config);
    return;
  }

  await db('sync_outbox').insert({
    workspace_id: config.workspaceId || null,
    entity_type: entityType,
    local_id: payload.localId || null,
    cloud_id: payload.cloudId || null,
    operation,
    payload: safeStringifyPayload(toCloudPayload(entityType, payload.data)),
    mutation_id: randomUUID(),
    expected_revision:
      payload.expectedRevision ??
      (payload.data && typeof payload.data === 'object'
        ? Number((payload.data as Record<string, unknown>).sync_version || 0)
        : 0),
    updated_at: db.fn.now(),
  });
};

export const discardDeviceLocalSyncOutbox = async () => {
  await ensureCloudSyncSchema();
  const entityTypes = ['extension', 'window_extension'];
  const [legacy, v2] = await Promise.all([
    db('sync_outbox').whereIn('entity_type', entityTypes).delete(),
    db('sync_outbox_v2').whereIn('entity_type', entityTypes).delete(),
  ]);
  return {discarded: Number(legacy || 0) + Number(v2 || 0)};
};
