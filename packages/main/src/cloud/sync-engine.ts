import {db} from '../db';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {cloudApiClient} from './client';
import {ensureCloudSyncSchema} from './schema';
import {randomUUID} from 'crypto';
import {createInterface} from 'node:readline';
import type {Knex} from 'knex';
import {discardDeviceLocalSyncOutbox, enqueueSyncOutbox} from './sync-outbox';
import {flushV2Outbox, getV2OutboxCounts} from './sync-v2-outbox';
import type {SyncOperation} from './sync-outbox';
import {
  isAcceptedDelete,
  isAuthorityExportableWindow,
  isDeviceLocalSyncEntity,
  isValidV2SnapshotEntity,
  shouldApplyIncomingRevision,
  shouldQuarantineLegacyMutation,
  synchronizedReference,
  withEventWorkspace,
} from './sync-safety';
import {retryClosedCloudProfileDrafts} from './profile-data-sync';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const DEFAULT_FLUSH_LIMIT = 50;
const DEFAULT_PULL_LIMIT = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
// A cursor reset can need to consume tens of thousands of legacy events.
// V2 replaces this with snapshot bootstrap, but V1 must not silently stop
// after only 4,000 rows while existing workspaces are still migrating.
const MAX_DRAIN_ROUNDS = 500;
const SYNC_STATE_ENTITY = 'all';
const SNAPSHOT_STAGE_PAGE_SIZE = 200;
// A canonical snapshot stream that stops producing lines for this long is
// treated as stalled. Aborting the stream lets the bootstrap fail cleanly
// instead of hanging the sync engine (and the team-entry call) forever.
const SNAPSHOT_STREAM_IDLE_TIMEOUT_MS = 30_000;
type QueryDb = Knex | Knex.Transaction;

type SyncOutboxRow = {
  id: number;
  workspace_id: string | null;
  entity_type: string;
  local_id: string | null;
  cloud_id: string | null;
  operation: string;
  payload: string | null;
  created_at: string;
  attempt_count: number | null;
  mutation_id: string | null;
  expected_revision: number | null;
};

type OutboxMutationResult = {
  mutation_id?: string;
  entity_type: string;
  cloud_id: string;
  operation?: SyncOperation;
  revision: number;
  deleted_at?: string | null;
  cursor: number;
};

type OutboxResponse = {
  success?: boolean;
  mutations?: OutboxMutationResult[];
};

let flushTimer: NodeJS.Timeout | undefined;
let profileDraftRetryTimer: NodeJS.Timeout | undefined;
let isFlushing = false;
let isPulling = false;
let engineBooting = false;
let recoveringV2CanonicalSnapshot = false;
let maxPendingOutbox = 0;
let lastSyncActivityAt = 0;
const hasUpdatedAtColumnCache = new Map<string, boolean>();

const updateWithTimestampIfSupported = async (
  tableName: string,
  where: Record<string, unknown>,
  payload: Record<string, unknown>,
) => {
  let hasUpdatedAt = hasUpdatedAtColumnCache.get(tableName);
  if (hasUpdatedAt === undefined) {
    hasUpdatedAt = await db.schema.hasColumn(tableName, 'updated_at');
    hasUpdatedAtColumnCache.set(tableName, hasUpdatedAt);
  }
  const updatePayload = hasUpdatedAt ? {...payload, updated_at: db.fn.now()} : payload;
  await db(tableName).where(where).update(updatePayload);
};

export const flushSyncOutbox = async (limit = DEFAULT_FLUSH_LIMIT) => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled) {
    return {success: true, skipped: true, count: 0};
  }
  if (!config.workspaceId) {
    return {success: false, skipped: true, count: 0, error: '当前未选择云端工作区'};
  }

  if (config.protocolVersion === 2) {
    const result = await flushV2Outbox();
    if (!('requiresCanonicalSnapshot' in result) || !result.requiresCanonicalSnapshot)
      return result;
    if (recoveringV2CanonicalSnapshot) return result;
    recoveringV2CanonicalSnapshot = true;
    try {
      // The Service rejects mutations until this device has applied and ACKed
      // its canonical snapshot. Keep the local V2 outbox intact, reconcile,
      // then resume the same queued changes.
      await bootstrapV2Workspace(config, true);
      await pullSyncEventsUntilIdle();
      return await flushV2Outbox();
    } catch (error) {
      const recoveryError = error instanceof Error ? error.message : String(error);
      return {success: false, count: 0, error: `同步前重拉权威快照失败: ${recoveryError}`};
    } finally {
      recoveringV2CanonicalSnapshot = false;
    }
  }

  if (isFlushing) {
    return {success: true, skipped: true, count: 0};
  }

  isFlushing = true;
  let rows: SyncOutboxRow[] = [];
  try {
    rows = await db<SyncOutboxRow>('sync_outbox')
      .whereNull('processed_at')
      .whereNull('blocked_at')
      .where(builder =>
        builder.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', db.fn.now()),
      )
      .where(builder => {
        builder.where('workspace_id', config.workspaceId);
      })
      .orderBy('created_at', 'asc')
      .limit(limit);

    if (!rows.length) {
      return {success: true, count: 0};
    }

    const events = rows.map(row => ({
      id: row.id,
      entity_type: row.entity_type,
      local_id: row.local_id,
      cloud_id: row.cloud_id,
      operation: row.operation,
      payload: parsePayload(row.payload),
      created_at: row.created_at,
      mutation_id: row.mutation_id,
      expected_revision: row.expected_revision,
    }));

    const response = await cloudApiClient.request<OutboxResponse>('post', '/sync/outbox', {
      workspace_id: config.workspaceId,
      device_id: config.deviceId,
      events,
    });
    if (!response?.success) {
      throw new Error('Cloud sync outbox was not accepted');
    }
    await applyAcceptedOutboxMutations(response.mutations || [], rows);

    await db('sync_outbox')
      .whereIn(
        'id',
        rows.map(row => row.id),
      )
      .update({
        processed_at: db.fn.now(),
        updated_at: db.fn.now(),
        last_error: null,
      });

    lastSyncActivityAt = Date.now();
    return {success: true, count: rows.length};
  } catch (error) {
    logger.error('Cloud sync outbox flush failed', error);
    const status = (error as {response?: {status?: number; data?: unknown}})?.response?.status;
    if (status === 409 && rows.length) {
      const remotePayload = (error as {response?: {data?: unknown}})?.response?.data || {};
      for (const row of rows) {
        await recordSyncConflict(
          row.entity_type,
          row.local_id ? Number(row.local_id) : undefined,
          row.cloud_id || '',
          parsePayload(row.payload),
          remotePayload,
          'outbox_revision_conflict',
        );
      }
      await db('sync_outbox')
        .whereIn(
          'id',
          rows.map(row => row.id),
        )
        .update({
          processed_at: db.fn.now(),
          updated_at: db.fn.now(),
          last_error: 'Server rejected stale revision; local data preserved as a conflict.',
        });
      return {success: false, count: 0, conflict: true};
    }
    const retryRows = rows.map(row => row.id);
    const retryDelaySeconds = Math.min(
      MAX_RETRY_DELAY_MS / 1000,
      5 * 2 ** Math.min(Math.max(...rows.map(row => Number(row.attempt_count || 0)), 0), 6),
    );
    await db('sync_outbox')
      .whereIn('id', retryRows)
      .update({
        attempt_count: db.raw('attempt_count + 1'),
        updated_at: db.fn.now(),
        next_attempt_at: db.raw(`datetime('now', '+${retryDelaySeconds} seconds')`),
        last_error: error instanceof Error ? error.message : String(error),
      });
    return {
      success: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    isFlushing = false;
  }
};

