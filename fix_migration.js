const knex = require('knex');
const config = require('./knexfile');

const db = knex(config.development || config.default?.development || config);


db('knex_migrations')
  .insert({
    name: '20260423000005_add_celcoin_charge_id_to_orders.ts',
    batch: 1,
    migration_time: new Date()
  })
  .then(() => {
    console.log('Migration 005 marked as completed in knex_migrations.');
    return db.destroy();
  })
  .catch((e) => {
    console.log('Error (may already exist):', e.message);
    return db.destroy();
  });
