import {randomUUID} from 'crypto';
import {db} from '../db';
import {cloudApiClient} from './client';
import {getCloudSyncConfig} from './config';
import {ensureCloudSyncSchema} from './schema';
import type {SyncEntityType, SyncOperation} from './sync-outbox';
import {
  changedSyncFields,
  isDeviceLocalSyncEntity,
  selectSendableV2EntityRows,
  shouldAcceptRemoteTombstone,
} from './sync-safety';
import type {CloudSyncConfig} from './types';

type V2EntityType = SyncEntityType;
type V2Operation = 'create' | 'patch' | 'delete';

const FIELDS: Record<V2EntityType, readonly string[]> = {
  group: ['name'],
  tag: ['name', 'color'],
  proxy: ['proxy', 'proxy_type', 'ip_checker', 'ip', 'ip_country', 'check_result', 'remark'],
  window: [
    'profile_id',
    'name',
    'group_cloud_id',
    'proxy_cloud_id',
    'tag_cloud_ids',
    'remark',
    'ua',
    'browser_engine',
  ],
  extension: [
    'name',
    'version',
    'icon',
    'description',
    'source_type',
    'source_url',
    'chrome_extension_id',
    'distribution_mode',
    'auto_update',
    'workspace_id',
  ],
  window_extension: ['extension_cloud_id', 'window_cloud_id', 'enabled', 'workspace_id'],
};

type V2OutboxRow = {
  id: number;
  workspace_id: string;
  entity_type: V2EntityType;
  cloud_id: string;
  mutation_id: string;
  base_revision: number;
  canonical_revision?: number;
  patch: string | Record<string, unknown>;
  operation: V2Operation;
  state: 'pending' | 'sending' | 'retry_wait' | 'conflict';
  retry_at?: string | null;
  last_error?: string | null;
  attempt_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
};

const parseJson = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const mergedOperation = (earlier: V2Operation, later: V2Operation): V2Operation => {
  if (later === 'delete') return 'delete';
  if (earlier === 'create' || later === 'create') return 'create';
  return 'patch';
};

const mergedPatch = (earlier: V2OutboxRow, later: V2OutboxRow, operation: V2Operation) =>
  operation === 'delete' ? {} : {...parseJson(earlier.patch), ...parseJson(later.patch)};

const canonicalPatch = (entityType: V2EntityType, value: unknown) => {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return normalizeV2Patch(
    entityType,
    Object.fromEntries(
      FIELDS[entityType]
        .filter(field => source[field] !== undefined)
        .map(field => [field, source[field]]),
    ),
  );
};

export const changedV2Patch = (
  entityType: V2EntityType,
  previousValue: unknown,
  nextValue: unknown,
) => {
  return normalizeV2Patch(
    entityType,
    changedSyncFields(previousValue, nextValue, FIELDS[entityType]),
  );
};

// The V2 service requires a string array. Older local rows may carry null
// when a window has no tags, which rejects the whole mutation batch.
const normalizeV2Patch = (entityType: V2EntityType, patch: Record<string, unknown>) => {
  if (entityType !== 'window' || !Object.prototype.hasOwnProperty.call(patch, 'tag_cloud_ids'))
    return patch;
  const tagCloudIds = patch.tag_cloud_ids;
  return {
    ...patch,
    tag_cloud_ids: Array.isArray(tagCloudIds) ? tagCloudIds.map(String) : [],
  };
};

const normalizeWindowReferences = async (
  patch: Record<string, unknown>,
  source: unknown,
  database = db,
) => {
  if (!source || typeof source !== 'object') return patch;
  const windowData = source as Record<string, unknown>;
  const normalized = {...patch};
  if (Object.prototype.hasOwnProperty.call(patch, 'group_cloud_id')) {
    const groupQuery = windowData.group_id
      ? database('group').where({id: windowData.group_id})
      : undefined;
    if (groupQuery) {
      if (windowData.workspace_id) groupQuery.where({workspace_id: windowData.workspace_id});
      else groupQuery.whereNull('workspace_id');
    }
    const group = groupQuery ? await groupQuery.first() : undefined;
    normalized.group_cloud_id = group?.cloud_id || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'proxy_cloud_id')) {
    const proxyQuery = windowData.proxy_id
      ? database('proxy').where({id: windowData.proxy_id})
      : undefined;
    if (proxyQuery) {
      if (windowData.workspace_id) proxyQuery.where({workspace_id: windowData.workspace_id});
      else proxyQuery.whereNull('workspace_id');
    }
    const proxy = proxyQuery ? await proxyQuery.first() : undefined;
    normalized.proxy_cloud_id = proxy?.cloud_id || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'tag_cloud_ids')) {
    const tagIds = String(windowData.tags || '')
      .split(',')
      .map(Number)
      .filter(Number.isFinite);
    const tagsQuery = tagIds.length
      ? database('tag').whereIn('id', tagIds).select('cloud_id')
      : undefined;
    if (tagsQuery) {
      if (windowData.workspace_id) tagsQuery.where({workspace_id: windowData.workspace_id});
      else tagsQuery.whereNull('workspace_id');
    }
    const tags = tagsQuery ? await tagsQuery : [];
    normalized.tag_cloud_ids = tags.map(tag => String(tag.cloud_id)).filter(Boolean);
  }
  return normalizeV2Patch('window', normalized);
};

