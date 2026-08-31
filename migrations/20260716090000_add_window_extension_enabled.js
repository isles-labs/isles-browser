exports.up = async knex => {
  const hasTable = await knex.schema.hasTable('window_extension');
  const hasColumn = hasTable && (await knex.schema.hasColumn('window_extension', 'enabled'));
  if (!hasColumn) {
    await knex.schema.alterTable('window_extension', table => {
      table.boolean('enabled').notNullable().defaultTo(true);
    });
  }
};

exports.down = async knex => {
  const hasTable = await knex.schema.hasTable('window_extension');
  const hasColumn = hasTable && (await knex.schema.hasColumn('window_extension', 'enabled'));
  if (hasColumn) {
    await knex.schema.alterTable('window_extension', table => {
      table.dropColumn('enabled');
    });
  }
};
