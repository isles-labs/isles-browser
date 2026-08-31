import {db} from '.';
import type {DB, SafeAny} from '../../../shared/types/db';
import {applyWorkspaceScope} from './workspace-scope';

const all = async (workspaceId?: string) => {
  return await db('proxy')
    .leftJoin('window', function () {
      this.on('window.proxy_id', '=', 'proxy.id').andOn('window.status', '>', 0 as SafeAny); // 增加的筛选条件
    })
    .select('proxy.*')
    .count('window.id as usageCount')
    .modify(query => applyWorkspaceScope(query, 'proxy.workspace_id', workspaceId))
    .whereNull('proxy.sync_deleted_at')
    .groupBy('proxy.id')
    .orderBy('proxy.created_at', 'desc');
};

const getById = async (id: number) => {
  return await db('proxy').where({id}).first();
};

const getByIdInScope = async (id: number, workspaceId?: string) => {
  const query = db('proxy').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.first();
};

const getByProxy = async (proxy_type?: string, proxy?: string, workspaceId?: string) => {
  const normalizedType = proxy_type?.trim().toLowerCase();
  const normalizedProxy = proxy?.trim();
  if (!normalizedType || !normalizedProxy) return undefined;

  return await db('proxy')
    .whereRaw('lower(proxy_type) = ?', [normalizedType])
    .where({proxy: normalizedProxy})
    .whereNull('sync_deleted_at')
    .modify(query => applyWorkspaceScope(query, 'workspace_id', workspaceId))
    .first();
};

const update = async (id: number, updatedData: DB.Proxy, workspaceId?: string) => {
  const query = db('proxy').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.update(updatedData);
};

const create = async (proxyData: DB.Proxy) => {
  return await db('proxy').insert(proxyData);
};

const importProxies = async (proxies: DB.Proxy[]) => {
  return await db('proxy').insert(proxies);
};

const remove = async (id: number, workspaceId?: string) => {
  const query = db('proxy').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.update({sync_deleted_at: db.fn.now()});
};

const deleteAll = async () => {
  return await db('proxy').delete();
};

const batchDelete = async (ids: number[], workspaceId?: string) => {
  if (ids.length === 0) {
    return {success: true, detachedWindowIds: [] as number[]};
  }

  try {
    const detachedWindowIds = await db.transaction(async trx => {
      // A proxy may be in use by both active and disabled profiles. Clear every
      // reference so deletion never leaves a window pointing to a missing proxy.
      const windowsQuery = trx('window').select('id').whereIn('proxy_id', ids);
      applyWorkspaceScope(windowsQuery, 'workspace_id', workspaceId);
      const windows = await windowsQuery;
      const windowIds = windows.map(window => window.id as number);

      if (windowIds.length > 0) {
        const windowUpdate = trx('window').whereIn('id', windowIds);
        applyWorkspaceScope(windowUpdate, 'workspace_id', workspaceId);
        await windowUpdate.update({
          proxy_id: null,
          proxy_cloud_id: null,
          updated_at: trx.fn.now(),
        });
      }

      const proxyDelete = trx('proxy').whereIn('id', ids);
      applyWorkspaceScope(proxyDelete, 'workspace_id', workspaceId);
      await proxyDelete.update({sync_deleted_at: trx.fn.now()});
      return windowIds;
    });

    return {success: true, detachedWindowIds};
  } catch (error) {
    return {success: false, message: 'Failed to delete.'};
  }
};

export const ProxyDB = {
  all,
  getById,
  getByIdInScope,
  getByProxy,
  batchDelete,
  importProxies,
  update,
  create,
  remove,
  deleteAll,
};
