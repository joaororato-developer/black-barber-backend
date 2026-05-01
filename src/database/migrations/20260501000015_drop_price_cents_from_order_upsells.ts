import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('order_upsells', (table) => {
    table.dropColumn('price_cents');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('order_upsells', (table) => {
    table.integer('price_cents').notNullable().defaultTo(0);
  });
}