const v2Operation = (operation: SyncOperation): V2Operation =>
  operation === 'update' ? 'patch' : operation;

export const enqueueV2SyncOutbox = async (
  entityType: V2EntityType,
  operation: SyncOperation,
  payload: {
    cloudId?: string | null;
    data?: unknown;
    previousData?: unknown;
    expectedRevision?: number | null;
  },
  knownConfig?: CloudSyncConfig,
) => {
  if (isDeviceLocalSyncEntity(entityType)) return {queued: false, reason: 'device_local'};
  if (!payload.cloudId) return {queued: false, reason: 'missing_cloud_id'};
  if (!knownConfig) await ensureCloudSyncSchema();
  const config = knownConfig || (await getCloudSyncConfig());
  if (!config.enabled || !config.workspaceId || config.protocolVersion !== 2)
    return {queued: false, reason: 'disabled'};

  const nextOperation = v2Operation(operation);
  const previousData = payload.previousData;
  let patch =
    previousData === undefined
      ? canonicalPatch(entityType, payload.data)
      : changedV2Patch(entityType, previousData, payload.data);
  if (entityType === 'window') patch = await normalizeWindowReferences(patch, payload.data);
  if (nextOperation === 'patch' && Object.keys(patch).length === 0) {
    return {queued: false, reason: 'no_synced_field_changes'};
  }
  const baseRevision =
    payload.expectedRevision ??
    Number((payload.data as Record<string, unknown> | undefined)?.sync_version || 0);
  const unresolvedConflict =
    nextOperation === 'delete'
      ? await db('sync_conflicts_v2')
          .where({
            workspace_id: config.workspaceId,
            entity_type: entityType,
            cloud_id: payload.cloudId,
          })
          .whereNull('resolved_at')
          .orderBy('canonical_revision', 'desc')
          .first()
      : undefined;
  const deleteBaseRevision = Math.max(
    0,
    Number(baseRevision) || 0,
    Number(unresolvedConflict?.canonical_revision) || 0,
  );
  const existing = await db<V2OutboxRow>('sync_outbox_v2')
    .where({workspace_id: config.workspaceId, entity_type: entityType, cloud_id: payload.cloudId})
    .whereIn(
      'state',
      nextOperation === 'delete'
        ? ['pending', 'retry_wait', 'conflict']
        : ['pending', 'retry_wait'],
    )
    .orderByRaw("case state when 'pending' then 0 when 'retry_wait' then 1 else 2 end")
    .orderBy('id', 'asc')
    .first();

  if (existing && nextOperation !== 'create') {
    const priorPatch = parseJson(existing.patch);
    const mergedOperation: V2Operation =
      nextOperation === 'delete' ? 'delete' : existing.operation === 'create' ? 'create' : 'patch';
    await db.transaction(async trx => {
      await trx('sync_outbox_v2')
        .where({id: existing.id})
        .update({
          operation: mergedOperation,
          // A replaced mutation must receive a new idempotency key. Reusing a
          // prior create key can make the service replay its accepted result.
          ...(mergedOperation === 'delete'
            ? {
                mutation_id: randomUUID(),
                base_revision: deleteBaseRevision,
                canonical_revision: deleteBaseRevision,
                state: 'pending',
                attempt_count: 0,
                retry_at: null,
              }
            : {}),
          patch: JSON.stringify(mergedOperation === 'delete' ? {} : {...priorPatch, ...patch}),
          updated_at: trx.fn.now(),
          last_error: null,
        });
      if (mergedOperation === 'delete') {
        await trx('sync_conflicts_v2')
          .where({
            workspace_id: config.workspaceId,
            entity_type: entityType,
            cloud_id: payload.cloudId,
          })
          .whereNull('resolved_at')
          .update({status: 'superseded_by_local_delete', resolved_at: trx.fn.now()});
      }
    });
    return {queued: true, coalesced: true};
  }

  await db('sync_outbox_v2').insert({
    workspace_id: config.workspaceId,
    entity_type: entityType,
    cloud_id: payload.cloudId,
    mutation_id: randomUUID(),
    base_revision:
      nextOperation === 'delete' ? deleteBaseRevision : Math.max(0, Number(baseRevision) || 0),
    patch: JSON.stringify(nextOperation === 'delete' ? {} : patch),
    operation: nextOperation,
    state: 'pending',
    updated_at: db.fn.now(),
  });
  return {queued: true, coalesced: false};
};

