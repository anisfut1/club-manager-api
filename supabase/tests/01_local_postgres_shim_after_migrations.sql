-- Suite du shim (voir 00_local_postgres_shim_before_migrations.sql) :
-- ALTER DEFAULT PRIVILEGES ne s'applique qu'aux objets FUTURS, donc les
-- tables déjà créées par les migrations doivent recevoir la grant
-- explicitement ici. À exécuter APRÈS les migrations, AVANT fixtures.sql.
--
-- Inutile sur un vrai projet Supabase : ces grants existent déjà.
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
