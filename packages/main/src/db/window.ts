import {db} from '.';
import type {DB} from '../../../shared/types/db';
import type {IWindowTemplate} from '../types/window-template';
import {GroupDB} from './group';
import {ProxyDB} from './proxy';
import {TagDB} from './tag';
import {randomUniqueProfileId} from '../../../shared/utils/random';
import {applyWorkspaceScope} from './workspace-scope';
import {randomUUID} from 'crypto';

const DEFAULT_BROWSER_ENGINE = 'chrome';

export type WindowImportConflict = {
  row: number;
  windowName: string;
  importedId?: string;
  reason: string;
  content: Record<string, string>;
};

const all = async (workspaceId?: string): Promise<DB.Window[]> => {
  return await db('window')
    .select(
      'window.id',
      'window.cloud_id',
      'window.group_id',
      'window.group_cloud_id',
      'window.proxy_id',
      'window.proxy_cloud_id',
      'window.tags',
      'window.name',
      'window.remark',
      'window.port',
      'window.created_at',
      'window.updated_at',
      'window.profile_id',
      'window.opened_at',
      'window.ua',
      'window.browser_engine',
      'window.status',
      'group.name as group_name',
      'proxy.ip',
      'proxy.proxy',
      'proxy.proxy_type',
      'proxy.ip_country',
      'proxy.ip_checker',
    )
    .leftJoin('group', 'window.group_id', '=', 'group.id')
    .leftJoin('proxy', 'window.proxy_id', '=', 'proxy.id')
    .where('window.status', '>', 0)
    .modify(query => applyWorkspaceScope(query, 'window.workspace_id', workspaceId))
    .orderBy('window.created_at', 'desc');
};

const getOpenedWindows = async (workspaceId?: string): Promise<DB.Window[]> => {
  return await db('window')
    .select(
      'window.id',
      'window.cloud_id',
      'window.group_id',
      'window.group_cloud_id',
      'window.proxy_id',
      'window.proxy_cloud_id',
      'window.tags',
      'window.name',
      'window.remark',
      'window.port',
      'window.pid',
      'window.created_at',
      'window.updated_at',
      'window.profile_id',
      'window.opened_at',
      'window.ua',
      'window.status',
      'window.browser_engine',
      'group.name as group_name',
      'proxy.ip',
      'proxy.proxy',
      'proxy.proxy_type',
      'proxy.ip_country',
      'proxy.ip_checker',
    )
    .leftJoin('group', 'window.group_id', '=', 'group.id')
    .leftJoin('proxy', 'window.proxy_id', '=', 'proxy.id')
    .where('window.status', '>', 1)
    .modify(query => applyWorkspaceScope(query, 'window.workspace_id', workspaceId))
    .orderBy('window.created_at', 'desc');
};

const find = async (params: DB.Window, workspaceId?: string) => {
  const query = db('window').where(params);
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query;
};

const findByProxyIds = async (proxyIds: number[], workspaceId?: string) => {
  if (!proxyIds.length) return [] as DB.Window[];
  const query = db('window').whereIn('proxy_id', proxyIds);
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query;
};

const getById = async (id: number) => {
  // 获取 window 记录及其关联数据
  const windowData = await db('window')
    .select(
      'window.*',
      'group.name as group_name',
      'proxy.ip',
      'proxy.proxy',
      'proxy.proxy_type',
      'proxy.ip_country',
      'proxy.ip_checker',
    )
    .where('window.id', '=', id)
    .leftJoin('group', 'window.group_id', '=', 'group.id')
    .leftJoin('proxy', 'window.proxy_id', '=', 'proxy.id')
    .first();

  if (windowData.tags) {
    // 分割 tags 字符串
    const tagIds = windowData.tags.toString().split(',').map(Number);

    // 获取所有相关的标签名称
    const tags = await db('tag').select('name').whereIn('id', tagIds);

    // 将标签名称添加到返回结果中
    windowData.tags_name = tags.map(tag => tag.name);
  }

  return windowData;
};