const applyAcceptedOutboxMutations = async (
  mutations: OutboxMutationResult[],
  outboxRows: Pick<
    SyncOutboxRow,
    'mutation_id' | 'entity_type' | 'cloud_id' | 'operation' | 'workspace_id'
  >[],
) => {
  const outboxByMutationId = new Map(
    outboxRows.filter(row => row.mutation_id).map(row => [row.mutation_id!, row]),
  );
  const config = await cloudApiClient.getConfig();
  for (const mutation of mutations) {
    if (!['group', 'proxy', 'tag', 'window'].includes(mutation.entity_type)) continue;
    const outboxRow = mutation.mutation_id
      ? outboxByMutationId.get(mutation.mutation_id)
      : undefined;
    const workspaceId = outboxRow ? outboxRow.workspace_id : config.workspaceId;
    const operation = mutation.operation || outboxRow?.operation;
    const update = {
      sync_version: mutation.revision,
      sync_dirty: false,
      sync_deleted_at: isAcceptedDelete(operation) ? mutation.deleted_at || db.fn.now() : null,
      last_synced_at: db.fn.now(),
    };
    const query = db(mutation.entity_type).where({cloud_id: mutation.cloud_id});
    if (workspaceId) query.where({workspace_id: workspaceId});
    else query.whereNull('workspace_id');
    await query.update(update);
  }
};

export const startCloudSyncEngine = async ({
  forceCanonicalSnapshot = false,
}: {forceCanonicalSnapshot?: boolean} = {}) => {
  await ensureCloudSyncSchema();
  await discardDeviceLocalSyncOutbox();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || flushTimer || engineBooting) {
    return;
  }
  engineBooting = true;
  try {
    // The initial workspace bootstrap and drain can be slow (large canonical
    // snapshot, 25s long-polls) or stall. A failure here must not prevent the
    // periodic loop from being scheduled — otherwise a hung first pass would
    // leave cloud sync permanently dead for the session.
    try {
      if (config.protocolVersion === 2) {
        await bootstrapV2Workspace(config, forceCanonicalSnapshot);
      }
      await quarantineLegacyOutbox(config.workspaceId);
      // Pull canonical workspace state before considering any local rows.
      // Legacy rows may belong to another workspace and must only be imported
      // explicitly.
      await pullSyncEventsUntilIdle();
      await repairWindowRelationsFromCloudIds();
      await retryClosedCloudProfileDrafts();
    } catch (error) {
      logger.error(
        'Cloud sync engine initial pass failed; continuing with the scheduled loop',
        error,
      );
    }

    // V2 pull can long-poll for 25 seconds. Closed Profile drafts must not wait
    // behind that request after connectivity returns.
    profileDraftRetryTimer = setInterval(() => {
      retryClosedCloudProfileDrafts().catch(error => {
        logger.error('Closed profile draft retry failed', error);
      });
    }, 15_000);

    flushTimer = setInterval(
      () => {
        (async () => {
          await pullThenFlush();
          await retryClosedCloudProfileDrafts();
        })().catch(error => {
          logger.error('Scheduled cloud sync failed', error);
        });
      },
      config.protocolVersion === 2 ? 30_000 : DEFAULT_FLUSH_INTERVAL_MS,
    );

    // Callers that deliberately refresh the configuration (such as team
    // selection) await this first pass before rendering workspace data. Normal
    // application startup still invokes this function in the background.
    try {
      await pullThenFlush();
      await retryClosedCloudProfileDrafts();
    } catch (error) {
      // Preserve the previous best-effort startup behavior when the service is
      // temporarily unavailable. Scheduled sync will retry after startup.
      logger.error('Initial cloud sync failed', error);
    }
  } finally {
    engineBooting = false;
  }
};

export const stopCloudSyncEngine = () => {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  if (profileDraftRetryTimer) {
    clearInterval(profileDraftRetryTimer);
    profileDraftRetryTimer = undefined;
  }
};

const pullThenFlush = async () => {
  await pullSyncEventsUntilIdle();
  return await flushSyncOutboxUntilIdle();
};

const quarantineLegacyOutbox = async (workspaceId?: string) => {
  const rows = await db<SyncOutboxRow>('sync_outbox')
    .whereNull('processed_at')
    .whereNull('mutation_id')
    .where(builder => {
      builder.whereNull('workspace_id');
      if (workspaceId) builder.orWhere('workspace_id', workspaceId);
    });
  const legacyRows = rows.filter(row => shouldQuarantineLegacyMutation(row.mutation_id));
  if (!legacyRows.length) return;

  for (const row of legacyRows) {
    await recordSyncConflict(
      row.entity_type,
      row.local_id ? Number(row.local_id) : undefined,
      row.cloud_id || '',
      parsePayload(row.payload),
      {reason: 'legacy_outbox_quarantined_before_canonical_pull'},
      'bootstrap_outbox_quarantined',
    );
  }
  await db('sync_outbox')
    .whereIn(
      'id',
      legacyRows.map(row => row.id),
    )
    .update({
      blocked_at: db.fn.now(),
      blocked_reason:
        'Legacy mutation has no idempotency/revision metadata. Export authority snapshot and approve repair before replay.',
      updated_at: db.fn.now(),
    });
};

const parsePayload = (payload: unknown) => {
  if (!payload || typeof payload !== 'string') {
    return payload || {};
  }

  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
};

type CloudSyncEvent = {
  cursor?: number;
  id?: number;
  workspace_id?: string;
  device_id?: string;
  entity_type: string;
  local_id?: number;
  cloud_id?: string;
  operation: 'create' | 'update' | 'patch' | 'delete';
  payload?: unknown;
  revision?: number;
  deleted_at?: string | null;
  created_at?: string;
  received_at?: string;
};

type PullResponse = {
  success: boolean;
  events?: CloudSyncEvent[];
  next_cursor?: number;
  has_more?: boolean;
};

type AuthoritySnapshotResponse = {
  success?: boolean;
  workspace_id?: string;
  cursor?: number;
  entities?: Array<CloudSyncEvent & {revision?: number; deleted_at?: string | null}>;
};

