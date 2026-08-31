import knex from 'knex';
import type {Knex} from 'knex';
import {app} from 'electron';
import {mkdirSync, existsSync} from 'fs';
import {DB_CONFIG} from '../constants';
import {WindowDB} from './window';
import {resetWindowStatus} from '../browser';
import {join} from 'path';

// import {ProxyDB} from './proxy';
// import {GroupDB} from './group';
// import {TagDB} from './tag';

const db = knex(DB_CONFIG);

const initWindowStatus = async () => {
  const windows = await WindowDB.all();
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index];
    // Recover both running and preparing states on app startup.
    // `status=3` (preparing) can be left behind when open flow is interrupted.
    if (window.id !== undefined && (window.status === 2 || window.status === 3)) {
      await resetWindowStatus(window.id);
    }
  }
};

const ensureWindowRuntimeColumns = async () => {
  const hasWindowTable = await db.schema.hasTable('window');
  if (!hasWindowTable) {
    return;
  }

  const columns = [
    ['browser_engine', (table: Knex.AlterTableBuilder) => table.string('browser_engine').nullable()],
    [
      'browser_runtime_platform',
      (table: Knex.AlterTableBuilder) => table.string('browser_runtime_platform').nullable(),
    ],
    ['browser_version', (table: Knex.AlterTableBuilder) => table.string('browser_version').nullable()],
    ['browser_core_family', (table: Knex.AlterTableBuilder) => table.string('browser_core_family').nullable()],
    ['browser_channel', (table: Knex.AlterTableBuilder) => table.string('browser_channel').nullable()],
    [
      'browser_min_core_version',
      (table: Knex.AlterTableBuilder) => table.string('browser_min_core_version').nullable(),
    ],
    [
      'browser_runtime_overrides',
      (table: Knex.AlterTableBuilder) => table.json('browser_runtime_overrides').nullable(),
    ],
  ] as const;

  for (const [columnName, addColumn] of columns) {
    const hasColumn = await db.schema.hasColumn('window', columnName);
    if (!hasColumn) {
      await db.schema.table('window', addColumn);
      console.log(`Added missing window column: ${columnName}`);
    }
  }
};

const ensureColumn = async (
  tableName: string,
  columnName: string,
  addColumn: (table: Knex.AlterTableBuilder) => void,
) => {
  const hasTable = await db.schema.hasTable(tableName);
  if (!hasTable) {
    return;
  }
  const hasColumn = await db.schema.hasColumn(tableName, columnName);
  if (!hasColumn) {
    await db.schema.table(tableName, addColumn);
    console.log(`Added missing ${tableName} column: ${columnName}`);
  }
};

const ensureCloudSyncColumns = async () => {
  const baseTables = ['group', 'proxy', 'tag', 'window', 'extension'];
  for (const tableName of baseTables) {
    await ensureColumn(tableName, 'cloud_id', table => table.string('cloud_id').nullable());
    await ensureColumn(tableName, 'workspace_id', table => table.string('workspace_id').nullable());
    await ensureColumn(tableName, 'sync_version', table => table.integer('sync_version').defaultTo(0));
    await ensureColumn(tableName, 'sync_dirty', table => table.boolean('sync_dirty').defaultTo(false));
    await ensureColumn(tableName, 'sync_deleted_at', table => table.timestamp('sync_deleted_at').nullable());
    await ensureColumn(tableName, 'last_synced_at', table => table.timestamp('last_synced_at').nullable());
    await ensureColumn(tableName, 'updated_by_device_id', table =>
      table.string('updated_by_device_id').nullable(),
    );
  }

  await ensureColumn('window', 'browser_core_family', table =>
    table.string('browser_core_family').nullable(),
  );
  await ensureColumn('window', 'browser_channel', table => table.string('browser_channel').nullable());
  await ensureColumn('window', 'browser_min_core_version', table =>
    table.string('browser_min_core_version').nullable(),
  );
  await ensureColumn('window', 'browser_runtime_overrides', table =>
    table.json('browser_runtime_overrides').nullable(),
  );
  await ensureColumn('window', 'group_cloud_id', table => table.string('group_cloud_id').nullable());
  await ensureColumn('window', 'proxy_cloud_id', table => table.string('proxy_cloud_id').nullable());
  await ensureColumn('window', 'tag_cloud_ids', table => table.json('tag_cloud_ids').nullable());

  const hasWindowExtension = await db.schema.hasTable('window_extension');
  if (hasWindowExtension) {
    await ensureColumn('window_extension', 'cloud_id', table => table.string('cloud_id').nullable());
    await ensureColumn('window_extension', 'workspace_id', table =>
      table.string('workspace_id').nullable(),
    );
    await ensureColumn('window_extension', 'window_cloud_id', table =>
      table.string('window_cloud_id').nullable(),
    );
    await ensureColumn('window_extension', 'extension_cloud_id', table =>
      table.string('extension_cloud_id').nullable(),
    );
    await ensureColumn('window_extension', 'sync_version', table =>
      table.integer('sync_version').defaultTo(0),
    );
    await ensureColumn('window_extension', 'sync_dirty', table =>
      table.boolean('sync_dirty').defaultTo(false),
    );
    await ensureColumn('window_extension', 'sync_deleted_at', table =>
      table.timestamp('sync_deleted_at').nullable(),
    );
    await ensureColumn('window_extension', 'last_synced_at', table =>
      table.timestamp('last_synced_at').nullable(),
    );
    await ensureColumn('window_extension', 'updated_by_device_id', table =>
      table.string('updated_by_device_id').nullable(),
    );
    await ensureColumn('window_extension', 'enabled', table => table.boolean('enabled').defaultTo(true));
  }
};

const ensureExtensionPathNullable = async () => {
  const hasExtensionTable = await db.schema.hasTable('extension');
  if (!hasExtensionTable) {
    return;
  }

  try {
    await db.schema.alterTable('extension', table => {
      table.string('path').nullable().alter();
    });
  } catch (error) {
    console.warn('Failed to relax extension.path nullable constraint:', error);
  }
};

const initializeDatabase = async () => {
  const userDataPath = app.getPath('userData');

  // 确保目录存在
  if (!existsSync(userDataPath)) {
    mkdirSync(userDataPath, {recursive: true});
  }

  try {
    // 初始化数据库连接
    await db.raw('SELECT 1');

    // Defensive schema repair before migrations for users stuck in a partially upgraded database.
    await ensureWindowRuntimeColumns();
    await ensureCloudSyncColumns();
    await ensureExtensionPathNullable();

    // 运行迁移
    try {
      await db.migrate.latest({
        directory: app.isPackaged ? join(process.resourcesPath, 'app/migrations') : './migrations',
        disableMigrationsListValidation: true,
      });
    } catch (migrationError) {
      console.error('Database migration failed:', migrationError);
    }

    // Defensive schema repair after migrations too. This keeps old packaged builds recoverable.
    await ensureWindowRuntimeColumns();
    await ensureCloudSyncColumns();
    await ensureExtensionPathNullable();

    // 初始化窗口状态
    await initWindowStatus();

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
};

export {db, initializeDatabase};
