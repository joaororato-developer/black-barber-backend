import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('plans');
  
  await knex.schema.createTable('plans', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable().unique();
    table.string('label').notNullable();
    table.integer('price').notNullable();
    table.timestamps(true, true);
  });

  // Populate default plans
  await knex('plans').insert([
    { name: 'plano_barba', label: 'Plano Barba', price: 9800 },
    { name: 'plano_black', label: 'Plano Black', price: 11800 },
    { name: 'plano_premium', label: 'Plano Premium', price: 17800 },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('plans');
}