export const pullSyncEvents = async (limit = DEFAULT_PULL_LIMIT) => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || !config.workspaceId) {
    return {success: true, skipped: true, count: 0};
  }

  if (isPulling) {
    return {success: true, skipped: true, count: 0};
  }

  isPulling = true;
  try {
    const state = await db('sync_state')
      .where({workspace_id: config.workspaceId, entity_type: SYNC_STATE_ENTITY})
      .first();
    const cursor = Number(state?.cursor || 0) || 0;

    if (config.protocolVersion === 2) {
      return await pullV2SyncEvents(config, cursor, limit);
    }

    const response = await cloudApiClient.request<PullResponse>('post', '/sync/pull', {
      workspace_id: config.workspaceId,
      device_id: config.deviceId,
      cursor,
      limit,
    });

    if (!response?.success) {
      return {success: true, count: 0};
    }

    const events = Array.isArray(response.events) ? response.events : [];
    if (!events.length) {
      return {success: true, count: 0};
    }

    let maxCursor = cursor;
    let appliedCount = 0;
    for (const event of events) {
      const eventCursor = event.cursor || 0;
      if (event.device_id && event.device_id === config.deviceId) {
        if (eventCursor > maxCursor) {
          maxCursor = eventCursor;
        }
        continue;
      }

      try {
        await applySyncEvent(event);
        appliedCount++;
        if (eventCursor > maxCursor) {
          maxCursor = eventCursor;
        }
      } catch (error) {
        logger.error('Cloud sync apply event failed', {
          error: error instanceof Error ? error.message : String(error),
          entityType: event.entity_type,
          operation: event.operation,
          cloudId: event.cloud_id,
          cursor: event.cursor,
        });
        // Keep cursor at last successfully applied event so failed event can be retried.
        break;
      }
    }

    await upsertSyncCursor(config.workspaceId, maxCursor);
    if (appliedCount > 0) {
      lastSyncActivityAt = Date.now();
    }
    return {
      success: true,
      count: appliedCount,
      received_count: events.length,
      next_cursor: maxCursor,
      has_more: Boolean(response.has_more),
    };
  } catch (error) {
    logger.error('Cloud sync pull failed', error);
    return {
      success: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    isPulling = false;
  }
};

const v2Path = (workspaceId: string, suffix: string) =>
  `/teams/${encodeURIComponent(workspaceId)}/sync/v2/${suffix}`;

