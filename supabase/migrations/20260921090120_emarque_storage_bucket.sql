-- Bucket de stockage privé pour les documents e-Marque (ZIP/PDF).
-- Chemin conventionnel : private/emarque/{season}/{matchId}/... (voir
-- src/lib/storage/emarque-storage.ts).
--
-- Confidentialité : `public` est false, et AUCUNE policy n'est créée sur
-- storage.objects pour ce bucket. Supabase active RLS par défaut sur
-- storage.objects : sans policy accordant un accès à `authenticated`/`anon`,
-- ces fichiers ne sont accessibles que via la service role (le serveur),
-- jamais directement depuis le navigateur — même principe que
-- fbi_credentials (voir 20260921090070_fbi_integration.sql).
insert into storage.buckets (id, name, public)
values ('emarque', 'emarque', false)
on conflict (id) do nothing;
