import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscriptions', (table) => {
    table.dropColumns('plan', 'price_cents', 'additional_eyebrow', 'payment_type');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('subscriptions', (table) => {
    table.string('plan').notNullable().defaultTo('plano_barba');
    table.integer('price_cents').notNullable().defaultTo(0);
    table.boolean('additional_eyebrow').notNullable().defaultTo(false);
    table.string('payment_type').notNullable().defaultTo('pix');
  });
}
