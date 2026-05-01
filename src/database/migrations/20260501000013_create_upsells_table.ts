import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('upsells', (table) => {
    table.increments('id').primary();
    table.string('key').notNullable().unique();   // machine-readable key, e.g. 'additional_eyebrow'
    table.string('label').notNullable();           // human-readable name, e.g. 'Sobrancelha adicional'
    table.integer('price_cents').notNullable();    // price in cents
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamps(true, true);
  });

  // Seed: existing eyebrow upsell (previously hardcoded as 4000)
  await knex('upsells').insert([
    { key: 'additional_eyebrow', label: 'Sobrancelha adicional', price_cents: 4000 },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('upsells');
}
