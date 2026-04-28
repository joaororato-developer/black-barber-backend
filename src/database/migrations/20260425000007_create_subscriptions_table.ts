import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('subscriptions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    table.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');

    // Plan details at the time of subscription (snapshot — never changes)
    table.string('plan').notNullable();          // plan.name (snake_case value)
    table.integer('price_cents').notNullable();
    table.boolean('additional_eyebrow').notNullable().defaultTo(false);
    table.string('payment_type').notNullable();  // pix | creditcard | boleto

    // Celcoin reference
    table.string('celcoin_subscription_id').nullable();

    // Status
    table.string('status').notNullable().defaultTo('active'); // active | cancelled | expired

    // Loyalty (3 months for PIX/boleto, 0 for credit card)
    table.integer('loyalty_months').notNullable().defaultTo(0);
    table.timestamp('loyalty_until').nullable(); // null when no loyalty

    // Payment tracking for current billing cycle
    table.string('payment_status').notNullable().defaultTo('pending'); // pending | confirmed | error
    table.string('payment_link').nullable(); // link sent by Celcoin each month

    // Cancellation audit
    table.timestamp('cancelled_at').nullable();

    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('subscriptions');
}
