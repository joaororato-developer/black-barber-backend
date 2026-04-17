import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('customers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.string('email').notNullable();
    table.string('phone').notNullable();
    table.string('plan').notNullable();
    table.string('payment_method').notNullable();
    table.string('payment_status').defaultTo('pending').notNullable(); // 'pending', 'confirmed', 'error'
    table.string('erp_status').defaultTo('pending').notNullable(); // 'pending', 'registered'
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('customers');
}