const bootstrapV2Workspace = async (
  config: Awaited<ReturnType<typeof cloudApiClient.getConfig>>,
  forceCanonicalSnapshot = false,
) => {
  if (!config.workspaceId) return;
  const workspaceId = config.workspaceId;
  const registration = await cloudApiClient.request<{
    success?: boolean;
    data?: {bootstrap_state?: string; last_ack_cursor?: number};
  }>('post', v2Path(workspaceId, 'devices/register'), {
    device_id: config.deviceId,
    protocol_version: 2,
    device_name: config.deviceName,
    platform: process.platform,
  });
  if (!registration?.success) throw new Error('V2 device registration was not accepted');
  if (registration.data?.bootstrap_state === 'ready' && !forceCanonicalSnapshot) return;

  const snapshot = await cloudApiClient.requestStream(v2Path(workspaceId, 'snapshot/stream'));
  if (!snapshot) throw new Error('V2 canonical snapshot stream was not accepted');
  await db('sync_bootstrap_stage_v2').where({workspace_id: workspaceId}).delete();
  let cutCursor = 0;
  let completed = false;
  const lines = createInterface({input: snapshot.stream, crlfDelay: Infinity});
  // A snapshot stream that stops producing lines is aborted instead of
  // hanging the bootstrap (and its callers) forever. A failed bootstrap is
  // recovered by the scheduled sync loop via event replay.
  let streamIdleTimer: NodeJS.Timeout | undefined;
  const resetStreamIdleTimer = () => {
    if (streamIdleTimer) clearTimeout(streamIdleTimer);
    streamIdleTimer = setTimeout(() => {
      logger.error('V2 snapshot stream stalled; aborting bootstrap', {workspaceId});
      snapshot.stream.destroy(new Error('V2 snapshot stream idle timeout'));
    }, SNAPSHOT_STREAM_IDLE_TIMEOUT_MS);
  };
  try {
    resetStreamIdleTimer();
    for await (const line of lines) {
      resetStreamIdleTimer();
      if (!line.trim()) continue;
      const item = JSON.parse(line) as {type?: string; cut_cursor?: number} & CloudSyncEvent;
      if (item.type === 'header') {
        cutCursor = Number(item.cut_cursor || 0);
        continue;
      }
      if (item.type === 'entity') {
        const cloudId = String(item.cloud_id || '');
        // Older clients may have placed device-local extension settings in a
        // canonical snapshot. Skip them without failing the remaining team
        // metadata bootstrap.
        if (isDeviceLocalSyncEntity(item.entity_type)) continue;
        if (!isValidV2SnapshotEntity(item.entity_type, cloudId)) {
          throw new Error('V2 snapshot contains an invalid entity');
        }
        await db('sync_bootstrap_stage_v2').insert({
          workspace_id: workspaceId,
          entity_type: item.entity_type,
          cloud_id: cloudId,
          event: JSON.stringify({
            ...item,
            workspace_id: workspaceId,
            operation: item.deleted_at ? 'delete' : 'update',
          }),
        });
        continue;
      }
      if (item.type === 'end') {
        completed = true;
        cutCursor = Number(item.cut_cursor || cutCursor);
      }
    }
    if (!completed) throw new Error('V2 snapshot stream ended before its completion marker');
  } finally {
    if (streamIdleTimer) clearTimeout(streamIdleTimer);
  }
  await createV2BootstrapBackup(workspaceId);
  await db.transaction(async trx => {
    let afterId = 0;
    for (;;) {
      const staged = (await trx('sync_bootstrap_stage_v2')
        .where({workspace_id: workspaceId})
        .where('id', '>', afterId)
        .orderBy('id', 'asc')
        .limit(SNAPSHOT_STAGE_PAGE_SIZE)) as Array<{id: number; event: string | CloudSyncEvent}>;
      if (!staged.length) break;
      for (const row of staged) {
        const event =
          typeof row.event === 'string' ? (JSON.parse(row.event) as CloudSyncEvent) : row.event;
        await applySyncEvent(event, trx);
        afterId = row.id;
      }
    }
    await upsertSyncCursor(workspaceId, cutCursor, trx);
    await trx('sync_bootstrap_stage_v2').where({workspace_id: workspaceId}).delete();
  });
  const ack = await cloudApiClient.request<{success?: boolean; data?: {bootstrap_state?: string}}>(
    'post',
    v2Path(workspaceId, 'ack'),
    {cursor: cutCursor},
  );
  if (!ack?.success || ack.data?.bootstrap_state !== 'ready')
    throw new Error('V2 snapshot acknowledgement was not accepted');
  await db('sync_device_state_v2')
    .insert({
      workspace_id: workspaceId,
      bootstrap_state: 'ready',
      cursor: String(cutCursor),
      last_ack_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .onConflict('workspace_id')
    .merge({
      bootstrap_state: 'ready',
      cursor: String(cutCursor),
      last_ack_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
};

const pullV2SyncEvents = async (
  config: Awaited<ReturnType<typeof cloudApiClient.getConfig>>,
  cursor: number,
  limit: number,
) => {
  if (!config.workspaceId) return {success: true, count: 0};
  const response = await cloudApiClient.request<PullResponse>(
    'post',
    v2Path(config.workspaceId, 'pull'),
    {cursor, limit, wait_ms: 25_000},
    {timeout: 30_000},
  );
  if (!response?.success) return {success: true, count: 0};
  const events = response.events || [];
  let maxCursor = cursor;
  let appliedCount = 0;
  for (const event of events) {
    try {
      await applySyncEvent(event);
      appliedCount++;
      maxCursor = Math.max(maxCursor, Number(event.cursor || 0));
    } catch (error) {
      logger.error('V2 cloud sync apply event failed', {
        cloudId: event.cloud_id,
        cursor: event.cursor,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  await upsertSyncCursor(config.workspaceId, maxCursor);
  await cloudApiClient.request('post', v2Path(config.workspaceId, 'ack'), {cursor: maxCursor});
  if (appliedCount) lastSyncActivityAt = Date.now();
  return {
    success: true,
    count: appliedCount,
    received_count: events.length,
    next_cursor: maxCursor,
    has_more: Boolean(response.has_more),
  };
};

export const resetSyncCursor = async (workspaceId?: string) => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  const targetWorkspace = workspaceId || config.workspaceId;
  if (!targetWorkspace) {
    return {success: false, message: 'workspace_id is required'};
  }

  await db('sync_state')
    .where({workspace_id: targetWorkspace, entity_type: SYNC_STATE_ENTITY})
    .delete();
  return {success: true, workspace_id: targetWorkspace};
};

export const inspectCloudSyncRepair = async () => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  const entities: Record<string, unknown> = {};

  for (const tableName of ['group', 'proxy', 'tag', 'window']) {
    if (!(await db.schema.hasTable(tableName))) continue;
    const rows = await db(tableName).select('id', 'cloud_id', 'workspace_id', 'sync_deleted_at');
    const cloudIds = new Map<string, number[]>();
    let unbound = 0;
    for (const row of rows) {
      if (!row.cloud_id || !row.workspace_id) unbound++;
      if (row.cloud_id) {
        const cloudId = String(row.cloud_id);
        cloudIds.set(cloudId, [...(cloudIds.get(cloudId) || []), Number(row.id)]);
      }
    }
    entities[tableName] = {
      rows: rows.length,
      unbound,
      duplicates: [...cloudIds.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([cloudId, ids]) => ({cloudId, ids})),
    };
  }

  const groups = new Set((await db('group').select('id')).map(row => Number(row.id)));
  const proxies = new Set((await db('proxy').select('id')).map(row => Number(row.id)));
  const windows = await db('window').select('id', 'group_id', 'proxy_id');
  const danglingReferences = windows.flatMap(row => {
    const issues: Array<{windowId: number; relation: string; localId: number}> = [];
    if (row.group_id && !groups.has(Number(row.group_id)))
      issues.push({windowId: Number(row.id), relation: 'group', localId: Number(row.group_id)});
    if (row.proxy_id && !proxies.has(Number(row.proxy_id)))
      issues.push({windowId: Number(row.id), relation: 'proxy', localId: Number(row.proxy_id)});
    return issues;
  });

  const pending = await db('sync_outbox')
    .whereNull('processed_at')
    .count<{count: number}[]>('* as count')
    .first();
  return {
    success: true,
    dryRun: true,
    workspaceId: config.workspaceId || null,
    authorityRequired: true,
    entities,
    danglingReferences,
    pendingOutbox: Number(pending?.count || 0),
    nextStep:
      'Export this report with the selected Windows authority snapshot. Do not reset cursors or clear outboxes until explicit approval.',
  };
};

export const exportCloudSyncAuthoritySnapshot = async () => {
  const report = await inspectCloudSyncRepair();
  const config = await cloudApiClient.getConfig();
  const entities: Record<string, unknown[]> = {};
  let excludedInactiveWindows = 0;
  for (const tableName of ['group', 'proxy', 'tag', 'window']) {
    if (!(await db.schema.hasTable(tableName))) continue;
    const rows = await db(tableName)
      .where(builder => {
        builder.whereNull('workspace_id');
        if (config.workspaceId) builder.orWhere('workspace_id', config.workspaceId);
      })
      .select('*');
    if (tableName === 'window') {
      const exportable = rows.filter(isAuthorityExportableWindow);
      excludedInactiveWindows = rows.length - exportable.length;
      entities[tableName] = exportable;
    } else {
      entities[tableName] = rows;
    }
  }
  return {
    format: 'cloak-cloud-authority-snapshot/v1',
    createdAt: new Date().toISOString(),
    workspaceId: config.workspaceId || null,
    deviceId: config.deviceId,
    entities,
    report,
    excludedInactiveWindows,
    warning:
      'Read-only export. Submit only to the repair dry-run endpoint; it contains browser configuration data.',
  };
};

export const acceptAuthorityRepairOnThisDevice = async (repairId: string) => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || !config.workspaceId) {
    return {success: false, message: 'cloud sync is disabled or workspace_id is empty'};
  }
  const repair = await cloudApiClient.request<{
    success?: boolean;
    data?: {status?: string; workspace_id?: string};
  }>('get', `/sync/repairs/${encodeURIComponent(repairId)}`);
  if (
    !repair?.success ||
    repair.data?.status !== 'applied' ||
    repair.data.workspace_id !== config.workspaceId
  ) {
    return {
      success: false,
      message: 'The authority repair is not an applied repair for the current workspace',
    };
  }
  const authoritySnapshot = await cloudApiClient.request<AuthoritySnapshotResponse>(
    'post',
    '/sync/snapshot',
    {
      workspace_id: config.workspaceId,
    },
  );
  if (
    !authoritySnapshot?.success ||
    authoritySnapshot.workspace_id !== config.workspaceId ||
    !Array.isArray(authoritySnapshot.entities)
  ) {
    return {success: false, message: 'Could not load the server-authoritative snapshot'};
  }

  const tableNames = ['group', 'proxy', 'tag', 'window'];
  const snapshot: Record<string, unknown> = {entities: {}, outbox: [], syncState: [], profiles: []};
  for (const tableName of tableNames) {
    snapshot.entities = {
      ...(snapshot.entities as Record<string, unknown>),
      [tableName]: await db(tableName)
        .where(builder =>
          builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId),
        )
        .select('*'),
    };
  }
  snapshot.outbox = await db('sync_outbox')
    .where(builder => builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId))
    .select('*');
  snapshot.syncState = await db('sync_state').where({workspace_id: config.workspaceId}).select('*');
  snapshot.profiles = await db('profile_sync_state').select('*');
  const targetWindowIds = ((snapshot.entities as Record<string, Array<{id?: number}>>).window || [])
    .map(row => row.id)
    .filter((id): id is number => typeof id === 'number');

  const engineWasRunning = Boolean(flushTimer);
  stopCloudSyncEngine();
  try {
    await db.transaction(async trx => {
      await trx('sync_repair_local_backup').insert({
        repair_id: repairId,
        workspace_id: config.workspaceId,
        payload: JSON.stringify(snapshot),
      });
      await trx('sync_outbox')
        .where(builder =>
          builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId),
        )
        .delete();
      await trx('sync_state').where({workspace_id: config.workspaceId}).delete();
      for (const tableName of tableNames) {
        const update: Record<string, unknown> = {
          sync_deleted_at: trx.fn.now(),
          sync_dirty: false,
          last_synced_at: null,
        };
        if (tableName === 'window') update.status = 0;
        await trx(tableName)
          .where(builder =>
            builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId),
          )
          .update(update);
      }
      if (targetWindowIds.length) {
        await trx('profile_sync_state').whereIn('window_id', targetWindowIds).update({
          cloud_revision: null,
          profile_dirty: false,
          offline_dirty: false,
          conflict_status: 'authority_repair_pending_profile_refresh',
          updated_at: trx.fn.now(),
        });
      }
    });

    for (const entity of authoritySnapshot.entities) {
      await applySyncEvent({
        ...entity,
        workspace_id: config.workspaceId,
        payload: {
          ...(parsePayload(entity.payload) as Record<string, unknown>),
          sync_version: entity.revision,
          sync_deleted_at: entity.deleted_at || null,
        },
      });
    }
    await upsertSyncCursor(config.workspaceId, Number(authoritySnapshot.cursor || 0));
    await db('window')
      .where(builder =>
        builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId),
      )
      .whereNull('sync_deleted_at')
      .update({status: 1, updated_at: db.fn.now()});
    return {success: true, repairId, pulled: authoritySnapshot.entities.length};
  } catch (error) {
    return {
      success: false,
      repairId,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (engineWasRunning) {
      await startCloudSyncEngine();
    }
  }
};

