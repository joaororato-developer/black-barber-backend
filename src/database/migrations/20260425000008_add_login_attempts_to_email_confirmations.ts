import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('email_confirmations', (table) => {
    // Purpose: distinguish checkout OTPs from login OTPs
    table.string('purpose').notNullable().defaultTo('checkout'); // 'checkout' | 'login'

    // Rate limiting (RN-008): track wrong attempts per code request
    table.integer('attempts').notNullable().defaultTo(0);
    table.timestamp('locked_until').nullable(); // set when attempts >= 5
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('email_confirmations', (table) => {
    table.dropColumn('purpose');
    table.dropColumn('attempts');
    table.dropColumn('locked_until');
  });
}
