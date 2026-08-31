import {db} from '.';
import type {DB} from '../../../shared/types/db';
import {applyWorkspaceScope} from './workspace-scope';

const all = async (workspaceId?: string) => {
  const query = db('tag').select('*');
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.whereNull('sync_deleted_at');
};

const getById = async (id: number) => {
  return await db('tag').where({id}).first();
};
const getByIdInScope = async (id: number, workspaceId?: string) => {
  const query = db('tag').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.first();
};
const getByName = async (name: string, workspaceId?: string) => {
  const query = db('tag').where({name}).whereNull('sync_deleted_at');
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.first();
};

const update = async (id: number, updatedData: DB.Tag, workspaceId?: string) => {
  const query = db('tag').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.update(updatedData);
};

const create = async (tagData: DB.Tag) => {
  return await db('tag').insert(tagData);
};

const remove = async (id: number, workspaceId?: string) => {
  const query = db('tag').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.update({sync_deleted_at: db.fn.now()});
};

const deleteAll = async () => {
  return await db('tag').delete();
};

export const TagDB = {
  all,
  getById,
  getByIdInScope,
  getByName,
  update,
  create,
  remove,
  deleteAll,
};
