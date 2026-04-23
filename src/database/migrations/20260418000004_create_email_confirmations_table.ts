import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_confirmations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email').notNullable();
    table.string('code').notNullable();
    table.string('status').notNullable().defaultTo('pending');
    table.timestamp('sent_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('email_confirmations');
}
