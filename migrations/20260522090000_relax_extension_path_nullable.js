/**
 * Extension files are local to each device. Cloud sync may receive extension
 * metadata before the current device has downloaded or imported the package.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasExtensionTable = await knex.schema.hasTable('extension');
  if (!hasExtensionTable) {
    return;
  }

  await knex.schema.alterTable('extension', table => {
    table.string('path').nullable().alter();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const hasExtensionTable = await knex.schema.hasTable('extension');
  if (!hasExtensionTable) {
    return;
  }

  await knex.schema.alterTable('extension', table => {
    table.string('path').notNullable().alter();
  });
};