export const takeV2OutboxBatch = async (limit = 20) => {
  await ensureCloudSyncSchema();
  const config = await getCloudSyncConfig();
  if (!config.enabled || !config.workspaceId || config.protocolVersion !== 2)
    return {config, rows: [] as V2OutboxRow[]};
  // A process crash can leave an in-flight row in sending. It is safe to retry
  // with the same mutation ID because the Service stores idempotent responses.
  const stalledSendingRows = await db<V2OutboxRow>('sync_outbox_v2')
    .where({workspace_id: config.workspaceId, state: 'sending'})
    .where('updated_at', '<=', db.raw("datetime('now', '-2 minutes')"));
  for (const row of stalledSendingRows) {
    await retryV2Outbox(row, 'recovered interrupted send');
  }
  const sendingRows = await db<V2OutboxRow>('sync_outbox_v2')
    .where({workspace_id: config.workspaceId, state: 'sending'})
    .select('entity_type', 'cloud_id');
  const candidates = await db<V2OutboxRow>('sync_outbox_v2')
    .where({workspace_id: config.workspaceId, state: 'pending'})
    .orWhere(builder =>
      builder
        .where({workspace_id: config.workspaceId, state: 'retry_wait'})
        .where('retry_at', '<=', db.fn.now()),
    )
    .orderBy('created_at', 'asc')
    .limit(limit * 2);
  const rows = selectSendableV2EntityRows(candidates, sendingRows).slice(0, limit);
  const normalizedRows = rows.map(row => ({
    ...row,
    patch: normalizeV2Patch(row.entity_type, parseJson(row.patch)),
  }));
  if (normalizedRows.length) {
    await db.transaction(async trx => {
      for (const row of normalizedRows) {
        await trx('sync_outbox_v2')
          .where({id: row.id})
          .update({
            patch: JSON.stringify(row.patch),
            state: 'sending',
            updated_at: trx.fn.now(),
          });
      }
    });
  }
  return {config, rows: normalizedRows};
};

