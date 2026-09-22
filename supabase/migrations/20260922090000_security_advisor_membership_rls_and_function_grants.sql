-- Corrige 2 failles révélées par l'audit de sécurité automatique de
-- Supabase (`get_advisors`) lors du premier déploiement réel sur un projet
-- Supabase vierge. Aucune des deux n'a été détectée par
-- `supabase/tests/isolation_test.sql` (voir explication ci-dessous) —
-- préexistantes dans l'historique de migration, indépendantes de la
-- résolution des gaps frontend.

-- 1) CRITIQUE : club_memberships et membership_roles ont des policies RLS
-- créées dans 20260921100090_rls_multitenant_rewrite.sql, mais RLS n'a
-- JAMAIS été activée sur ces deux tables (aucun `alter table ... enable
-- row level security` dans 20260921100020_club_memberships.sql, la
-- migration qui les crée). Résultat réel : n'importe quel client muni de
-- la clé anon pouvait lire/écrire TOUTES les appartenances et TOUS les
-- rôles, tous clubs confondus — contournement total du multi-tenant.
--
-- Non détecté par isolation_test.sql car cette suite ne fait jamais de
-- SELECT direct sur ces deux tables sous un rôle authenticated/anon : elle
-- passe systématiquement par has_club_role()/is_club_member()
-- (SECURITY DEFINER), qui contournent la RLS de ces tables par
-- construction. Les policies existantes sont correctes : activer RLS les
-- rend simplement effectives (pas de risque de tout bloquer, contrairement
-- à une table sans aucune policy).
alter table public.club_memberships enable row level security;
alter table public.membership_roles enable row level security;

-- 2) try_acquire_sync_lock/release_sync_lock sont SECURITY DEFINER mais
-- restées exécutables par authenticated ET anon (privilège EXECUTE par
-- défaut de PostgreSQL sur toute fonction nouvellement créée) — même
-- classe de faille que celle déjà corrigée pour claim_next_fbi_job
-- (voir 20260921110040_fbi_jobs_execute_lockdown.sql). N'importe quel
-- utilisateur authentifié (voire anon) pouvait verrouiller/déverrouiller
-- la synchronisation de N'IMPORTE QUEL club en appelant le RPC
-- directement avec un club_id arbitraire (déni de service).
revoke all on function public.try_acquire_sync_lock(uuid, text, interval) from public, authenticated, anon;
grant execute on function public.try_acquire_sync_lock(uuid, text, interval) to service_role;

revoke all on function public.release_sync_lock(uuid, text) from public, authenticated, anon;
grant execute on function public.release_sync_lock(uuid, text) to service_role;

-- 3) Fonctions déclencheurs (trigger) exposées inutilement en RPC public :
-- jamais destinées à un appel direct (elles lisent NEW/OLD, qui n'existent
-- que dans un contexte de trigger — un appel RPC échouerait de toute façon
-- avec "record NEW is not assigned yet", mais autant fermer la surface).
-- L'exécution normale via trigger ne nécessite PAS de privilège EXECUTE
-- explicite pour le rôle déclencheur (comportement PostgreSQL standard) :
-- ce retrait ne casse ni on_auth_user_created, ni
-- club_memberships_licencie_same_club, ni membership_roles_scope_same_club.
revoke all on function public.handle_new_auth_user() from public, authenticated, anon;
revoke all on function public.check_membership_licencie_same_club() from public, authenticated, anon;
revoke all on function public.check_membership_role_scope_same_club() from public, authenticated, anon;
