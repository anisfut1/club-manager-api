-- Tests d'isolation RLS reels, executes contre un vrai moteur Postgres
-- (shim local reproduisant auth.uid()/roles Supabase). Chaque assertion
-- echouee leve une exception explicite (le script s'arrete au premier
-- echec) ; un script qui va jusqu'au bout sans erreur = tous les tests OK.

set client_min_messages to notice;

create or replace function pg_temp.assert_count(label text, expected bigint, actual bigint) returns void
language plpgsql as $$
begin
  if expected <> actual then
    raise exception 'ECHEC [%] : attendu %, obtenu %', label, expected, actual;
  else
    raise notice 'OK [%] (=%)', label, actual;
  end if;
end;
$$;

-- Vérifie qu'appeler `claim_next_fbi_job` sous le rôle courant lève bien
-- une erreur de permission (§49 du brief FBI : jamais accessible à un rôle
-- authenticated, uniquement service_role) — pas juste "renvoie rien".
create or replace function pg_temp.assert_claim_next_fbi_job_denied(label text) returns void
language plpgsql as $$
begin
  perform public.claim_next_fbi_job('rogue-authenticated-caller');
  raise exception 'ECHEC [%] : claim_next_fbi_job aurait du etre refusee (permission denied)', label;
exception
  when insufficient_privilege then
    raise notice 'OK [%] (permission refusee comme attendu)', label;
end;
$$;

-- =============================================================
-- Scenario 1 : User A (membre UNIQUEMENT du Club A) ne voit QUE le Club A
-- =============================================================
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