export const markV2OutboxResult = async (row: V2OutboxRow, result: Record<string, unknown>) => {
  const status = String(result.status || '');
  if (status === 'accepted' || status === 'already_deleted') {
    await db('sync_outbox_v2').where({id: row.id}).delete();
    const revision = Number(result.revision || 0);
    if (row.operation !== 'delete' && revision > 0) {
      // A delete queued while this create/patch was in-flight must use the
      // revision just assigned by the service, not the stale local revision.
      await db('sync_outbox_v2')
        .where({
          workspace_id: row.workspace_id,
          entity_type: row.entity_type,
          cloud_id: row.cloud_id,
          operation: 'delete',
        })
        .whereIn('state', ['pending', 'retry_wait'])
        .update({base_revision: revision, canonical_revision: revision, updated_at: db.fn.now()});
    }
    const update = {
      sync_version: revision,
      sync_dirty: false,
      last_synced_at: db.fn.now(),
    } as Record<string, unknown>;
    if (row.operation === 'delete') update.sync_deleted_at = result.deleted_at || db.fn.now();
    await db(row.entity_type)
      .where({cloud_id: row.cloud_id, workspace_id: row.workspace_id})
      .update(update);
    return {accepted: true};
  }
  if (status === 'conflict') {
    if (shouldAcceptRemoteTombstone(result)) {
      const canonicalPayload = parseJson(result.canonical_payload);
      const tombstone: Record<string, unknown> = {
        sync_version: Number(result.current_revision || 0),
        sync_dirty: false,
        sync_deleted_at: result.deleted_at || canonicalPayload.sync_deleted_at || db.fn.now(),
        last_synced_at: db.fn.now(),
      };
      if (row.entity_type === 'window') tombstone.status = 0;

      await db.transaction(async trx => {
        await trx('sync_outbox_v2').where({id: row.id}).delete();
        await trx(row.entity_type)
          .where({cloud_id: row.cloud_id, workspace_id: row.workspace_id})
          .update(tombstone);
        // This local edit cannot legally revive a remote tombstone, but remains
        // available as an already-resolved audit record.
        await trx('sync_conflicts_v2').insert({
          workspace_id: row.workspace_id,
          entity_type: row.entity_type,
          cloud_id: row.cloud_id,
          base_revision: row.base_revision,
          canonical_revision: Number(result.current_revision || 0),
          local_patch: JSON.stringify(parseJson(row.patch)),
          canonical_payload: JSON.stringify(canonicalPayload),
          conflicting_fields: JSON.stringify([]),
          status: 'remote_tombstone_accepted',
          resolved_at: trx.fn.now(),
        });
      });
      return {accepted: false, tombstoneAccepted: true};
    }
    await db('sync_conflicts_v2').insert({
      workspace_id: row.workspace_id,
      entity_type: row.entity_type,
      cloud_id: row.cloud_id,
      base_revision: row.base_revision,
      canonical_revision: Number(result.current_revision || 0),
      local_patch: JSON.stringify(parseJson(row.patch)),
      canonical_payload: JSON.stringify(result.canonical_payload || {}),
      conflicting_fields: JSON.stringify(result.conflicting_fields || []),
      status: String(result.reason || 'conflict'),
    });
    await db('sync_outbox_v2')
      .where({id: row.id})
      .update({
        state: 'conflict',
        last_error: String(result.reason || 'conflict'),
        updated_at: db.fn.now(),
      });
    return {accepted: false, conflict: true};
  }
  await retryV2Outbox(row, 'Malformed V2 mutation result');
  return {accepted: false};
};

export const retryV2Outbox = async (row: V2OutboxRow, error: string) => {
  const delaySeconds = Math.min(
    300,
    5 * 2 ** Math.min(6, Math.max(0, Number((row as {attempt_count?: number}).attempt_count || 0))),
  );
  await db.transaction(async trx => {
    const pending = await trx<V2OutboxRow>('sync_outbox_v2')
      .where({
        workspace_id: row.workspace_id,
        entity_type: row.entity_type,
        cloud_id: row.cloud_id,
        state: 'pending',
      })
      .whereNot({id: row.id})
      .first();
    if (pending) {
      const operation = mergedOperation(row.operation, pending.operation);
      await trx('sync_outbox_v2').where({id: row.id}).delete();
      await trx('sync_outbox_v2')
        .where({id: pending.id})
        .update({
          operation,
          base_revision:
            operation === 'create' ? 0 : Math.min(row.base_revision, pending.base_revision),
          patch: JSON.stringify(mergedPatch(row, pending, operation)),
          updated_at: trx.fn.now(),
        });
      return;
    }
    const waiting = await trx<V2OutboxRow>('sync_outbox_v2')
      .where({
        workspace_id: row.workspace_id,
        entity_type: row.entity_type,
        cloud_id: row.cloud_id,
        state: 'retry_wait',
      })
      .whereNot({id: row.id})
      .first();
    if (waiting) {
      const operation = mergedOperation(waiting.operation, row.operation);
      await trx('sync_outbox_v2').where({id: waiting.id}).delete();
      await trx('sync_outbox_v2')
        .where({id: row.id})
        .update({
          mutation_id: randomUUID(),
          operation,
          base_revision:
            operation === 'create' ? 0 : Math.min(waiting.base_revision, row.base_revision),
          patch: JSON.stringify(mergedPatch(waiting, row, operation)),
          state: 'retry_wait',
          attempt_count: trx.raw('attempt_count + 1'),
          retry_at: trx.raw(`datetime('now', '+${delaySeconds} seconds')`),
          last_error: error,
          updated_at: trx.fn.now(),
        });
      return;
    }
    await trx('sync_outbox_v2')
      .where({id: row.id})
      .update({
        state: 'retry_wait',
        attempt_count: trx.raw('attempt_count + 1'),
        retry_at: trx.raw(`datetime('now', '+${delaySeconds} seconds')`),
        last_error: error,
        updated_at: trx.fn.now(),
      });
  });
};

