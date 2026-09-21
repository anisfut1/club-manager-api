-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 9/10 : configuration FFBB par club.
--
-- `clubs.ffbb_club_id` suffisait déjà comme configuration FFBB (§19 du
-- brief SaaS : "évite de sur-normaliser si clubs.ffbb_code suffit"). On
-- ajoute seulement ce qui manque pour un cron multi-club qui passe à
-- l'échelle sans re-synchroniser inutilement un club déjà à jour :
-- - ffbb_enabled : un club peut couper sa sync FFBB sans changer son statut
-- - ffbb_next_sync_at : prochaine synchronisation autorisée (batching)
-- =============================================================================

alter table public.clubs
  add column ffbb_enabled boolean not null default true,
  add column ffbb_next_sync_at timestamptz;

comment on column public.clubs.ffbb_enabled is
  'Synchronisation FFBB active pour ce club. Indépendant de clubs.status (un club actif peut désactiver temporairement sa sync FFBB).';
comment on column public.clubs.ffbb_next_sync_at is
  'Prochaine synchronisation FFBB autorisée pour ce club (NULL = à synchroniser dès que possible). Permet au cron de ne traiter que les clubs dus, même à grande échelle (voir docs/MULTI_TENANCY.md).';

create index clubs_ffbb_due_idx on public.clubs (ffbb_next_sync_at) where status = 'active' and ffbb_enabled = true;