export const rebuildCloudSyncOutboxForWorkspace = async () => {
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || !config.workspaceId) {
    return {success: false, message: 'cloud sync is disabled or workspace_id is empty'};
  }

  // Rebuilding creates new cloud identities for rows that were never bound.
  // That is destructive in a nonempty workspace, so the old automatic path is
  // deliberately retired in favor of the explicit authority repair workflow.
  if (config.workspaceId) {
    return {
      success: false,
      message:
        'Automatic outbox rebuild is disabled. Export the authority snapshot and review the dry-run repair report first.',
    };
  }

  await backfillLegacyCloudSyncData();
  await mergeDuplicateGroupsByName();
  await repairWindowRelationsFromCloudIds();

  let groupsEnqueued = 0;
  let proxiesEnqueued = 0;
  let windowsEnqueued = 0;

  const groups = await db('group')
    .where(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId);
    })
    .select('*');
  for (const group of groups) {
    const cloudId = group.cloud_id || randomUUID();
    if (!group.cloud_id || !group.workspace_id) {
      await updateWithTimestampIfSupported(
        'group',
        {id: group.id},
        {
          cloud_id: cloudId,
          workspace_id: group.workspace_id || config.workspaceId,
          sync_dirty: true,
          updated_by_device_id: config.deviceId,
        },
      );
    }
    const latestGroup = await db('group').where({id: group.id}).first();
    await enqueueSyncOutbox('group', group.cloud_id ? 'update' : 'create', {
      localId: group.id,
      cloudId,
      data: latestGroup,
    });
    groupsEnqueued++;
  }

  const proxies = await db('proxy')
    .where(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId);
    })
    .select('*');
  for (const proxy of proxies) {
    const cloudId = proxy.cloud_id || randomUUID();
    if (!proxy.cloud_id || !proxy.workspace_id) {
      await updateWithTimestampIfSupported(
        'proxy',
        {id: proxy.id},
        {
          cloud_id: cloudId,
          workspace_id: proxy.workspace_id || config.workspaceId,
          sync_dirty: true,
          updated_by_device_id: config.deviceId,
        },
      );
    }
    const latestProxy = await db('proxy').where({id: proxy.id}).first();
    await enqueueSyncOutbox('proxy', proxy.cloud_id ? 'update' : 'create', {
      localId: proxy.id,
      cloudId,
      data: latestProxy,
    });
    proxiesEnqueued++;
  }

  const windows = await db('window')
    .where('status', '>', 0)
    .andWhere(builder => {
      builder.whereNull('workspace_id').orWhere('workspace_id', config.workspaceId);
    })
    .select('*');
  for (const windowData of windows) {
    const cloudId = windowData.cloud_id || randomUUID();
    if (!windowData.cloud_id || !windowData.workspace_id) {
      await updateWithTimestampIfSupported(
        'window',
        {id: windowData.id},
        {
          cloud_id: cloudId,
          workspace_id: windowData.workspace_id || config.workspaceId,
          sync_dirty: true,
          updated_by_device_id: config.deviceId,
        },
      );
    }
    const latestWindow = await db('window').where({id: windowData.id}).first();
    await enqueueSyncOutbox('window', windowData.cloud_id ? 'update' : 'create', {
      localId: windowData.id,
      cloudId,
      data: latestWindow,
    });
    windowsEnqueued++;
  }

  const flushResult = await flushSyncOutboxUntilIdle();
  logger.info('Cloud sync outbox rebuilt for workspace', {
    workspaceId: config.workspaceId,
    groupsEnqueued,
    proxiesEnqueued,
    windowsEnqueued,
    flushed: flushResult?.count || 0,
  });

  return {
    success: true,
    workspaceId: config.workspaceId,
    groupsEnqueued,
    proxiesEnqueued,
    windowsEnqueued,
    flushed: flushResult?.count || 0,
  };
};

export const getCloudSyncProgress = async () => {
  await ensureCloudSyncSchema();
  const config = await cloudApiClient.getConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      pendingOutbox: 0,
      progressPercent: 100,
      syncing: false,
      lastSyncActivityAt: lastSyncActivityAt || null,
    };
  }

  if (config.protocolVersion === 2) {
    const counts = await getV2OutboxCounts();
    const pendingOutbox = counts.pending + counts.retrying;
    return {
      enabled: true,
      protocolVersion: 2,
      pendingOutbox,
      retrying: counts.retrying,
      conflicts: counts.conflicts,
      progressPercent: pendingOutbox === 0 ? 100 : 1,
      syncing: isFlushing || isPulling || pendingOutbox > 0,
      lastSyncActivityAt: lastSyncActivityAt || null,
    };
  }

  const pendingRow = await db('sync_outbox')
    .whereNull('processed_at')
    .where(builder => {
      builder.whereNull('workspace_id');
      if (config.workspaceId) {
        builder.orWhere('workspace_id', config.workspaceId);
      }
    })
    .count<{count: number}[]>('* as count')
    .first();

  const pendingOutbox = Number(pendingRow?.count || 0) || 0;
  if (pendingOutbox > maxPendingOutbox) {
    maxPendingOutbox = pendingOutbox;
  }
  if (pendingOutbox === 0) {
    maxPendingOutbox = 0;
  }

  const baseline = Math.max(maxPendingOutbox, pendingOutbox, 1);
  const progressPercent =
    pendingOutbox === 0
      ? 100
      : Math.max(1, Math.min(99, Math.round(((baseline - pendingOutbox) / baseline) * 100)));

  return {
    enabled: true,
    pendingOutbox,
    progressPercent,
    syncing: isFlushing || isPulling || pendingOutbox > 0,
    lastSyncActivityAt: lastSyncActivityAt || null,
  };
};

const flushSyncOutboxUntilIdle = async () => {
  let total = 0;
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    const result = await flushSyncOutbox();
    const count = Number(result?.count || 0);
    total += count;
    if (
      !result?.success ||
      ('skipped' in result && result.skipped) ||
      count < DEFAULT_FLUSH_LIMIT
    ) {
      break;
    }
  }
  return {success: true, count: total};
};

const pullSyncEventsUntilIdle = async (maxRounds = MAX_DRAIN_ROUNDS) => {
  let total = 0;
  for (let round = 0; round < maxRounds; round++) {
    const result = await pullSyncEvents();
    const count = Number(result?.count || 0);
    total += count;
    if (!result?.success) {
      return {
        success: false,
        count: total,
        drained: false,
        error: 'error' in result ? result.error : undefined,
      };
    }
    if (('skipped' in result && result.skipped) || !('has_more' in result && result.has_more)) {
      await repairWindowRelationsFromCloudIds();
      return {success: true, count: total, drained: true};
    }
  }
  logger.warn('Cloud sync pull reached its V1 drain safety limit', {
    maxRounds,
    total,
  });
  return {success: true, count: total, drained: false};
};