export const retryV2OutboxNow = async (outboxId: number) => {
  await ensureCloudSyncSchema();
  const config = await getCloudSyncConfig();
  if (!config.enabled || !config.workspaceId || config.protocolVersion !== 2) {
    return {success: false, message: '团队云同步未启用'};
  }
  const result = await db.transaction(async trx => {
    const row = await trx<V2OutboxRow>('sync_outbox_v2')
      .where({id: outboxId, workspace_id: config.workspaceId, state: 'retry_wait'})
      .first();
    if (!row) return {updated: false};
    const pending = await trx<V2OutboxRow>('sync_outbox_v2')
      .where({
        workspace_id: row.workspace_id,
        entity_type: row.entity_type,
        cloud_id: row.cloud_id,
        state: 'pending',
      })
      .first();
    if (pending) {
      const operation = mergedOperation(row.operation, pending.operation);
      await trx('sync_outbox_v2').where({id: row.id}).delete();
      await trx('sync_outbox_v2')
        .where({id: pending.id})
        .update({
          operation,
          base_revision:
            operation === 'create' ? 0 : Math.min(row.base_revision, pending.base_revision),
          patch: JSON.stringify(mergedPatch(row, pending, operation)),
          retry_at: null,
          last_error: null,
          updated_at: trx.fn.now(),
        });
      return {updated: true};
    }
    await trx('sync_outbox_v2').where({id: row.id}).update({
      state: 'pending',
      retry_at: null,
      last_error: null,
      updated_at: trx.fn.now(),
    });
    return {updated: true};
  });
  if (!result.updated)
    return {success: false, message: '该失败项已处理、正在发送，或不属于当前团队'};
  return {success: true};
};

const outboxErrorMessage = (error: unknown) => {
  if (!error || typeof error !== 'object') return String(error);
  const response = (error as {response?: {status?: number; data?: {message?: unknown}}}).response;
  const detail = typeof response?.data?.message === 'string' ? response.data.message : '';
  if (response?.status && detail) return `HTTP ${response.status}: ${detail}`;
  if (response?.status) return `HTTP ${response.status}`;
  return error instanceof Error ? error.message : String(error);
};

export const flushV2Outbox = async () => {
  const {config, rows} = await takeV2OutboxBatch();
  if (!rows.length || !config.workspaceId) return {success: true, count: 0};
  try {
    const response = await cloudApiClient.request<{
      success?: boolean;
      results?: Record<string, unknown>[];
    }>('post', `/teams/${encodeURIComponent(config.workspaceId)}/sync/v2/mutations`, {
      mutations: rows.map(row => ({
        mutation_id: row.mutation_id,
        entity_type: row.entity_type,
        cloud_id: row.cloud_id,
        operation: row.operation,
        base_revision: row.base_revision,
        patch: parseJson(row.patch),
      })),
    });
    const byId = new Map(
      (response?.results || []).map(result => [String(result.mutation_id), result]),
    );
    for (const row of rows) await markV2OutboxResult(row, byId.get(row.mutation_id) || {});
    return {success: true, count: rows.length};
  } catch (error) {
    const message = outboxErrorMessage(error);
    for (const row of rows) await retryV2Outbox(row, message);
    const status = (error as {response?: {status?: unknown}})?.response?.status;
    return {
      success: false,
      count: 0,
      error: message,
      requiresCanonicalSnapshot:
        Number(status) === 409 && /canonical snapshot|pull and acknowledge/i.test(message),
    };
  }
};

export const getV2OutboxCounts = async () => {
  const config = await getCloudSyncConfig();
  if (!config.workspaceId) return {pending: 0, retrying: 0, conflicts: 0};
  const rows = await db('sync_outbox_v2').where({workspace_id: config.workspaceId}).select('state');
  return {
    pending: rows.filter(row => ['pending', 'sending'].includes(String(row.state))).length,
    retrying: rows.filter(row => row.state === 'retry_wait').length,
    conflicts: rows.filter(row => row.state === 'conflict').length,
  };
};

