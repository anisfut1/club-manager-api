-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 5/10 : club_id explicite sur la couche FFBB.
--
-- `teams` et `licencies` avaient déjà club_id (Phase 0/1). `matches`,
-- `ffbb_team_engagements`, `match_change_history` et `sync_runs` n'en
-- avaient pas : ils ne peuvent aujourd'hui être rattachés à un club qu'en
-- traversant une chaîne de jointures (matches -> teams -> club_id), ce qui
-- complexifierait fortement la RLS et rendrait plus facile un oubli de
-- scope (§3/§4 du brief SaaS). On ajoute donc club_id directement, en
-- 4 temps sûrs : colonne nullable -> backfill -> contraintes -> NOT NULL.
--
-- Décision documentée (§5 du brief SaaS) : `competitions`, `pools` et
-- `venues` restent des référentiels GLOBAUX (non tenant-scoped). Ce sont de
-- vraies entités FFBB partagées : si deux clubs de la plateforme jouent
-- dans la même poule, ce doit être la MÊME ligne `pools`, pas une copie par
-- club. Leur clé d'upsert (ffbb_*_id) est l'identifiant Directus, considéré
-- ici comme mondialement unique (voir docs/FFBB_ECOSYSTEM_RESEARCH.md).
--
-- Autre décision documentée : si deux clubs tenants de la plateforme
-- s'affrontent, chacun obtient sa PROPRE ligne `matches` pour cette
-- rencontre FFBB (perspective indépendante : son propre historique de
-- changements, son propre import e-Marque, son propre emarque_status).
-- `ffbb_match_id` n'est donc plus unique globalement mais par club.
-- =============================================================================

-- --- ffbb_team_engagements ---------------------------------------------------
alter table public.ffbb_team_engagements add column club_id uuid references public.clubs (id) on delete cascade;

update public.ffbb_team_engagements e
set club_id = t.club_id
from public.teams t
where t.id = e.team_id and e.club_id is null;

alter table public.ffbb_team_engagements alter column club_id set not null;
create index ffbb_team_engagements_club_id_idx on public.ffbb_team_engagements (club_id);

alter table public.ffbb_team_engagements drop constraint ffbb_team_engagements_ffbb_engagement_id_key;
alter table public.ffbb_team_engagements add constraint ffbb_team_engagements_club_engagement_unique unique (club_id, ffbb_engagement_id);

comment on column public.ffbb_team_engagements.club_id is
  'Tenant propriétaire (dérivé de teams.club_id au moment de la synchronisation, dupliqué ici pour simplifier la RLS — voir docs/MULTI_TENANCY.md).';

-- --- matches ------------------------------------------------------------------
alter table public.matches add column club_id uuid references public.clubs (id) on delete cascade;

update public.matches m
set club_id = t.club_id
from public.teams t
where t.id = m.team_id and m.club_id is null;

-- Filet de sécurité : un match sans équipe interne résolue (ne devrait pas
-- arriver, team_id est renseigné par syncFfbb) est rattaché au tenant
-- pilote plutôt que de bloquer la migration sur une ligne orpheline.
update public.matches
set club_id = (select id from public.clubs where slug = 'sc-sete-basket')
where club_id is null;

alter table public.matches alter column club_id set not null;
create index matches_club_id_idx on public.matches (club_id);

alter table public.matches drop constraint matches_ffbb_match_id_key;
alter table public.matches add constraint matches_club_ffbb_match_id_unique unique (club_id, ffbb_match_id);

comment on column public.matches.club_id is
  'Tenant propriétaire de CETTE perspective du match. Si deux clubs tenants s''affrontent, chacun a sa propre ligne (voir commentaire de migration).';

-- --- match_change_history ------------------------------------------------------
alter table public.match_change_history add column club_id uuid references public.clubs (id) on delete cascade;

update public.match_change_history h
set club_id = m.club_id
from public.matches m
where m.id = h.match_id and h.club_id is null;

alter table public.match_change_history alter column club_id set not null;
create index match_change_history_club_id_idx on public.match_change_history (club_id);

-- --- sync_runs ------------------------------------------------------------------
alter table public.sync_runs add column club_id uuid references public.clubs (id) on delete cascade;

update public.sync_runs
set club_id = (select id from public.clubs where slug = 'sc-sete-basket')
where club_id is null;

alter table public.sync_runs alter column club_id set not null;
create index sync_runs_club_id_idx on public.sync_runs (club_id);
create index sync_runs_club_provider_started_at_idx on public.sync_runs (club_id, provider, started_at desc);

comment on table public.sync_runs is
  'Une ligne par exécution du service de synchronisation (FFBB ou FBI) POUR UN CLUB. Alimente /c/{slug}/admin/sync ; un platform_admin peut voir tous les runs (voir RLS).';
