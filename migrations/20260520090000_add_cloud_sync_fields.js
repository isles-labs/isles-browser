/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const syncTables = ['group', 'proxy', 'tag', 'window', 'extension'];

  for (const tableName of syncTables) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) {
      continue;
    }

    await knex.schema.alterTable(tableName, table => {
      table.string('cloud_id').nullable();
      table.string('workspace_id').nullable();
      table.integer('sync_version').defaultTo(0);
      table.boolean('sync_dirty').defaultTo(false);
      table.timestamp('sync_deleted_at').nullable();
      table.timestamp('last_synced_at').nullable();
      table.string('updated_by_device_id').nullable();
    });
  }

  const hasWindowTable = await knex.schema.hasTable('window');
  if (hasWindowTable) {
    await knex.schema.alterTable('window', table => {
      table.string('browser_core_family').nullable();
      table.string('browser_channel').nullable();
      table.string('browser_min_core_version').nullable();
      table.json('browser_runtime_overrides').nullable();
    });
  }

  const hasWindowExtensionTable = await knex.schema.hasTable('window_extension');
  if (hasWindowExtensionTable) {
    await knex.schema.alterTable('window_extension', table => {
      table.string('cloud_id').nullable();
      table.string('workspace_id').nullable();
      table.string('window_cloud_id').nullable();
      table.string('extension_cloud_id').nullable();
      table.integer('sync_version').defaultTo(0);
      table.boolean('sync_dirty').defaultTo(false);
      table.timestamp('sync_deleted_at').nullable();
      table.timestamp('last_synced_at').nullable();
      table.string('updated_by_device_id').nullable();
    });
  }

  for (const tableName of [...syncTables, 'window_extension']) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (hasTable) {
      await knex.schema.alterTable(tableName, table => {
        table.index(['workspace_id', 'cloud_id'], `${tableName}_workspace_cloud_idx`);
      });
    }
  }

  const hasSyncDevice = await knex.schema.hasTable('sync_device');
  if (!hasSyncDevice) {
    await knex.schema.createTable('sync_device', table => {
      table.increments('id').primary();
      table.string('device_id').notNullable().unique();
      table.string('device_name').nullable();
      table.string('workspace_id').nullable();
      table.string('user_id').nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').nullable();
    });
  }

  const hasSyncState = await knex.schema.hasTable('sync_state');
  if (!hasSyncState) {
    await knex.schema.createTable('sync_state', table => {
      table.increments('id').primary();
      table.string('workspace_id').notNullable();
      table.string('entity_type').notNullable();
      table.string('cursor').nullable();
      table.timestamp('last_pulled_at').nullable();
      table.timestamp('updated_at').nullable();
      table.unique(['workspace_id', 'entity_type']);
    });
  }

  const hasSyncOutbox = await knex.schema.hasTable('sync_outbox');
  if (!hasSyncOutbox) {
    await knex.schema.createTable('sync_outbox', table => {
      table.increments('id').primary();
      table.string('workspace_id').nullable();
      table.string('entity_type').notNullable();
      table.integer('local_id').nullable();
      table.string('cloud_id').nullable();
      table.string('operation').notNullable();
      table.json('payload').nullable();
      table.integer('attempt_count').defaultTo(0);
      table.text('last_error').nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').nullable();
      table.timestamp('processed_at').nullable();
    });
  }

  const hasSyncConflict = await knex.schema.hasTable('sync_conflict');
  if (!hasSyncConflict) {
    await knex.schema.createTable('sync_conflict', table => {
      table.increments('id').primary();
      table.string('workspace_id').nullable();
      table.string('entity_type').notNullable();
      table.integer('local_id').nullable();
      table.string('cloud_id').nullable();
      table.json('local_payload').nullable();
      table.json('remote_payload').nullable();
      table.string('status').defaultTo('open');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('resolved_at').nullable();
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  for (const tableName of ['group', 'proxy', 'tag', 'window', 'extension', 'window_extension']) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (hasTable) {
      await knex.schema.alterTable(tableName, table => {
        table.dropIndex(['workspace_id', 'cloud_id'], `${tableName}_workspace_cloud_idx`);
      });
    }
  }

  const dropTables = ['sync_conflict', 'sync_outbox', 'sync_state', 'sync_device'];
  for (const tableName of dropTables) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (hasTable) {
      await knex.schema.dropTable(tableName);
    }
  }

  const hasWindowExtensionTable = await knex.schema.hasTable('window_extension');
  if (hasWindowExtensionTable) {
    await knex.schema.alterTable('window_extension', table => {
      table.dropColumn('cloud_id');
      table.dropColumn('workspace_id');
      table.dropColumn('window_cloud_id');
      table.dropColumn('extension_cloud_id');
      table.dropColumn('sync_version');
      table.dropColumn('sync_dirty');
      table.dropColumn('sync_deleted_at');
      table.dropColumn('last_synced_at');
      table.dropColumn('updated_by_device_id');
    });
  }

  const hasWindowTable = await knex.schema.hasTable('window');
  if (hasWindowTable) {
    await knex.schema.alterTable('window', table => {
      table.dropColumn('browser_core_family');
      table.dropColumn('browser_channel');
      table.dropColumn('browser_min_core_version');
      table.dropColumn('browser_runtime_overrides');
    });
  }

  const syncTables = ['group', 'proxy', 'tag', 'window', 'extension'];
  for (const tableName of syncTables) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) {
      continue;
    }

    await knex.schema.alterTable(tableName, table => {
      table.dropColumn('cloud_id');
      table.dropColumn('workspace_id');
      table.dropColumn('sync_version');
      table.dropColumn('sync_dirty');
      table.dropColumn('sync_deleted_at');
      table.dropColumn('last_synced_at');
      table.dropColumn('updated_by_device_id');
    });
  }
};
