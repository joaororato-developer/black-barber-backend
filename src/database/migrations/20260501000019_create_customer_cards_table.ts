import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await knex.schema.createTable('customer_cards', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE').notNullable();
    
    // Encrypted data (Card number, CVV, holder name)
    // We'll store as a single encrypted string or multiple fields
    table.text('encrypted_data').notNullable();
    
    // Metadata for display
    table.string('brand', 20);
    table.string('last_digits', 4).notNullable();
    table.string('holder_name').notNullable();
    table.string('expiry_month', 2).notNullable();
    table.string('expiry_year', 4).notNullable();
    
    table.boolean('is_default').defaultTo(true);
    table.timestamps(true, true);
    
    table.index(['customer_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('customer_cards');
}
