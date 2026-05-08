import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('consent_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('order_id').nullable().references('id').inTable('orders').onDelete('SET NULL');
    t.string('consent_version').notNullable();
    t.text('consent_text').notNullable();
    t.string('ip_address').notNullable();
    t.string('user_agent').nullable();
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('consent_logs');
}