const createV2BootstrapBackup = async (workspaceId: string) => {
  const entities: Record<string, unknown[]> = {};
  for (const tableName of ['group', 'proxy', 'tag', 'window']) {
    entities[tableName] = await db(tableName)
      .where(builder => builder.whereNull('workspace_id').orWhere('workspace_id', workspaceId))
      .select('*');
  }
  const [syncState, outbox, legacyOutbox] = await Promise.all([
    db('sync_state').where({workspace_id: workspaceId}).select('*'),
    db('sync_outbox_v2').where({workspace_id: workspaceId}).select('*'),
    db('sync_outbox')
      .where(builder => builder.whereNull('workspace_id').orWhere('workspace_id', workspaceId))
      .select('*'),
  ]);
  await db('sync_bootstrap_backup_v2').insert({
    workspace_id: workspaceId,
    payload: JSON.stringify({entities, syncState, outbox, legacyOutbox}),
  });
};

const upsertSyncCursor = async (workspaceId: string, cursor: number, database: QueryDb = db) => {
  const existing = await database('sync_state')
    .where({workspace_id: workspaceId, entity_type: SYNC_STATE_ENTITY})
    .first();

  if (existing) {
    await database('sync_state')
      .where({id: existing.id})
      .update({
        cursor: String(cursor),
        last_pulled_at: database.fn.now(),
        updated_at: database.fn.now(),
      });
    return;
  }

  await database('sync_state').insert({
    workspace_id: workspaceId,
    entity_type: SYNC_STATE_ENTITY,
    cursor: String(cursor),
    last_pulled_at: database.fn.now(),
    updated_at: database.fn.now(),
  });
};

const applySyncEvent = async (event: CloudSyncEvent, database: QueryDb = db) => {
  // Older Browser versions may have written these entities. A new client
  // advances past them without importing device-specific extension settings.
  if (isDeviceLocalSyncEntity(event.entity_type)) return;

  const payload: Record<string, unknown> = withEventWorkspace(
    {
      ...(parsePayload(event.payload) as Record<string, unknown>),
      ...(event.revision !== undefined ? {sync_version: event.revision} : {}),
      ...(event.deleted_at !== undefined ? {sync_deleted_at: event.deleted_at} : {}),
    },
    event.workspace_id,
  );
  const cloudId = String(event.cloud_id || payload?.cloud_id || '');
  if (!cloudId) {
    return;
  }

  const operation = event.operation === 'patch' ? 'update' : event.operation;
  const eventWorkspaceId = toNullableString(event.workspace_id);
  switch (event.entity_type) {
    case 'group':
      await applyEntityUpsertOrDelete(
        'group',
        cloudId,
        operation,
        {
          ...payload,
        },
        [
          'name',
          'workspace_id',
          'sync_version',
          'sync_deleted_at',
          'last_synced_at',
          'updated_by_device_id',
        ],
        database,
      );
      await repairWindowGroupReferences(cloudId, database, eventWorkspaceId);
      return;
    case 'proxy':
      await applyEntityUpsertOrDelete(
        'proxy',
        cloudId,
        operation,
        payload,
        [
          'ip',
          'proxy',
          'proxy_type',
          'ip_checker',
          'ip_country',
          'remark',
          'check_result',
          'workspace_id',
          'sync_version',
          'sync_deleted_at',
          'last_synced_at',
          'updated_by_device_id',
        ],
        database,
      );
      await repairWindowProxyReferences(cloudId, database, eventWorkspaceId);
      return;
    case 'tag':
      await applyEntityUpsertOrDelete(
        'tag',
        cloudId,
        operation,
        payload,
        [
          'name',
          'color',
          'workspace_id',
          'sync_version',
          'sync_deleted_at',
          'last_synced_at',
          'updated_by_device_id',
        ],
        database,
      );
      await repairWindowTagReferences(cloudId, database, eventWorkspaceId);
      return;
    case 'window':
      await applyWindowSyncEvent(cloudId, operation, payload, database);
      return;
    default:
      return;
  }
};

const applyWindowSyncEvent = async (
  cloudId: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  database: QueryDb = db,
) => {
  if (operation === 'delete') {
    const assignments = database('window_extension').where({window_cloud_id: cloudId});
    const workspaceId = toNullableString(payload.workspace_id);
    if (workspaceId) assignments.where({workspace_id: workspaceId});
    else assignments.whereNull('workspace_id');
    await assignments.delete();
    await applyEntityUpsertOrDelete('window', cloudId, operation, payload, [], database);
    return;
  }

  const groupCloudId = toNullableString(payload.group_cloud_id);
  const proxyCloudId = toNullableString(payload.proxy_cloud_id);
  const workspaceId = toNullableString(payload.workspace_id);
  const groupId = groupCloudId
    ? await findLocalIdByCloudId('group', groupCloudId, database, workspaceId)
    : null;
  const proxyId = proxyCloudId
    ? await findLocalIdByCloudId('proxy', proxyCloudId, database, workspaceId)
    : null;

  const normalizedPayload = {
    ...payload,
    // A V2 patch can explicitly clear a reference. Keep the local numeric
    // reference in lockstep with its cloud ID, including the null case.
    ...synchronizedReference(payload, 'group_cloud_id', 'group_id', groupCloudId, groupId),
    ...synchronizedReference(payload, 'proxy_cloud_id', 'proxy_id', proxyCloudId, proxyId),
    ...(payload.tag_cloud_ids !== undefined
      ? {tags: await resolveLocalTagIds(payload.tag_cloud_ids, database, workspaceId)}
      : {}),
  };

  await applyEntityUpsertOrDelete(
    'window',
    cloudId,
    operation,
    normalizedPayload,
    [
      'profile_id',
      'name',
      'group_cloud_id',
      'group_id',
      'proxy_cloud_id',
      'proxy_id',
      'tag_cloud_ids',
      'tags',
      'remark',
      'cookie',
      'ua',
      'browser_engine',
      'workspace_id',
      'sync_version',
      'sync_deleted_at',
      'last_synced_at',
      'updated_by_device_id',
    ],
    database,
  );
};

const applyEntityUpsertOrDelete = async (
  tableName: string,
  cloudId: string,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  allowedFields: string[],
  database: QueryDb = db,
) => {
  const workspaceId = toNullableString(payload.workspace_id);
  const scopedEntity = () => {
    const query = database(tableName).where({cloud_id: cloudId});
    if (workspaceId) query.where({workspace_id: workspaceId});
    else query.whereNull('workspace_id');
    return query;
  };
  if (operation === 'delete') {
    if (tableName === 'extension') {
      const assignments = database('window_extension').where({extension_cloud_id: cloudId});
      if (workspaceId) assignments.where({workspace_id: workspaceId});
      else assignments.whereNull('workspace_id');
      await assignments.delete();
    }
    const existing = await scopedEntity().first();
    if (existing) {
      const tombstone: Record<string, unknown> = {
        sync_deleted_at: payload.sync_deleted_at || new Date().toISOString(),
        sync_dirty: false,
        sync_version: Number(payload.sync_version || 0),
        last_synced_at: database.fn.now(),
      };
      if (tableName === 'window') {
        tombstone.status = 0;
      }
      await database(tableName).where({id: existing.id}).update(tombstone);
    }
    return;
  }

  const sanitized = sanitizePayload(payload, allowedFields);
  const updateData = {
    ...sanitized,
    cloud_id: cloudId,
    sync_dirty: false,
  };

  const existing = await scopedEntity().first();
  if (existing) {
    const incomingRevision = Number(payload.sync_version || 0);
    if (!shouldApplyIncomingRevision(existing.sync_version, incomingRevision)) {
      return;
    }
    if (existing.sync_dirty) {
      await recordSyncConflict(
        tableName,
        existing.id,
        cloudId,
        existing,
        payload,
        'remote_update_while_local_dirty',
        database,
      );
      return;
    }
    await database(tableName).where({id: existing.id}).update(updateData);
    return;
  }

  await database(tableName).insert(updateData);
};

