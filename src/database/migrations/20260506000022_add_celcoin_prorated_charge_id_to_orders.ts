import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.table('orders', (t) => {
    t.string('celcoin_prorated_charge_id').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.table('orders', (t) => {
    t.dropColumn('celcoin_prorated_charge_id');
  });
}
