import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('customers', (table) => {
    table.string('zip_code').nullable();
    table.string('street').nullable();
    table.string('street_number').nullable();
    table.string('neighborhood').nullable();
    table.string('city').nullable();
    table.string('state', 2).nullable();  // 2-letter state code, e.g. 'SP'
    table.string('complement').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('customers', (table) => {
    table.dropColumns('zip_code', 'street', 'street_number', 'neighborhood', 'city', 'state', 'complement');
  });
}