export type V2OutboxDetail = {
  id: number;
  entity_type: V2EntityType;
  operation: V2Operation;
  state: V2OutboxRow['state'];
  entity_name?: string;
  attempt_count: number;
  retry_at?: string | null;
  last_error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export const listV2SyncOutbox = async (): Promise<V2OutboxDetail[]> => {
  await ensureCloudSyncSchema();
  const config = await getCloudSyncConfig();
  if (!config.workspaceId) return [];
  const rows = await db<V2OutboxRow>('sync_outbox_v2')
    .where({workspace_id: config.workspaceId})
    .orderBy('created_at', 'asc');

  return await Promise.all(
    rows.map(async row => {
      const localRecord = await db(row.entity_type).where({cloud_id: row.cloud_id}).first();
      const entityName =
        String(
          localRecord?.name ||
            localRecord?.profile_id ||
            localRecord?.remark ||
            localRecord?.ip ||
            '',
        ).trim() || undefined;
      return {
        id: row.id,
        entity_type: row.entity_type,
        operation: row.operation,
        state: row.state,
        entity_name: entityName,
        attempt_count: Number((row as {attempt_count?: number}).attempt_count || 0),
        retry_at: row.retry_at,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }),
  );
};

type V2Conflict = {
  id: number;
  workspace_id: string;
  entity_type: V2EntityType;
  cloud_id: string;
  base_revision: number;
  canonical_revision: number;
  local_patch: string | Record<string, unknown>;
  canonical_payload: string | Record<string, unknown>;
  conflicting_fields?: string | string[];
  status: string;
};

export type V2ConflictDetail = V2Conflict & {
  entity_name?: string;
  local_id?: number;
  can_recreate_current_workspace: boolean;
  conflicting_fields: string[];
  field_values: Array<{
    field: string;
    local_value: string;
    cloud_value: string;
  }>;
};

const HIDDEN_CONFLICT_FIELDS = new Set<string>();

const conflictFieldList = (
  value: unknown,
  localPatch: Record<string, unknown>,
  canonicalPayload: Record<string, unknown>,
) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value ? [value] : [];
    }
  }
  return Object.keys(localPatch).filter(field => canonicalPayload[field] !== undefined);
};

const displayConflictValue = (field: string, value: unknown) => {
  if (HIDDEN_CONFLICT_FIELDS.has(field)) return '已隐藏（敏感指纹数据）';
  if (value === null || value === undefined || value === '') return '空';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
};

export const listV2SyncConflicts = async () => {
  await ensureCloudSyncSchema();
  const config = await getCloudSyncConfig();
  if (!config.workspaceId) return [] as V2Conflict[];
  const conflicts = await db<V2Conflict>('sync_conflicts_v2')
    .where({workspace_id: config.workspaceId})
    .whereNull('resolved_at')
    .orderBy('created_at', 'desc');

  return await Promise.all(
    conflicts.map(async conflict => {
      const localPatch = parseJson(conflict.local_patch);
      const canonicalPayload = parseJson(conflict.canonical_payload);
      const localRecord = await db(conflict.entity_type)
        .where({cloud_id: conflict.cloud_id, workspace_id: conflict.workspace_id})
        .first();
      const fields = conflictFieldList(conflict.conflicting_fields, localPatch, canonicalPayload);
      const entityName =
        String(localRecord?.name || canonicalPayload.name || '').trim() || undefined;
      const canRecreateCurrentWorkspace = Boolean(
        localRecord?.cloud_id && conflict.status === 'entity_missing',
      );

      return {
        ...conflict,
        entity_name: entityName,
        local_id: typeof localRecord?.id === 'number' ? localRecord.id : undefined,
        can_recreate_current_workspace: canRecreateCurrentWorkspace,
        conflicting_fields: fields,
        field_values: fields.map(field => ({
          field,
          local_value: displayConflictValue(field, localRecord?.[field] ?? localPatch[field]),
          cloud_value: displayConflictValue(field, canonicalPayload[field]),
        })),
      } satisfies V2ConflictDetail;
    }),
  );
};

const applyCanonicalConflictPayload = async (conflict: V2Conflict, database = db) => {
  const payload = parseJson(conflict.canonical_payload);
  const update = canonicalPatch(conflict.entity_type, payload) as Record<string, unknown>;
  update.sync_version = conflict.canonical_revision;
  update.sync_dirty = false;
  update.sync_deleted_at = payload.sync_deleted_at || null;
  update.last_synced_at = database.fn.now();
  if (conflict.entity_type === 'window') {
    if (payload.sync_deleted_at) update.status = 0;
    const groupCloudId = payload.group_cloud_id ? String(payload.group_cloud_id) : null;
    const proxyCloudId = payload.proxy_cloud_id ? String(payload.proxy_cloud_id) : null;
    update.group_cloud_id = groupCloudId;
    update.proxy_cloud_id = proxyCloudId;
    update.group_id = groupCloudId
      ? (
          await database('group')
            .where({cloud_id: groupCloudId, workspace_id: conflict.workspace_id})
            .first()
        )?.id || null
      : null;
    update.proxy_id = proxyCloudId
      ? (
          await database('proxy')
            .where({cloud_id: proxyCloudId, workspace_id: conflict.workspace_id})
            .first()
        )?.id || null
      : null;
    const tagCloudIds = Array.isArray(payload.tag_cloud_ids)
      ? payload.tag_cloud_ids.map(String)
      : [];
    update.tag_cloud_ids = tagCloudIds;
    const tags = tagCloudIds.length
      ? await database('tag')
          .whereIn('cloud_id', tagCloudIds)
          .where({workspace_id: conflict.workspace_id})
          .select('id')
      : [];
    update.tags = tags.map(tag => tag.id).join(',');
  }
  await database(conflict.entity_type)
    .where({cloud_id: conflict.cloud_id, workspace_id: conflict.workspace_id})
    .update(update);
};