const getByIdInScope = async (id: number, workspaceId?: string) => {
  const query = db('window')
    .select(
      'window.*',
      'group.name as group_name',
      'proxy.ip',
      'proxy.proxy',
      'proxy.proxy_type',
      'proxy.ip_country',
      'proxy.ip_checker',
    )
    .where('window.id', '=', id)
    .leftJoin('group', 'window.group_id', '=', 'group.id')
    .leftJoin('proxy', 'window.proxy_id', '=', 'proxy.id');
  applyWorkspaceScope(query, 'window.workspace_id', workspaceId);
  return await query.first();
};

const getByIds = async (ids: number[], workspaceId?: string) => {
  if (!ids.length) return [] as DB.Window[];
  const query = db('window').whereIn('id', ids).select('*');
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query;
};

const getByPid = async (pid: number) => {
  // 获取 window 记录及其关联数据 by PID
  const windowData = await db('window')
    .select(
      'window.*',
      'group.name as group_name',
      'proxy.ip',
      'proxy.proxy',
      'proxy.proxy_type',
      'proxy.ip_country',
      'proxy.ip_checker',
    )
    .where('window.pid', '=', pid)
    .leftJoin('group', 'window.group_id', '=', 'group.id')
    .leftJoin('proxy', 'window.proxy_id', '=', 'proxy.id')
    .first();

  if (windowData && windowData.tags) {
    // 分割 tags 字符串
    const tagIds = windowData.tags.toString().split(',').map(Number);

    // 获取所有相关的标签名称
    const tags = await db('tag').select('name').whereIn('id', tagIds);

    // 将标签名称添加到返回结果中
    windowData.tags_name = tags.map(tag => tag.name);
  }

  return windowData;
};

const getByPidInScope = async (pid: number, workspaceId?: string) => {
  const query = db('window')
    .select(
      'window.*',
      'group.name as group_name',
      'proxy.ip',
      'proxy.proxy',
      'proxy.proxy_type',
      'proxy.ip_country',
      'proxy.ip_checker',
    )
    .where('window.pid', '=', pid)
    .leftJoin('group', 'window.group_id', '=', 'group.id')
    .leftJoin('proxy', 'window.proxy_id', '=', 'proxy.id');
  applyWorkspaceScope(query, 'window.workspace_id', workspaceId);
  return await query.first();
};

const update = async (id: number, updatedData: DB.Window, workspaceId?: string) => {
  if (updatedData.browser_engine !== undefined) {
    updatedData.browser_engine = normalizeBrowserEngine(updatedData.browser_engine);
  }
  delete updatedData.group_name;
  delete updatedData.proxy;
  delete updatedData.proxy_type;
  delete updatedData.ip_country;
  delete updatedData.ip_checker;
  delete updatedData.ip;
  delete updatedData.tags_name;
  if (updatedData.group_id === undefined) {
    updatedData.group_id = null;
  }
  if (updatedData.tags === undefined) {
    updatedData.tags = null;
  }
  try {
    const query = db('window').where({id});
    applyWorkspaceScope(query, 'workspace_id', workspaceId);
    await query.update({...updatedData, updated_at: db.fn.now()});
    return {
      success: true,
      message: 'Window updated successfully.',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to update window.' + error,
    };
  }
};

