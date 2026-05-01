import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('customer_cards', (table) => {
    table.unique(['customer_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('customer_cards', (table) => {
    table.dropUnique(['customer_id']);
  });
}