const recreateMissingEntityInCurrentWorkspace = async (
  conflict: V2Conflict,
  workspaceId: string,
  deviceId: string,
  database = db,
) => {
  const localEntity = await database(conflict.entity_type)
    .where({cloud_id: conflict.cloud_id, workspace_id: workspaceId})
    .first();
  if (!localEntity) return {success: false, message: 'Local entity not found'};

  const cloudId = randomUUID();
  const recreated = {
    ...localEntity,
    cloud_id: cloudId,
    workspace_id: workspaceId,
    sync_version: 0,
    sync_dirty: true,
    sync_deleted_at: null,
    updated_by_device_id: deviceId,
  } as Record<string, unknown>;

  if (conflict.entity_type === 'window') {
    const groupQuery = recreated.group_id
      ? database('group').where({id: recreated.group_id, workspace_id: workspaceId})
      : undefined;
    const proxyQuery = recreated.proxy_id
      ? database('proxy').where({id: recreated.proxy_id, workspace_id: workspaceId})
      : undefined;
    const [group, proxy] = await Promise.all([
      groupQuery ? groupQuery.first() : undefined,
      proxyQuery ? proxyQuery.first() : undefined,
    ]);
    const tagIds = String(recreated.tags || '')
      .split(',')
      .map(Number)
      .filter(Number.isFinite);
    const tags = tagIds.length
      ? await database('tag')
          .whereIn('id', tagIds)
          .where({workspace_id: workspaceId})
          .select('cloud_id')
      : [];
    recreated.group_cloud_id = group?.workspace_id === workspaceId ? group.cloud_id || null : null;
    recreated.proxy_cloud_id = proxy?.workspace_id === workspaceId ? proxy.cloud_id || null : null;
    recreated.tag_cloud_ids = tags.map(tag => tag.cloud_id).filter(Boolean);
  }

  await database(conflict.entity_type).where({id: localEntity.id}).update(recreated);
  const dependentWindows =
    conflict.entity_type === 'proxy'
      ? await database('window')
          .where({proxy_id: localEntity.id, workspace_id: workspaceId})
          .whereNull('sync_deleted_at')
          .select('id', 'cloud_id')
      : conflict.entity_type === 'group'
        ? await database('window')
            .where({group_id: localEntity.id, workspace_id: workspaceId})
            .whereNull('sync_deleted_at')
            .select('id', 'cloud_id')
        : [];
  if (conflict.entity_type === 'proxy') {
    await database('window')
      .where({proxy_id: localEntity.id, workspace_id: workspaceId})
      .update({proxy_cloud_id: cloudId, updated_at: database.fn.now()});
  }
  if (conflict.entity_type === 'group') {
    await database('window')
      .where({group_id: localEntity.id, workspace_id: workspaceId})
      .update({group_cloud_id: cloudId, updated_at: database.fn.now()});
  }
  await database('sync_outbox_v2')
    .where({
      workspace_id: conflict.workspace_id,
      entity_type: conflict.entity_type,
      cloud_id: conflict.cloud_id,
    })
    .delete();
  await database('sync_outbox_v2').insert({
    workspace_id: workspaceId,
    entity_type: conflict.entity_type,
    cloud_id: cloudId,
    mutation_id: randomUUID(),
    base_revision: 0,
    patch: JSON.stringify(canonicalPatch(conflict.entity_type, recreated)),
    operation: 'create',
    state: 'pending',
    updated_at: database.fn.now(),
  });
  // The recreated reference must be accepted first. Requeue dependent windows
  // shortly afterwards with their new cloud ID, instead of replaying the old
  // reference and creating the same conflict again.
  for (const dependent of dependentWindows) {
    if (!dependent.cloud_id) continue;
    const dependentConflict = await database<V2Conflict>('sync_conflicts_v2')
      .where({
        workspace_id: conflict.workspace_id,
        entity_type: 'window',
        cloud_id: dependent.cloud_id,
      })
      .whereNull('resolved_at')
      .where({status: 'reference_conflict'})
      .first();
    if (!dependentConflict) continue;
    const updatedWindow = await database('window').where({id: dependent.id}).first();
    if (!updatedWindow) continue;
    const requeued = await database('sync_outbox_v2')
      .where({
        workspace_id: conflict.workspace_id,
        entity_type: 'window',
        cloud_id: dependent.cloud_id,
        state: 'conflict',
      })
      .update({
        mutation_id: randomUUID(),
        base_revision: dependentConflict.canonical_revision,
        patch: JSON.stringify(canonicalPatch('window', updatedWindow)),
        state: 'retry_wait',
        retry_at: database.raw("datetime('now', '+1 second')"),
        last_error: null,
        updated_at: database.fn.now(),
      });
    if (requeued) {
      await database('sync_conflicts_v2').where({id: dependentConflict.id}).update({
        status: 'requeued_after_reference_repair',
        resolved_at: database.fn.now(),
      });
    }
  }
  return {success: true, cloudId};
};

