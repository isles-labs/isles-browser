import {db} from '.';
import type {DB} from '../../../shared/types/db';
import {applyWorkspaceScope} from './workspace-scope';

const SQLITE_WHERE_IN_BATCH_SIZE = 500;

const chunkArray = <T>(items: T[], size: number): T[][] => {
  if (!items.length) {
    return [];
  }

  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const normalizeExtension = (extension: DB.Extension): DB.Extension => {
  return {
    ...extension,
    source_type: extension.source_type ?? 'custom',
    distribution_mode: extension.distribution_mode ?? 'manual',
    auto_update:
      typeof extension.auto_update === 'boolean'
        ? extension.auto_update
        : extension.auto_update !== 0,
  };
};

const getAllExtensions = async (workspaceId?: string) => {
  const query = db('extension').select('*');
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  const rows = await query.orderBy('created_at', 'desc');
  return rows.map(row => normalizeExtension(row as DB.Extension));
};

const getExtensionById = async (id: number) => {
  const row = await db('extension').where({id}).first();
  return row ? normalizeExtension(row as DB.Extension) : undefined;
};

const getExtensionByIdInScope = async (id: number, workspaceId?: string) => {
  const query = db('extension').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  const row = await query.first();
  return row ? normalizeExtension(row as DB.Extension) : undefined;
};

const getExtensionByChromeId = async (chromeExtensionId: string, workspaceId?: string) => {
  const query = db('extension').where({chrome_extension_id: chromeExtensionId});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  const row = await query.first();
  return row ? normalizeExtension(row as DB.Extension) : undefined;
};

const getExtensionsByChromeId = async (chromeExtensionId: string, workspaceId?: string) => {
  const query = db('extension').where({chrome_extension_id: chromeExtensionId});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  const rows = await query.orderBy('updated_at', 'desc');
  return rows.map(row => normalizeExtension(row as DB.Extension));
};

const createExtension = async (extension: DB.Extension) => {
  return await db('extension').insert(extension);
};

const updateExtension = async (
  id: number,
  extension: Partial<DB.Extension>,
  workspaceId?: string,
) => {
  const extensionData = await getExtensionByIdInScope(id, workspaceId);
  if (!extensionData) {
    throw new Error('Extension not found');
  }

  const query = db('extension').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.update({
    ...extensionData,
    ...extension,
  });
};

const insertExtensionWindows = async (id: number, windows: number[], workspaceId?: string) => {
  if (!windows.length) {
    return [];
  }

  const extensionQuery = db('extension').where({id});
  applyWorkspaceScope(extensionQuery, 'workspace_id', workspaceId);
  if (!(await extensionQuery.first())) return [];

  const validWindowQuery = db('window').whereIn('id', windows).select('id');
  applyWorkspaceScope(validWindowQuery, 'workspace_id', workspaceId);
  const validWindowIds = new Set((await validWindowQuery).map(row => Number(row.id)));
  windows = windows.filter(windowId => validWindowIds.has(Number(windowId)));
  if (!windows.length) return [];

  const existingRows: Array<{window_id: number}> = [];
  const windowIdBatches = chunkArray(windows, SQLITE_WHERE_IN_BATCH_SIZE);

  for (const batch of windowIdBatches) {
    const rowsQuery = db('window_extension')
      .where({extension_id: id})
      .whereIn('window_id', batch)
      .select('window_id');
    applyWorkspaceScope(rowsQuery, 'workspace_id', workspaceId);
    const rows = await rowsQuery;
    existingRows.push(...(rows as Array<{window_id: number}>));
  }

  const existingIds = new Set(existingRows.map(row => row.window_id));
  const payload = windows
    .filter(windowId => !existingIds.has(windowId))
    .map(windowId => ({
      extension_id: id,
      window_id: windowId,
      workspace_id: workspaceId || null,
      enabled: true,
    }));

  if (!payload.length) {
    return [];
  }

  const payloadBatches = chunkArray(payload, SQLITE_WHERE_IN_BATCH_SIZE);
  const insertedResults: unknown[] = [];
  for (const batch of payloadBatches) {
    const result = await db('window_extension').insert(batch);
    insertedResults.push(result);
  }

  return insertedResults;
};

const getExtensionsByWindowId = async (windowId: number, workspaceId?: string) => {
  const windowQuery = db('window').select('workspace_id').where({id: windowId});
  applyWorkspaceScope(windowQuery, 'workspace_id', workspaceId);
  const window = await windowQuery.first();
  const effectiveWorkspaceId = (workspaceId ?? window?.workspace_id) || undefined;
  const extensionIdsQuery = db('window_extension')
    .where({window_id: windowId})
    .where('enabled', '!=', false)
    .select('extension_id');
  applyWorkspaceScope(extensionIdsQuery, 'workspace_id', effectiveWorkspaceId);
  const extensionIds = await extensionIdsQuery;
  const ids = extensionIds.map(e => e.extension_id);

  const query = db('extension').select('*');
  applyWorkspaceScope(query, 'workspace_id', effectiveWorkspaceId);
  query.where(builder => {
    builder.where({distribution_mode: 'global'});
    if (ids.length > 0) builder.orWhereIn('id', ids);
  });

  const rows = await query.orderBy('created_at', 'desc');
  return rows.map(row => normalizeExtension(row as DB.Extension));
};

const deleteExtensionWindows = async (id: number, windowIds: number[], workspaceId?: string) => {
  if (!windowIds.length) {
    return 0;
  }

  let deletedCount = 0;
  const windowIdBatches = chunkArray(windowIds, SQLITE_WHERE_IN_BATCH_SIZE);

  for (const batch of windowIdBatches) {
    const deletedQuery = db('window_extension')
      .where({extension_id: id})
      .whereIn('window_id', batch);
    applyWorkspaceScope(deletedQuery, 'workspace_id', workspaceId);
    const deleted = await deletedQuery.update({enabled: false});
    deletedCount += Number(deleted) || 0;
  }

  return deletedCount;
};

const deleteWindowReleted = async (windowIds: number | number[], workspaceId?: string) => {
  const targetIds = Array.isArray(windowIds) ? windowIds : [windowIds];
  if (!targetIds.length) {
    return 0;
  }

  let deletedCount = 0;
  const windowIdBatches = chunkArray(targetIds, SQLITE_WHERE_IN_BATCH_SIZE);
  for (const batch of windowIdBatches) {
    const query = db('window_extension').whereIn('window_id', batch);
    applyWorkspaceScope(query, 'workspace_id', workspaceId);
    const deleted = await query.delete();
    deletedCount += Number(deleted) || 0;
  }

  return deletedCount;
};

const getExtensionWindows = async (id: number, workspaceId?: string) => {
  const query = db('window_extension').where({extension_id: id}).orderBy('created_at', 'asc');
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query;
};

const enableExtensionWindows = async (id: number, windowIds: number[], workspaceId?: string) => {
  if (!windowIds.length) return 0;
  let updatedCount = 0;
  for (const batch of chunkArray(windowIds, SQLITE_WHERE_IN_BATCH_SIZE)) {
    const query = db('window_extension').where({extension_id: id}).whereIn('window_id', batch);
    applyWorkspaceScope(query, 'workspace_id', workspaceId);
    const updated = await query.update({enabled: true});
    updatedCount += Number(updated) || 0;
  }
  return updatedCount;
};

const deleteExtension = async (id: number, workspaceId?: string) => {
  const assignments = db('window_extension').where({extension_id: id});
  applyWorkspaceScope(assignments, 'workspace_id', workspaceId);
  await assignments.delete();
  const extension = db('extension').where({id});
  applyWorkspaceScope(extension, 'workspace_id', workspaceId);
  return await extension.delete();
};

export const ExtensionDB = {
  getAllExtensions,
  getExtensionById,
  getExtensionByIdInScope,
  getExtensionByChromeId,
  getExtensionsByChromeId,
  createExtension,
  updateExtension,
  deleteExtension,
  deleteWindowReleted,
  insertExtensionWindows,
  deleteExtensionWindows,
  enableExtensionWindows,
  getExtensionWindows,
  getExtensionsByWindowId,
};
