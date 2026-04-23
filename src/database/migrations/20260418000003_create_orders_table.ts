import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('orders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    table.string('plan').notNullable();
    table.boolean('additional_eyebrow').defaultTo(false);
    table.string('payment_type').notNullable();
    table.string('payment_status').notNullable().defaultTo('pending');
    table.string('order_status').notNullable().defaultTo('payment_pending');
    table.timestamp('status_updated_at').defaultTo(knex.fn.now());
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('orders');
}
