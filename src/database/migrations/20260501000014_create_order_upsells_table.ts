import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('order_upsells', (table) => {
    table.increments('id').primary();
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    table.integer('upsell_id').notNullable().references('id').inTable('upsells').onDelete('RESTRICT');
    table.integer('price_cents').notNullable();   // snapshot of price at time of purchase
    table.timestamps(true, true);

    table.unique(['order_id', 'upsell_id']);      // no duplicates per order
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('order_upsells');
}
