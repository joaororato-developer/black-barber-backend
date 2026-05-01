import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('orders', 'price_cents');
  if (!hasColumn) {
    await knex.schema.table('orders', (table) => {
      table.integer('price_cents').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.table('orders', (table) => {
    table.dropColumn('price_cents');
  });
}
