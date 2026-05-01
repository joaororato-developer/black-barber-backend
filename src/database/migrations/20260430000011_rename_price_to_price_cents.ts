import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('plans', (table) => {
    table.renameColumn('price', 'price_cents');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('plans', (table) => {
    table.renameColumn('price_cents', 'price');
  });
}