export const resolveV2SyncConflict = async (
  conflictId: number,
  resolution: 'keep_cloud' | 'keep_local',
) => {
  await ensureCloudSyncSchema();
  const config = await getCloudSyncConfig();
  if (!config.workspaceId) return {success: false, message: 'No current workspace selected'};
  const workspaceId = config.workspaceId;
  return await db.transaction(async trx => {
    const conflict = await trx<V2Conflict>('sync_conflicts_v2')
      .where({id: conflictId})
      .whereNull('resolved_at')
      .first();
    if (!conflict) return {success: false, message: 'Conflict not found'};
    if (conflict.status === 'tombstone_conflict' && resolution === 'keep_local') {
      return {
        success: false,
        message: 'Remote deletion cannot be overwritten. Recover it as a new window instead.',
      };
    }
    const localEntity =
      resolution === 'keep_local'
        ? await trx(conflict.entity_type).where({cloud_id: conflict.cloud_id}).first()
        : undefined;
    // entity_missing means this cloud ID does not exist in the selected team.
    // Recreate it even if local metadata already says it belongs to that team.
    const shouldRecreate = Boolean(localEntity?.cloud_id && conflict.status === 'entity_missing');
    if (resolution === 'keep_cloud') {
      await applyCanonicalConflictPayload(conflict, trx);
      await trx('sync_outbox_v2')
        .where({
          workspace_id: conflict.workspace_id,
          entity_type: conflict.entity_type,
          cloud_id: conflict.cloud_id,
          state: 'conflict',
        })
        .delete();
    } else if (shouldRecreate) {
      const recreated = await recreateMissingEntityInCurrentWorkspace(
        conflict,
        workspaceId,
        config.deviceId || '',
        trx,
      );
      if (!recreated.success) return recreated;
    } else {
      const mutationId = randomUUID();
      const patch =
        conflict.status === 'reference_conflict' && localEntity
          ? conflict.entity_type === 'window'
            ? await normalizeWindowReferences(
                canonicalPatch('window', localEntity),
                localEntity,
                trx,
              )
            : canonicalPatch(conflict.entity_type, localEntity)
          : parseJson(conflict.local_patch);
      const updated = await trx('sync_outbox_v2')
        .where({
          workspace_id: conflict.workspace_id,
          entity_type: conflict.entity_type,
          cloud_id: conflict.cloud_id,
          state: 'conflict',
        })
        .update({
          mutation_id: mutationId,
          base_revision: conflict.canonical_revision,
          patch: JSON.stringify(patch),
          state: 'pending',
          retry_at: null,
          last_error: null,
          updated_at: trx.fn.now(),
        });
      if (!updated) {
        await trx('sync_outbox_v2').insert({
          workspace_id: conflict.workspace_id,
          entity_type: conflict.entity_type,
          cloud_id: conflict.cloud_id,
          mutation_id: mutationId,
          base_revision: conflict.canonical_revision,
          patch: JSON.stringify(patch),
          operation: 'patch',
          state: 'pending',
          retry_at: null,
          updated_at: trx.fn.now(),
        });
      }
    }
    await trx('sync_conflicts_v2')
      .where({id: conflictId})
      .update({
        status: shouldRecreate ? 'recreated_current_workspace' : resolution,
        resolved_at: trx.fn.now(),
      });
    return {success: true, resolution, recreated: shouldRecreate};
  });
};