select pg_temp.assert_count('user A - matches visibles', 1, (select count(*) from public.matches));
select pg_temp.assert_count('user A - matches: bien celui du club A', 1, (select count(*) from public.matches where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user A - matches club B invisibles', 0, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));

select pg_temp.assert_count('user A - sync_runs visibles (club_admin de A)', 1, (select count(*) from public.sync_runs));
select pg_temp.assert_count('user A - emarque_imports visibles', 1, (select count(*) from public.emarque_imports));
select pg_temp.assert_count('user A - match_participants visibles', 1, (select count(*) from public.match_participants));
select pg_temp.assert_count('user A - player_match_stats visibles', 1, (select count(*) from public.player_match_stats));

-- licencies : lecture "own" uniquement (pas de membership.licencie_id ici) + club_admin => tout le club A
select pg_temp.assert_count('user A - licencies visibles (club_admin de A)', 1, (select count(*) from public.licencies));

-- fbi_credentials : AUCUNE policy authenticated => invisible meme pour son propre club
select pg_temp.assert_count('user A - fbi_credentials TOUJOURS invisibles (service role only)', 0, (select count(*) from public.fbi_credentials));

-- fbi_jobs / match_documents (voir docs/FBI_WORKER.md) : memes garanties que le reste (§56 du brief FBI).
select pg_temp.assert_count('user A - fbi_jobs visibles (club_admin de A)', 1, (select count(*) from public.fbi_jobs));
select pg_temp.assert_count('user A - fbi_jobs club B invisibles', 0, (select count(*) from public.fbi_jobs where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user A - match_documents visibles (club_admin de A)', 1, (select count(*) from public.match_documents));
select pg_temp.assert_count('user A - match_documents club B invisibles', 0, (select count(*) from public.match_documents where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));

-- fbi_jobs n'a AUCUNE policy d'ecriture pour authenticated (worker/service
-- role uniquement, §49 du brief FBI) : meme le club_admin DE CE CLUB ne
-- peut pas modifier une ligne fbi_jobs.
update public.fbi_jobs set status = 'succeeded' where club_id = 'aaaaaaaa-0000-0000-0000-000000000000';
select pg_temp.assert_count('user A - UPDATE fbi_jobs (meme son propre club) refuse', 0, (select count(*) from public.fbi_jobs where club_id = 'aaaaaaaa-0000-0000-0000-000000000000' and status = 'succeeded'));

-- match_documents a une policy ALL pour le club_admin de SON club (utile
-- pour une future action admin), mais jamais pour un autre club.
update public.match_documents set status = 'error' where club_id = 'bbbbbbbb-0000-0000-0000-000000000000';
select pg_temp.assert_count('user A - UPDATE match_documents club B affecte 0 ligne', 0, (select count(*) from public.match_documents where club_id = 'bbbbbbbb-0000-0000-0000-000000000000' and status = 'error'));

-- Tentative de lecture DIRECTE par UUID connu du match B (meme en connaissant l'ID)
select pg_temp.assert_count('user A - lecture directe match B par UUID refusee', 0, (select count(*) from public.matches where id = 'bbbbbbbb-0000-0000-0000-000000000006'));

-- Tentative d'ECRITURE sur le club B (UPDATE ne doit affecter aucune ligne)
update public.matches set score_home = 999 where club_id = 'bbbbbbbb-0000-0000-0000-000000000000';
select pg_temp.assert_count('user A - UPDATE sur match B affecte 0 ligne', 0, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000' and score_home = 999));

reset role;
-- (repasser en superuser pour verifier la verite terrain sans RLS)
select pg_temp.assert_count('verite terrain - match B intact malgre la tentative user A', 0, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000' and score_home = 999));

-- =============================================================
-- Scenario 2 : User B (membre UNIQUEMENT du Club B) ne voit QUE le Club B
-- =============================================================
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';

select pg_temp.assert_count('user B - matches visibles', 1, (select count(*) from public.matches));
select pg_temp.assert_count('user B - matches: bien celui du club B', 1, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - matches club A invisibles', 0, (select count(*) from public.matches where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - licencies club A invisibles', 0, (select count(*) from public.licencies where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - sync_runs club A invisibles', 0, (select count(*) from public.sync_runs where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - fbi_jobs club A invisibles (jamais la session/le cookie d''un autre club)', 0, (select count(*) from public.fbi_jobs where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - match_documents club A invisibles', 0, (select count(*) from public.match_documents where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - match_documents: bien celui du club B', 1, (select count(*) from public.match_documents where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));

-- claim_next_fbi_job est SECURITY DEFINER : elle voit TOUTES les lignes
-- fbi_jobs, tous clubs confondus (necessaire pour le worker), donc si un
-- authenticated pouvait l'appeler il pourrait reclamer et LIRE le job d'un
-- club dont il n'est meme pas membre — un contournement total de la RLS.
-- Seul EXECUTE reserve a service_role empeche ca (§49 du brief FBI).
select pg_temp.assert_claim_next_fbi_job_denied('user B - claim_next_fbi_job refusee (jamais un role authenticated)');

reset role;

-- =============================================================
-- Scenario 3 : User AB (membre des DEUX clubs, coach en A, joueur en B)
-- =============================================================
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000001';

select pg_temp.assert_count('user AB - voit les matchs des DEUX clubs', 2, (select count(*) from public.matches));
select pg_temp.assert_count('user AB - est bien membre de A et B', 2, (select count(*) from public.club_memberships where user_id = 'cccccccc-0000-0000-0000-000000000001'));

-- User AB n'est PAS club_admin (coach/joueur seulement) => ne doit PAS pouvoir
-- ecrire sur les tables reservees aux club_admin (ex: teams).
update public.teams set name = 'Hack' where club_id = 'aaaaaaaa-0000-0000-0000-000000000000';
select pg_temp.assert_count('user AB (coach, pas admin) - UPDATE teams club A refuse', 0, (select count(*) from public.teams where club_id = 'aaaaaaaa-0000-0000-0000-000000000000' and name = 'Hack'));

reset role;

-- =============================================================
-- Scenario 4 : platform_admin voit tout, cross-club
-- =============================================================
insert into public.platform_admins (user_id) values ('cccccccc-0000-0000-0000-000000000001');

set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000001';

select pg_temp.assert_count('platform_admin - voit tous les matchs (2 clubs)', 2, (select count(*) from public.matches));
select pg_temp.assert_count('platform_admin - voit tous les sync_runs (2 clubs)', 2, (select count(*) from public.sync_runs));

reset role;
delete from public.platform_admins where user_id = 'cccccccc-0000-0000-0000-000000000001';

-- =============================================================
-- Scenario 5 : meme identifiant externe dans 2 clubs (coexistence, pas collision)
-- =============================================================
select pg_temp.assert_count('coexistence - 2 licencies avec le meme numero, clubs differents', 2, (select count(*) from public.licencies where license_number = 'AAA123456'));
select pg_temp.assert_count('coexistence - 2 matches avec le meme ffbb_match_id, clubs differents', 2, (select count(*) from public.matches where ffbb_match_id = 'ffbb-shared-123'));

-- =============================================================
-- Scenario 6 : sans authentification (anon), rien n'est visible
-- =============================================================
set role anon;
select pg_temp.assert_count('anon - aucun match visible', 0, (select count(*) from public.matches));
select pg_temp.assert_count('anon - aucun licencie visible', 0, (select count(*) from public.licencies));
select pg_temp.assert_claim_next_fbi_job_denied('anon - claim_next_fbi_job refusee');
reset role;

-- =============================================================
-- Scenario 7 : le worker (service_role) reclame un job cross-club sans
-- jamais melanger les deux (§13/§56 du brief FBI) — sanity check que le
-- correctif de securite du Scenario 2 ne casse pas l'usage LEGITIME.
-- =============================================================
set role service_role;

select pg_temp.assert_count('service_role - voit les fbi_jobs des 2 clubs (bypassrls)', 2, (select count(*) from public.fbi_jobs));

-- Reclame un premier job : doit etre l'un des deux clubs, jamais les deux
-- a la fois (FOR UPDATE SKIP LOCKED, un seul at a time ici). `count(id)`,
-- pas `count(*)` : une fonction "RETURNS public.fbi_jobs" (pas SETOF) qui
-- renvoie NULL produit tout de meme UNE ligne (toutes colonnes NULL) dans
-- un contexte FROM — seul `count(id)` distingue "aucun job" de "1 job".
select pg_temp.assert_count('service_role - claim_next_fbi_job reclame exactement 1 job', 1, (select count(id) from public.claim_next_fbi_job('worker-test#0')));

-- Le job reclame est maintenant 'claimed' : le reclamer une SECONDE fois ne
-- doit RIEN renvoyer pour CE job (exclu par le WHERE status='pending'), et
-- l'autre club doit encore etre reclamable (aucun blocage cross-club).
select pg_temp.assert_count('service_role - 1 seul job encore pending apres 1 claim', 1, (select count(*) from public.fbi_jobs where status = 'pending'));
select pg_temp.assert_count('service_role - claim_next_fbi_job reclame le job de L''AUTRE club ensuite', 1, (select count(id) from public.claim_next_fbi_job('worker-test#1')));
select pg_temp.assert_count('service_role - plus aucun job pending (les 2 clubs traites, aucun melange)', 0, (select count(*) from public.fbi_jobs where status = 'pending'));

reset role;

do $$ begin raise notice '=== TOUS LES TESTS D''ISOLATION SONT PASSES ==='; end $$;
