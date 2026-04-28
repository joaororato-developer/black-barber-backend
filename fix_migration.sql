INSERT INTO knex_migrations(name,batch,migration_time) 
VALUES('20260423000005_add_celcoin_charge_id_to_orders.ts',1,now()) 
ON CONFLICT DO NOTHING;