const recordSyncConflict = async (
  entityType: string,
  localId: number | undefined,
  cloudId: string,
  localPayload: unknown,
  remotePayload: unknown,
  status: string,
  database: QueryDb = db,
) => {
  const config = await cloudApiClient.getConfig();
  await database('sync_conflict').insert({
    workspace_id: config.workspaceId || null,
    entity_type: entityType,
    local_id: localId || null,
    cloud_id: cloudId,
    local_payload: JSON.stringify(localPayload),
    remote_payload: JSON.stringify(remotePayload),
    status,
    created_at: database.fn.now(),
  });
};

const sanitizePayload = (payload: Record<string, unknown>, allowedFields: string[]) => {
  const sanitized: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (payload[key] !== undefined) {
      sanitized[key] = payload[key];
    }
  }
  return sanitized;
};

const findLocalIdByCloudId = async (
  tableName: string,
  cloudId: string,
  database: QueryDb = db,
  workspaceId?: string | null,
) => {
  const query = database(tableName).select('id').where({cloud_id: cloudId});
  if (workspaceId) query.where({workspace_id: workspaceId});
  else query.whereNull('workspace_id');
  const row = await query.first();
  return row?.id ?? null;
};

const repairWindowProxyReferences = async (
  proxyCloudId: string,
  database: QueryDb = db,
  workspaceId?: string | null,
) => {
  const proxyId = await findLocalIdByCloudId('proxy', proxyCloudId, database, workspaceId);
  if (!proxyId) {
    return;
  }

  const hasProxyCloudIdColumn = await database.schema.hasColumn('window', 'proxy_cloud_id');
  if (!hasProxyCloudIdColumn) {
    return;
  }

  const query = database('window').where({proxy_cloud_id: proxyCloudId});
  if (workspaceId) query.where({workspace_id: workspaceId});
  else query.whereNull('workspace_id');
  await query
    .where(builder => {
      builder.whereNull('proxy_id').orWhere('proxy_id', 0);
    })
    .update({
      proxy_id: proxyId,
      updated_at: database.fn.now(),
    });
};

const repairWindowGroupReferences = async (
  groupCloudId: string,
  database: QueryDb = db,
  workspaceId?: string | null,
) => {
  const groupId = await findLocalIdByCloudId('group', groupCloudId, database, workspaceId);
  if (!groupId) {
    return;
  }

  const hasGroupCloudIdColumn = await database.schema.hasColumn('window', 'group_cloud_id');
  if (!hasGroupCloudIdColumn) {
    return;
  }

  const query = database('window').where({group_cloud_id: groupCloudId});
  if (workspaceId) query.where({workspace_id: workspaceId});
  else query.whereNull('workspace_id');
  await query
    .where(builder => {
      builder.whereNull('group_id').orWhere('group_id', 0);
    })
    .update({
      group_id: groupId,
      updated_at: database.fn.now(),
    });
};

const repairWindowRelationsFromCloudIds = async () => {
  const hasWindowTable = await db.schema.hasTable('window');
  if (!hasWindowTable) {
    return;
  }

  const hasGroupCloudIdColumn = await db.schema.hasColumn('window', 'group_cloud_id');
  const hasProxyCloudIdColumn = await db.schema.hasColumn('window', 'proxy_cloud_id');
  if (!hasGroupCloudIdColumn && !hasProxyCloudIdColumn) {
    return;
  }

  const windows = await db('window')
    .select('id', 'workspace_id', 'group_id', 'group_cloud_id', 'proxy_id', 'proxy_cloud_id')
    .where('status', '>', 0);

  let updatedWindows = 0;
  let repairedGroupIdCount = 0;
  let repairedProxyIdCount = 0;
  let repairedGroupCloudIdCount = 0;
  let repairedProxyCloudIdCount = 0;

  for (const row of windows) {
    const updates: Record<string, unknown> = {};

    if (
      hasGroupCloudIdColumn &&
      row.group_id &&
      (!row.group_cloud_id || String(row.group_cloud_id).trim() === '')
    ) {
      const groupQuery = db('group').select('cloud_id').where({id: row.group_id});
      if (row.workspace_id) groupQuery.where({workspace_id: row.workspace_id});
      else groupQuery.whereNull('workspace_id');
      const group = await groupQuery.first();
      if (group?.cloud_id) {
        updates.group_cloud_id = group.cloud_id;
        repairedGroupCloudIdCount++;
      }
    }

    if (hasGroupCloudIdColumn && row.group_cloud_id && (!row.group_id || row.group_id === 0)) {
      const groupId = await findLocalIdByCloudId(
        'group',
        String(row.group_cloud_id),
        db,
        row.workspace_id,
      );
      if (groupId) {
        updates.group_id = groupId;
        repairedGroupIdCount++;
      }
    }

    if (
      hasProxyCloudIdColumn &&
      row.proxy_id &&
      (!row.proxy_cloud_id || String(row.proxy_cloud_id).trim() === '')
    ) {
      const proxyQuery = db('proxy').select('cloud_id').where({id: row.proxy_id});
      if (row.workspace_id) proxyQuery.where({workspace_id: row.workspace_id});
      else proxyQuery.whereNull('workspace_id');
      const proxy = await proxyQuery.first();
      if (proxy?.cloud_id) {
        updates.proxy_cloud_id = proxy.cloud_id;
        repairedProxyCloudIdCount++;
      }
    }

    if (hasProxyCloudIdColumn && row.proxy_cloud_id && (!row.proxy_id || row.proxy_id === 0)) {
      const proxyId = await findLocalIdByCloudId(
        'proxy',
        String(row.proxy_cloud_id),
        db,
        row.workspace_id,
      );
      if (proxyId) {
        updates.proxy_id = proxyId;
        repairedProxyIdCount++;
      }
    }

    if (Object.keys(updates).length > 0) {
      const windowQuery = db('window').where({id: row.id});
      if (row.workspace_id) windowQuery.where({workspace_id: row.workspace_id});
      else windowQuery.whereNull('workspace_id');
      await windowQuery.update({...updates, updated_at: db.fn.now()});
      updatedWindows++;
    }
  }

  logger.info('Window relation repair completed', {
    scanned: windows.length,
    updatedWindows,
    repairedGroupIdCount,
    repairedProxyIdCount,
    repairedGroupCloudIdCount,
    repairedProxyCloudIdCount,
  });
};

const parseCloudIdList = (value: unknown) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
};

