import {isDeepStrictEqual} from 'node:util';

export const shouldQuarantineLegacyMutation = (mutationId?: string | null) => !mutationId;

export const selectSendableV2EntityRows = <T extends {entity_type: string; cloud_id: string}>(
  candidates: T[],
  sendingRows: Array<Pick<T, 'entity_type' | 'cloud_id'>>,
) => {
  const key = (row: Pick<T, 'entity_type' | 'cloud_id'>) => `${row.entity_type}:${row.cloud_id}`;
  const sendingKeys = new Set(sendingRows.map(key));
  const seen = new Set<string>();
  return candidates.filter(row => {
    const entityKey = key(row);
    if (sendingKeys.has(entityKey) || seen.has(entityKey)) return false;
    seen.add(entityKey);
    return true;
  });
};

export const isAcceptedDelete = (operation?: string | null) => operation === 'delete';

export const shouldRestoreCachedProfile = ({
  cacheExists,
  localDirty,
  localRevision,
  remoteRevision,
}: {
  cacheExists: boolean;
  localDirty: boolean;
  localRevision: string;
  remoteRevision: string;
}) => !localDirty && (!cacheExists || remoteRevision !== localRevision);

export const buildWindowDeleteTombstone = <T extends Record<string, unknown>>(
  windowData: T,
  deletedAt: string,
) => ({
  ...windowData,
  sync_deleted_at: deletedAt,
});

export const isAuthorityExportableWindow = (windowData: {
  status?: unknown;
  sync_deleted_at?: unknown;
}) => Number(windowData.status) > 0 && !windowData.sync_deleted_at;

const DEVICE_LOCAL_SYNC_ENTITY_TYPES = new Set(['extension', 'window_extension']);

// Extension packages and their window assignments describe capabilities of
// this device. They are scoped in local SQLite but never become team state.
export const isDeviceLocalSyncEntity = (entityType?: unknown) =>
  DEVICE_LOCAL_SYNC_ENTITY_TYPES.has(String(entityType || ''));

export const isValidV2SnapshotEntity = (entityType?: unknown, cloudId?: unknown) =>
  ['group', 'proxy', 'tag', 'window'].includes(String(entityType || '')) &&
  Boolean(String(cloudId || '').trim());

export const changedSyncFields = (
  previousValue: unknown,
  nextValue: unknown,
  fields: readonly string[],
) => {
  const previous =
    previousValue && typeof previousValue === 'object'
      ? (previousValue as Record<string, unknown>)
      : {};
  const next =
    nextValue && typeof nextValue === 'object' ? (nextValue as Record<string, unknown>) : {};
  return Object.fromEntries(
    fields
      .filter(field => next[field] !== undefined)
      .filter(field => !isDeepStrictEqual(previous[field], next[field]))
      .map(field => [field, next[field]]),
  );
};

export const synchronizedReference = (
  payload: Record<string, unknown>,
  cloudField: string,
  localField: string,
  cloudId: string | null,
  localId: number | null,
) => {
  if (!Object.prototype.hasOwnProperty.call(payload, cloudField)) return {};
  return {[cloudField]: cloudId, [localField]: localId};
};

export const shouldApplyIncomingRevision = (localRevision: unknown, incomingRevision: unknown) => {
  const local = Number(localRevision || 0);
  const incoming = Number(incomingRevision || 0);
  // Same-revision events are idempotent canonical repairs. They must not be
  // skipped because local numeric references can be stale after an old client.
  return incoming <= 0 || local <= incoming;
};

export const shouldAcceptRemoteTombstone = (result: {status?: unknown; reason?: unknown}) =>
  String(result.status || '') === 'conflict' &&
  String(result.reason || '') === 'tombstone_conflict';

export const withEventWorkspace = <T extends Record<string, unknown>>(
  payload: T,
  workspaceId?: unknown,
) => {
  const normalizedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  return normalizedWorkspaceId ? {...payload, workspace_id: normalizedWorkspaceId} : payload;
};

export const shouldLoadCloudProfileBeforeOpen = (offlineMode: boolean) => !offlineMode;

// Only a request that received no HTTP response represents an offline draft.
// Rejections such as 409 must remain explicit conflicts instead.
export const shouldPreserveOfflineProfileDraft = (httpStatus?: number) => httpStatus === undefined;
