-- =============================================================================
-- Correctif de sécurité : `claim_next_fbi_job` est SECURITY DEFINER (elle
-- doit voir toutes les lignes fbi_jobs, tous clubs confondus, pour le
-- worker) — mais PostgreSQL accorde EXECUTE à PUBLIC par défaut sur une
-- fonction nouvellement créée. Sans ce correctif, N'IMPORTE QUEL
-- utilisateur authentifié (n'importe quel club) pourrait appeler cette
-- fonction, réclamer le job de N'IMPORTE QUEL AUTRE club, et lire son
-- contenu (club_id, match_id) — un contournement total de la RLS via RPC,
-- alors que la seule policy SELECT sur fbi_jobs restreint déjà chaque
-- club_admin à son propre club (§49/§56 du brief FBI : le worker n'est
-- JAMAIS un rôle authenticated, uniquement service_role).
-- =============================================================================

revoke all on function public.claim_next_fbi_job(text) from public;
revoke all on function public.claim_next_fbi_job(text) from authenticated;
revoke all on function public.claim_next_fbi_job(text) from anon;
grant execute on function public.claim_next_fbi_job(text) to service_role;
