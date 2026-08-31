/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasSourceType = await knex.schema.hasColumn('extension', 'source_type');
  const hasSourceUrl = await knex.schema.hasColumn('extension', 'source_url');
  const hasChromeExtensionId = await knex.schema.hasColumn('extension', 'chrome_extension_id');
  const hasDistributionMode = await knex.schema.hasColumn('extension', 'distribution_mode');
  const hasAutoUpdate = await knex.schema.hasColumn('extension', 'auto_update');

  await knex.schema.alterTable('extension', table => {
    if (!hasSourceType) table.string('source_type').defaultTo('custom');
    if (!hasSourceUrl) table.string('source_url').nullable();
    if (!hasChromeExtensionId) table.string('chrome_extension_id').nullable();
    if (!hasDistributionMode) table.string('distribution_mode').defaultTo('manual');
    if (!hasAutoUpdate) table.boolean('auto_update').defaultTo(true);
  });

  await knex('extension')
    .whereNull('source_type')
    .update({source_type: 'custom'});

  await knex('extension')
    .whereNull('distribution_mode')
    .update({distribution_mode: 'manual'});

  await knex('extension')
    .whereNull('auto_update')
    .update({auto_update: true});
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const hasSourceType = await knex.schema.hasColumn('extension', 'source_type');
  const hasSourceUrl = await knex.schema.hasColumn('extension', 'source_url');
  const hasChromeExtensionId = await knex.schema.hasColumn('extension', 'chrome_extension_id');
  const hasDistributionMode = await knex.schema.hasColumn('extension', 'distribution_mode');
  const hasAutoUpdate = await knex.schema.hasColumn('extension', 'auto_update');

  await knex.schema.alterTable('extension', table => {
    if (hasSourceType) table.dropColumn('source_type');
    if (hasSourceUrl) table.dropColumn('source_url');
    if (hasChromeExtensionId) table.dropColumn('chrome_extension_id');
    if (hasDistributionMode) table.dropColumn('distribution_mode');
    if (hasAutoUpdate) table.dropColumn('auto_update');
  });
};