const create = async (windowData: DB.Window) => {
  windowData.browser_engine = normalizeBrowserEngine(windowData.browser_engine);

  if (windowData.id && typeof windowData.id === 'string') {
    windowData.profile_id = windowData.id;
    delete windowData.id;
  }
  if (!windowData.profile_id) {
    windowData.profile_id = randomUniqueProfileId();
    // 确保 profile_id 是唯一的
    while (await db('window').where({profile_id: windowData.profile_id}).first()) {
      windowData.profile_id = randomUniqueProfileId();
    }
  }
  try {
    const [id] = await db('window').insert(windowData);
    return {
      success: true,
      message: 'Window created successfully.',
      data: {
        ...windowData,
        id,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to create window.' + error,
    };
  }
};

const remove = async (id: number, workspaceId?: string) => {
  const query = db('window').where({id});
  applyWorkspaceScope(query, 'workspace_id', workspaceId);
  return await query.update({status: 0, sync_deleted_at: db.fn.now()});
};

const deleteAll = async () => {
  return await db('window').delete();
};

const batchRemove = async (ids: number[], workspaceId?: string) => {
  try {
    const query = db('window').whereIn('id', ids);
    applyWorkspaceScope(query, 'workspace_id', workspaceId);
    await query.update({status: 0, sync_deleted_at: db.fn.now()});
    return {
      success: true,
      message: 'Windows deleted successfully.',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to delete window.',
    };
  }
};

const batchClear = async (ids: number[], workspaceId?: string) => {
  try {
    const query = db('window').whereIn('id', ids);
    applyWorkspaceScope(query, 'workspace_id', workspaceId);
    await query.delete();
    return {
      success: true,
      message: 'Windows deleted successfully.',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to delete window.',
    };
  }
};

const normalizeImportText = (value: unknown) => String(value ?? '').trim();

const getImportText = (row: IWindowTemplate, keys: string[]) => {
  for (const key of keys) {
    const value = normalizeImportText(row[key]);
    if (value) {
      return value;
    }
  }

  return '';
};

const hasImportColumn = (row: IWindowTemplate, keys: string[]) =>
  keys.some(key => Object.prototype.hasOwnProperty.call(row, key));

const getImportNumber = (row: IWindowTemplate, keys: string[]) => {
  const value = getImportText(row, keys);
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const normalizeBrowserEngine = (value?: string) => {
  const engine = value?.trim().toLowerCase() || '';
  if (engine === 'chrome' || engine === 'local-chrome' || engine === '本机chrome') {
    return 'chrome';
  }
  if (engine === 'chromium' || engine === '原chromium') {
    return 'chromium';
  }
  return DEFAULT_BROWSER_ENGINE;
};

const normalizeImportedProxy = (value: string) => {
  const proxyText = value.trim();
  const protocolMatch = proxyText.match(/^([a-z0-9]+):\/\//i);
  const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : '';
  const proxy = protocolMatch ? proxyText.slice(protocolMatch[0].length) : proxyText;

  return {
    proxy_type: protocol === 'http' ? 'http' : 'socks5',
    proxy,
  };
};

type ImportCloudDefaults = {
  workspaceId: string;
  deviceId: string;
  reservedWindowCloudIds?: string[];
};

const resolveImportedProxyId = async (
  row: IWindowTemplate,
  cloudDefaults?: ImportCloudDefaults,
) => {
  const proxyValue = getImportText(row, [
    'proxy',
    'proxy_ip',
    'Proxy',
    'Proxy IP',
    '代理IP',
    '代理',
  ]);
  if (proxyValue) {
    const proxy = normalizeImportedProxy(proxyValue);
    const existingProxy = await ProxyDB.getByProxy(
      proxy.proxy_type,
      proxy.proxy,
      cloudDefaults?.workspaceId,
    );
    if (existingProxy?.id) {
      return existingProxy.id;
    }

    const [id] = await ProxyDB.create({
      proxy_type: proxy.proxy_type,
      proxy: proxy.proxy,
      ip_checker: 'ip2location',
      workspace_id: cloudDefaults?.workspaceId || null,
      sync_dirty: Boolean(cloudDefaults),
      updated_by_device_id: cloudDefaults?.deviceId,
    });

    return id ?? null;
  }

  const proxyId = getImportText(row, ['proxyid', 'proxy_id', 'Proxy ID']);

  if (!proxyId) return null;
  const existingProxy = await ProxyDB.getByIdInScope(Number(proxyId), cloudDefaults?.workspaceId);
  if (
    !existingProxy ||
    (cloudDefaults && existingProxy.workspace_id !== cloudDefaults.workspaceId)
  ) {
    return null;
  }
  return existingProxy.id ?? null;
};

const resolveImportedGroupId = async (
  row: IWindowTemplate,
  cloudDefaults?: ImportCloudDefaults,
) => {
  const groupName = getImportText(row, ['group', 'Group', '分组']);
  if (!groupName) {
    return null;
  }

  const existingGroup = await GroupDB.getByName(groupName, cloudDefaults?.workspaceId);
  if (existingGroup?.id) {
    return existingGroup.id;
  }

  const [id] = await GroupDB.create({
    name: groupName,
    workspace_id: cloudDefaults?.workspaceId || null,
    sync_dirty: Boolean(cloudDefaults),
    updated_by_device_id: cloudDefaults?.deviceId,
  });
  return id ?? null;
};

const resolveImportedTagIds = async (row: IWindowTemplate, cloudDefaults?: ImportCloudDefaults) => {
  const tagText = getImportText(row, ['tags', 'Tags', '标签']);
  if (!tagText) {
    return null;
  }

  const tagNames = [
    ...new Set(
      tagText
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean),
    ),
  ];
  const tagIds: number[] = [];
  for (const name of tagNames) {
    const existingTag = await TagDB.getByName(name, cloudDefaults?.workspaceId);
    if (existingTag?.id) {
      tagIds.push(existingTag.id);
      continue;
    }
    const [id] = await TagDB.create({
      name,
      workspace_id: cloudDefaults?.workspaceId || null,
      sync_dirty: Boolean(cloudDefaults),
      updated_by_device_id: cloudDefaults?.deviceId,
    });
    if (id) {
      tagIds.push(id);
    }
  }
  return tagIds;
};

const buildImportedWindow = async (
  row: IWindowTemplate,
  cloudDefaults?: ImportCloudDefaults,
): Promise<DB.Window> => ({
  name: getImportText(row, ['name', 'Name', '名称']) || row.name,
  group_id: await resolveImportedGroupId(row, cloudDefaults),
  profile_id: getImportText(row, ['id', 'profile_id', 'profileId', 'Profile ID']),
  proxy_id: await resolveImportedProxyId(row, cloudDefaults),
  ua: getImportText(row, ['ua', 'user_agent', 'User Agent', 'UA']),
  remark: getImportText(row, ['remark', 'Remark', '备注']),
  cookie: getImportText(row, ['cookie', 'Cookie']),
  browser_engine: normalizeBrowserEngine(
    getImportText(row, ['browser_engine', 'kernel', 'Kernel', '浏览器内核']),
  ),
});

const buildExportedWindowUpdate = async (
  row: IWindowTemplate,
  existingWindow: DB.Window,
  cloudDefaults?: ImportCloudDefaults,
) => {
  const updates: Partial<DB.Window> = {};

  if (hasImportColumn(row, ['name', 'Name', '名称'])) {
    updates.name = getImportText(row, ['name', 'Name', '名称']);
  }
  if (hasImportColumn(row, ['remark', 'Remark', '备注'])) {
    updates.remark = getImportText(row, ['remark', 'Remark', '备注']);
  }
  if (hasImportColumn(row, ['group', 'Group', '分组'])) {
    updates.group_id = await resolveImportedGroupId(row, cloudDefaults);
  }
  if (hasImportColumn(row, ['tags', 'Tags', '标签'])) {
    updates.tags = await resolveImportedTagIds(row, cloudDefaults);
  }
  if (
    hasImportColumn(row, [
      'proxy',
      'proxy_ip',
      'Proxy',
      'Proxy IP',
      '代理IP',
      '代理',
      'proxyid',
      'proxy_id',
      'Proxy ID',
    ])
  ) {
    updates.proxy_id = await resolveImportedProxyId(row, cloudDefaults);
  }

  return {...existingWindow, ...updates};
};

const getImportConflictContent = (row: IWindowTemplate): Record<string, string> => {
  const content: Record<string, string> = {};
  const fields = [
    ['名称', ['name', 'Name', '名称']],
    ['导入 ID', ['ID', 'id', 'profile_id', 'profileId', 'Profile ID']],
    ['分组', ['group', 'Group', '分组']],
    ['代理', ['proxy', 'proxy_ip', 'Proxy', 'Proxy IP', '代理IP', '代理']],
    ['备注', ['remark', 'Remark', '备注']],
  ] as const;

  for (const [label, keys] of fields) {
    const value = getImportText(row, [...keys]);
    if (value) content[label] = value;
  }

  return content;
};

const buildImportConflict = (
  row: IWindowTemplate,
  rowNumber: number,
  reason: string,
  importedId?: string,
): WindowImportConflict => ({
  row: rowNumber,
  windowName: getImportText(row, ['name', 'Name', '名称']) || '未命名窗口',
  importedId,
  reason,
  content: getImportConflictContent(row),
});

const withNewImportCloudIdentity = (
  windowData: DB.Window,
  cloudDefaults?: ImportCloudDefaults,
): DB.Window => {
  if (!cloudDefaults) return windowData;
  const cloudId = cloudDefaults.reservedWindowCloudIds?.shift() || randomUUID();
  return {
    ...windowData,
    cloud_id: cloudId,
    workspace_id: cloudDefaults.workspaceId,
    sync_dirty: true,
    updated_by_device_id: cloudDefaults.deviceId,
  };
};

const belongsToAnotherWorkspace = (windowData: DB.Window, cloudDefaults?: ImportCloudDefaults) =>
  Boolean(
    cloudDefaults && windowData.cloud_id && windowData.workspace_id !== cloudDefaults.workspaceId,
  );

const externalImport = async (fileData: IWindowTemplate[], cloudDefaults?: ImportCloudDefaults) => {
  const importedWindowIds: number[] = [];
  const createdWindowIds: number[] = [];
  const updatedWindowIds: number[] = [];
  const skippedRows: number[] = [];
  const conflicts: WindowImportConflict[] = [];
  for (let index = 0; index < fileData.length; index++) {
    const row: IWindowTemplate = fileData[index];
    const exportedId = getImportText(row, ['ID']);
    if (exportedId) {
      const existingWindow = await getByIdInScope(Number(exportedId), cloudDefaults?.workspaceId);
      if (!existingWindow) {
        // An exported ID belongs to another local database or a deleted window.
        // Never turn it into a duplicate profile during an update import.
        skippedRows.push(index + 1);
        conflicts.push(
          buildImportConflict(
            row,
            index + 1,
            '导入文件中的窗口 ID 在当前设备不存在。为防止误覆盖或复制 profile，系统没有创建新窗口。',
            exportedId,
          ),
        );
        continue;
      }

      if (belongsToAnotherWorkspace(existingWindow, cloudDefaults)) {
        const result = await create(
          withNewImportCloudIdentity(await buildImportedWindow(row, cloudDefaults), cloudDefaults),
        );
        if (result.data?.id) {
          importedWindowIds.push(result.data.id);
          createdWindowIds.push(result.data.id);
        } else {
          skippedRows.push(index + 1);
          conflicts.push(
            buildImportConflict(
              row,
              index + 1,
              `新建当前团队窗口失败：${result.message}`,
              exportedId,
            ),
          );
        }
        continue;
      }

      const updateResult = await update(
        existingWindow.id!,
        await buildExportedWindowUpdate(row, existingWindow, cloudDefaults),
        cloudDefaults?.workspaceId,
      );
      if (updateResult.success) {
        importedWindowIds.push(existingWindow.id!);
        updatedWindowIds.push(existingWindow.id!);
      } else {
        skippedRows.push(index + 1);
        conflicts.push(
          buildImportConflict(
            row,
            index + 1,
            `更新当前窗口失败：${updateResult.message}`,
            exportedId,
          ),
        );
      }
      continue;
    }

    const window = withNewImportCloudIdentity(
      await buildImportedWindow(row, cloudDefaults),
      cloudDefaults,
    );
    const result = await create(window);
    if (result.data?.id) {
      importedWindowIds.push(result.data.id);
      createdWindowIds.push(result.data.id);
    } else {
      skippedRows.push(index + 1);
      conflicts.push(buildImportConflict(row, index + 1, `新建窗口失败：${result.message}`));
    }
  }
  return {
    success: importedWindowIds.length > 0,
    message: `${createdWindowIds.length} created, ${updatedWindowIds.length} updated, ${skippedRows.length} skipped.`,
    data: importedWindowIds,
    createdWindowIds,
    updatedWindowIds,
    skippedRows,
    conflicts,
  };
};

export const WindowDB = {
  all,
  find,
  findByProxyIds,
  getById,
  getByIdInScope,
  getByIds,
  getByPid,
  getByPidInScope,
  getOpenedWindows,
  update,
  create,
  remove,
  deleteAll,
  batchRemove,
  batchClear,
  externalImport,
};
