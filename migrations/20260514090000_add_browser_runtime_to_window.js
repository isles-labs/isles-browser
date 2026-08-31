/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const columns = ['browser_engine', 'browser_runtime_platform', 'browser_version'];

  for (const column of columns) {
    const hasColumn = await knex.schema.hasColumn('window', column);
    if (!hasColumn) {
      await knex.schema.table('window', table => {
        table.string(column).nullable();
      });
    }
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const columns = ['browser_engine', 'browser_runtime_platform', 'browser_version'];

  for (const column of columns) {
    const hasColumn = await knex.schema.hasColumn('window', column);
    if (hasColumn) {
      await knex.schema.table('window', table => {
        table.dropColumn(column);
      });
    }
  }
};
