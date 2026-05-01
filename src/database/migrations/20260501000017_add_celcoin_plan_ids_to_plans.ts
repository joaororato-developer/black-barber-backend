import { Knex } from 'knex';

/**
 * Adds Celcoin plan IDs to the plans table.
 * Two columns are needed because Celcoin has separate plan registrations
 * for PIX/boleto (with loyalty quantity=3) and credit card (quantity=indefinite).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('plans', (table) => {
    table.integer('celcoin_plan_id_pix').nullable();          // Celcoin plan for PIX and boleto
    table.integer('celcoin_plan_id_credit_card').nullable();  // Celcoin plan for credit card
  });

  // Seed values from the Celcoin admin panel
  await knex('plans').where({ name: 'plano_barba' }).update({
    celcoin_plan_id_pix: 10,
    celcoin_plan_id_credit_card: 2,
  });

  await knex('plans').where({ name: 'plano_black' }).update({
    celcoin_plan_id_pix: 9,
    celcoin_plan_id_credit_card: 1,
  });

  await knex('plans').where({ name: 'plano_premium' }).update({
    celcoin_plan_id_pix: 11,
    celcoin_plan_id_credit_card: 3,
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('plans', (table) => {
    table.dropColumn('celcoin_plan_id_pix');
    table.dropColumn('celcoin_plan_id_credit_card');
  });
}