const resolveLocalTagIds = async (
  value: unknown,
  database: QueryDb = db,
  workspaceId?: string | null,
) => {
  const cloudIds = parseCloudIdList(value);
  if (!cloudIds.length) return null;
  const tagsQuery = database('tag')
    .select('id', 'cloud_id')
    .whereIn('cloud_id', cloudIds)
    .whereNull('sync_deleted_at');
  if (workspaceId) tagsQuery.where({workspace_id: workspaceId});
  else tagsQuery.whereNull('workspace_id');
  const tags = await tagsQuery;
  const byCloudId = new Map(tags.map(tag => [String(tag.cloud_id), Number(tag.id)]));
  const localIds = cloudIds
    .map(cloudId => byCloudId.get(cloudId))
    .filter((id): id is number => Boolean(id));
  return localIds.length ? localIds.join(',') : null;
};

const repairWindowTagReferences = async (
  tagCloudId: string,
  database: QueryDb = db,
  workspaceId?: string | null,
) => {
  const windowsQuery = database('window')
    .select('id', 'tag_cloud_ids')
    .whereNotNull('tag_cloud_ids');
  if (workspaceId) windowsQuery.where({workspace_id: workspaceId});
  else windowsQuery.whereNull('workspace_id');
  const windows = await windowsQuery;
  for (const windowData of windows) {
    if (!parseCloudIdList(windowData.tag_cloud_ids).includes(tagCloudId)) continue;
    const windowQuery = database('window').where({id: windowData.id});
    if (workspaceId) windowQuery.where({workspace_id: workspaceId});
    else windowQuery.whereNull('workspace_id');
    await windowQuery.update({
      tags: await resolveLocalTagIds(windowData.tag_cloud_ids, database, workspaceId),
    });
  }
};

const backfillLegacyCloudSyncData = async () => {
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || !config.workspaceId) {
    return;
  }

  let groupsPatched = 0;
  let proxiesPatched = 0;
  let windowsPatched = 0;

  const groups = await db('group').select('*');
  for (const group of groups) {
    const nextCloudId = group.cloud_id || randomUUID();
    const nextWorkspaceId = group.workspace_id || config.workspaceId;
    const shouldPatch = !group.cloud_id || !group.workspace_id;
    if (!shouldPatch) continue;

    await updateWithTimestampIfSupported(
      'group',
      {id: group.id},
      {
        cloud_id: nextCloudId,
        workspace_id: nextWorkspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      },
    );

    const latestGroup = await db('group').where({id: group.id}).first();
    await enqueueSyncOutbox('group', group.cloud_id ? 'update' : 'create', {
      localId: group.id,
      cloudId: nextCloudId,
      data: latestGroup,
    });
    groupsPatched++;
  }

  const proxies = await db('proxy').select('*');
  for (const proxy of proxies) {
    const nextCloudId = proxy.cloud_id || randomUUID();
    const nextWorkspaceId = proxy.workspace_id || config.workspaceId;
    const shouldPatch = !proxy.cloud_id || !proxy.workspace_id;
    if (!shouldPatch) continue;

    await updateWithTimestampIfSupported(
      'proxy',
      {id: proxy.id},
      {
        cloud_id: nextCloudId,
        workspace_id: nextWorkspaceId,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      },
    );

    const latestProxy = await db('proxy').where({id: proxy.id}).first();
    await enqueueSyncOutbox('proxy', proxy.cloud_id ? 'update' : 'create', {
      localId: proxy.id,
      cloudId: nextCloudId,
      data: latestProxy,
    });
    proxiesPatched++;
  }

  const groupCloudById = new Map<number, string>();
  for (const group of await db('group').select('id', 'cloud_id')) {
    if (group?.id && group?.cloud_id) {
      groupCloudById.set(Number(group.id), String(group.cloud_id));
    }
  }
  const proxyCloudById = new Map<number, string>();
  for (const proxy of await db('proxy').select('id', 'cloud_id')) {
    if (proxy?.id && proxy?.cloud_id) {
      proxyCloudById.set(Number(proxy.id), String(proxy.cloud_id));
    }
  }

  const windows = await db('window').where('status', '>', 0).select('*');
  for (const windowData of windows) {
    const nextCloudId = windowData.cloud_id || randomUUID();
    const nextWorkspaceId = windowData.workspace_id || config.workspaceId;
    const nextGroupCloudId =
      windowData.group_cloud_id ||
      (windowData.group_id ? groupCloudById.get(Number(windowData.group_id)) : null);
    const nextProxyCloudId =
      windowData.proxy_cloud_id ||
      (windowData.proxy_id ? proxyCloudById.get(Number(windowData.proxy_id)) : null);

    const shouldPatch =
      !windowData.cloud_id ||
      !windowData.workspace_id ||
      (windowData.group_id && !windowData.group_cloud_id && Boolean(nextGroupCloudId)) ||
      (windowData.proxy_id && !windowData.proxy_cloud_id && Boolean(nextProxyCloudId));
    if (!shouldPatch) continue;

    await updateWithTimestampIfSupported(
      'window',
      {id: windowData.id},
      {
        cloud_id: nextCloudId,
        workspace_id: nextWorkspaceId,
        group_cloud_id: nextGroupCloudId || null,
        proxy_cloud_id: nextProxyCloudId || null,
        sync_dirty: true,
        updated_by_device_id: config.deviceId,
      },
    );

    const latestWindow = await db('window').where({id: windowData.id}).first();
    await enqueueSyncOutbox('window', windowData.cloud_id ? 'update' : 'create', {
      localId: windowData.id,
      cloudId: nextCloudId,
      data: latestWindow,
    });
    windowsPatched++;
  }

  if (groupsPatched || proxiesPatched || windowsPatched) {
    logger.info('Legacy cloud sync backfill completed', {
      workspaceId: config.workspaceId,
      groupsPatched,
      proxiesPatched,
      windowsPatched,
    });
  }
};

const normalizeGroupNameKey = (name: unknown) =>
  String(name || '')
    .trim()
    .toLowerCase();

const mergeDuplicateGroupsByName = async () => {
  const hasGroupTable = await db.schema.hasTable('group');
  const hasWindowTable = await db.schema.hasTable('window');
  if (!hasGroupTable || !hasWindowTable) {
    return;
  }

  const groups = await db('group')
    .select('id', 'name', 'workspace_id', 'cloud_id', 'created_at')
    .orderBy('id', 'asc');

  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const group of groups) {
    const key = `${String(group.workspace_id || '')}::${normalizeGroupNameKey(group.name)}`;
    if (!normalizeGroupNameKey(group.name)) continue;
    const list = buckets.get(key) || [];
    list.push(group as Record<string, unknown>);
    buckets.set(key, list);
  }

  let mergedGroups = 0;
  let reassignedWindows = 0;

  for (const list of buckets.values()) {
    if (list.length <= 1) continue;

    const canonical = list.find(item => item.cloud_id) || list[0];

    const canonicalId = Number(canonical.id);
    const duplicateIds = list.map(item => Number(item.id)).filter(id => id !== canonicalId);

    if (!duplicateIds.length) continue;

    const affected = await db('window').whereIn('group_id', duplicateIds).update({
      group_id: canonicalId,
      updated_at: db.fn.now(),
    });
    reassignedWindows += Number(affected || 0);

    // Keep the canonical group and remove duplicates.
    await db('group').whereIn('id', duplicateIds).delete();
    mergedGroups += duplicateIds.length;
  }

  if (mergedGroups > 0) {
    logger.info('Merged duplicate groups by name', {
      mergedGroups,
      reassignedWindows,
    });
  }
};

const toNullableString = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
};
