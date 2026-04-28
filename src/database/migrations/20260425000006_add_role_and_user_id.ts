import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add 'role' to users table
  await knex.schema.alterTable('users', (table) => {
    table.string('role').notNullable().defaultTo('admin');
  });

  // Add 'user_id' FK to customers table (nullable — existing customers won't have one)
  await knex.schema.alterTable('customers', (table) => {
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.unique(['user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('customers', (table) => {
    table.dropUnique(['user_id']);
    table.dropColumn('user_id');
  });

  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('role');
  });
}
