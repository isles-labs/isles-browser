import {db} from '../db';

let ensured = false;

export const ensureCloudSyncSchema = async () => {
  if (ensured) {
    return;
  }

  const hasSyncDevice = await db.schema.hasTable('sync_device');
  if (!hasSyncDevice) {
    await db.schema.createTable('sync_device', table => {
      table.increments('id').primary();
      table.string('device_id').notNullable().unique();
      table.string('device_name').nullable();
      table.string('workspace_id').nullable();
      table.string('user_id').nullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').nullable();
    });
  }

  const hasSyncOutbox = await db.schema.hasTable('sync_outbox');
  if (!hasSyncOutbox) {
    await db.schema.createTable('sync_outbox', table => {
      table.increments('id').primary();
      table.string('workspace_id').nullable();
      table.string('entity_type').notNullable();
      table.integer('local_id').nullable();
      table.string('cloud_id').nullable();
      table.string('operation').notNullable();
      table.json('payload').nullable();
      table.integer('attempt_count').defaultTo(0);
      table.text('last_error').nullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').nullable();
      table.timestamp('processed_at').nullable();
    });
  }

  // These fields were added after the first cloud-sync release. Keep the
  // schema upgrade here because existing installations do not run migrations
  // for the auxiliary sync tables.
  const hasNextAttemptAt = await db.schema.hasColumn('sync_outbox', 'next_attempt_at');
  if (!hasNextAttemptAt) {
    await db.schema.table('sync_outbox', table => {
      table.timestamp('next_attempt_at').nullable();
    });
  }

  const hasMutationId = await db.schema.hasColumn('sync_outbox', 'mutation_id');
  if (!hasMutationId) {
    await db.schema.table('sync_outbox', table => {
      table.string('mutation_id').nullable().unique();
    });
  }

  const hasExpectedRevision = await db.schema.hasColumn('sync_outbox', 'expected_revision');
  if (!hasExpectedRevision) {
    await db.schema.table('sync_outbox', table => {
      table.integer('expected_revision').nullable();
    });
  }

  const hasBlockedAt = await db.schema.hasColumn('sync_outbox', 'blocked_at');
  if (!hasBlockedAt) {
    await db.schema.table('sync_outbox', table => {
      table.timestamp('blocked_at').nullable();
      table.text('blocked_reason').nullable();
    });
  }

  const hasProfileSyncState = await db.schema.hasTable('profile_sync_state');
  if (!hasProfileSyncState) {
    await db.schema.createTable('profile_sync_state', table => {
      table.increments('id').primary();
      table.integer('window_id').notNullable().unique();
      table.string('cloud_id').nullable();
      table.string('local_manifest_hash').nullable();
      table.string('cookie_hash').nullable();
      table.text('pending_cookie_snapshot').nullable();
      table.string('cloud_revision').nullable();
      table.string('pending_mutation_id').nullable();
      table.boolean('profile_dirty').defaultTo(false);
      table.boolean('offline_dirty').defaultTo(false);
      table.string('conflict_status').nullable();
      table.integer('uploaded_bytes').defaultTo(0);
      table.integer('downloaded_bytes').defaultTo(0);
      table.integer('last_file_count').defaultTo(0);
      table.integer('last_cookie_count').defaultTo(0);
      table.text('last_error').nullable();
      table.timestamp('last_synced_at').nullable();
      table.timestamp('updated_at').nullable();
    });
  }

  if (!(await db.schema.hasColumn('profile_sync_state', 'pending_mutation_id'))) {
    await db.schema.table('profile_sync_state', table => table.string('pending_mutation_id').nullable());
  }
  if (!(await db.schema.hasColumn('profile_sync_state', 'pending_cookie_snapshot'))) {
    await db.schema.table('profile_sync_state', table => table.text('pending_cookie_snapshot').nullable());
  }
  if (!(await db.schema.hasColumn('profile_sync_state', 'pending_mutation_scope'))) {
    await db.schema.table('profile_sync_state', table => table.string('pending_mutation_scope').nullable());
  }
  if (!(await db.schema.hasColumn('profile_sync_state', 'history_cursor'))) {
    await db.schema.table('profile_sync_state', table => table.string('history_cursor').nullable());
  }
  if (!(await db.schema.hasColumn('profile_sync_state', 'history_uploaded_visit_time'))) {
    await db.schema.table('profile_sync_state', table => table.string('history_uploaded_visit_time').nullable());
  }

  const hasSyncState = await db.schema.hasTable('sync_state');
  if (!hasSyncState) {
    await db.schema.createTable('sync_state', table => {
      table.increments('id').primary();
      table.string('workspace_id').notNullable();
      table.string('entity_type').notNullable();
      table.string('cursor').nullable();
      table.timestamp('last_pulled_at').nullable();
      table.timestamp('updated_at').nullable();
      table.unique(['workspace_id', 'entity_type']);
    });
  }

  const hasSyncConflict = await db.schema.hasTable('sync_conflict');
  if (!hasSyncConflict) {
    await db.schema.createTable('sync_conflict', table => {
      table.increments('id').primary();
      table.string('workspace_id').nullable();
      table.string('entity_type').notNullable();
      table.integer('local_id').nullable();
      table.string('cloud_id').nullable();
      table.json('local_payload').nullable();
      table.json('remote_payload').nullable();
      table.string('status').defaultTo('open');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('resolved_at').nullable();
    });
  }

  const hasRepairBackup = await db.schema.hasTable('sync_repair_local_backup');
  if (!hasRepairBackup) {
    await db.schema.createTable('sync_repair_local_backup', table => {
      table.increments('id').primary();
      table.string('repair_id').notNullable();
      table.string('workspace_id').notNullable();
      table.json('payload').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('sync_outbox_v2'))) {
    await db.schema.createTable('sync_outbox_v2', table => {
      table.increments('id').primary();
      table.string('workspace_id').notNullable();
      table.string('entity_type').notNullable();
      table.string('cloud_id').notNullable();
      table.string('mutation_id').notNullable().unique();
      table.integer('base_revision').notNullable();
      table.integer('canonical_revision').notNullable().defaultTo(0);
      table.json('patch').notNullable();
      table.string('operation').notNullable();
      table.string('state').notNullable().defaultTo('pending');
      table.integer('attempt_count').notNullable().defaultTo(0);
      table.timestamp('retry_at').nullable();
      table.text('last_error').nullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('updated_at').nullable();
      table.unique(['workspace_id', 'entity_type', 'cloud_id', 'state']);
    });
  }

  if (!(await db.schema.hasColumn('sync_outbox_v2', 'attempt_count'))) {
    await db.schema.table('sync_outbox_v2', table => table.integer('attempt_count').notNullable().defaultTo(0));
  }

  if (!(await db.schema.hasTable('sync_conflicts_v2'))) {
    await db.schema.createTable('sync_conflicts_v2', table => {
      table.increments('id').primary();
      table.string('workspace_id').notNullable();
      table.string('entity_type').notNullable();
      table.string('cloud_id').notNullable();
      table.integer('base_revision').notNullable();
      table.json('local_patch').notNullable();
      table.json('canonical_payload').notNullable();
      table.json('conflicting_fields').notNullable();
      table.string('status').notNullable().defaultTo('open');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('resolved_at').nullable();
    });
  }

  if (!(await db.schema.hasColumn('sync_conflicts_v2', 'canonical_revision'))) {
    await db.schema.table('sync_conflicts_v2', table => table.integer('canonical_revision').notNullable().defaultTo(0));
  }

  if (!(await db.schema.hasTable('sync_device_state_v2'))) {
    await db.schema.createTable('sync_device_state_v2', table => {
      table.string('workspace_id').primary();
      table.string('bootstrap_state').notNullable().defaultTo('required');
      table.string('cursor').nullable();
      table.string('snapshot_cursor').nullable();
      table.timestamp('last_ack_at').nullable();
      table.timestamp('updated_at').nullable();
    });
  }

  // Snapshot rows stay isolated until the stream has a verified end marker.
  // This prevents an interrupted bootstrap from exposing a partial workspace.
  if (!(await db.schema.hasTable('sync_bootstrap_stage_v2'))) {
    await db.schema.createTable('sync_bootstrap_stage_v2', table => {
      table.increments('id').primary();
      table.string('workspace_id').notNullable();
      table.string('entity_type').notNullable();
      table.string('cloud_id').notNullable();
      table.json('event').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.unique(['workspace_id', 'entity_type', 'cloud_id']);
    });
  }

  if (!(await db.schema.hasTable('sync_bootstrap_backup_v2'))) {
    await db.schema.createTable('sync_bootstrap_backup_v2', table => {
      table.increments('id').primary();
      table.string('workspace_id').notNullable();
      table.json('payload').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  ensured = true;
};
