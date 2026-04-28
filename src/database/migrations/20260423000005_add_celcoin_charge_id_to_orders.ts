import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('orders', 'celcoin_charge_id');
  if (!hasColumn) {
    await knex.schema.alterTable('orders', (table) => {
      table.string('celcoin_charge_id').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('celcoin_charge_id');
  });
}
