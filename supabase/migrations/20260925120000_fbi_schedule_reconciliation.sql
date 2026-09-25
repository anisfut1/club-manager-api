-- =============================================================================
-- Rapprochement calendrier FFBB / FBI (demande du club, voir docs/FBI.md
-- "Rapprochement calendrier FFBB/FBI") : "FBI est l'info réelle. si ya une
-- info sur fbi pour la même rencontre différente de ffbb, c'est une
-- anomalie. si un match est sur fbi, et pas sur ffbb, c'est à alerter
-- aussi." — FFBB reste la source du calendrier pour TOUS les clubs
-- (jamais remplacée, certains clubs n'ont QUE FFBB) ; FBI, quand un club
-- l'a configuré, sert à DÉTECTER des anomalies sur ce calendrier, jamais à
-- le remplacer.
-- =============================================================================

-- Nouveau type de job FBI (file existante, voir 20260921110000_fbi_jobs.sql) :
-- un seul job par club (jamais par match, contrairement à discover_emarque),
-- club-wide — match_id reste NULL comme pour test_connection.
alter table public.fbi_jobs drop constraint fbi_jobs_type_check;
alter table public.fbi_jobs add constraint fbi_jobs_type_check
  check (type in ('test_connection', 'discover_emarque', 'reconcile_schedule'));

comment on column public.fbi_jobs.match_id is
  'NULL pour un job test_connection ou reconcile_schedule (pas de match unique concerné). Obligatoire pour discover_emarque.';

-- Empêche d'empiler deux fois le même job "reconcile_schedule" en attente
-- pour le même club — même logique que fbi_jobs_unique_pending_discovery.
create unique index fbi_jobs_unique_pending_reconcile_schedule
  on public.fbi_jobs (club_id)
  where type = 'reconcile_schedule' and status in ('pending', 'claimed', 'running');

-- -----------------------------------------------------------------------------
-- Anomalies détectées lors d'un rapprochement : soit un écart de valeur sur
-- une rencontre présente des deux côtés (kind='mismatch', field_name
-- renseigné), soit une rencontre présente d'un seul côté (kind='missing_in_ffbb'
-- : vue sur FBI mais absente de notre calendrier synchronisé FFBB —
-- match_id NULL, aucune ligne `matches` correspondante ; kind='missing_in_fbi'
-- : une rencontre de notre calendrier FFBB introuvable dans le listing FBI
-- du club — match_id renseigné).
--
-- `division_code`/`numero` = clé de rapprochement (colonnes "Division"/"N°"
-- de FBI) — déjà présentes côté FFBB via `competitions.code`/`matches.numero`
-- (voir schedule-reconciliation.ts), aucune nouvelle donnée à synchroniser
-- pour matcher les deux sources.
create table public.fbi_schedule_discrepancies (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid references public.matches (id) on delete cascade,
  division_code text,
  numero text,
  kind text not null check (kind in ('mismatch', 'missing_in_ffbb', 'missing_in_fbi')),
  field_name text,
  ffbb_value text,
  fbi_value text,
  fbi_opponent_name text,
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.fbi_schedule_discrepancies is
  'Anomalies détectées entre le calendrier synchronisé FFBB (matches) et le calendrier FBI du club (rechercherRencontreSaisieResultat.fbi), pour les clubs ayant FBI configuré. FFBB reste la seule source ÉCRITE dans matches — cette table est un journal d''anomalies à corriger MANUELLEMENT côté FFBB (jamais une écriture automatique sur matches).';
comment on column public.fbi_schedule_discrepancies.match_id is
  'NULL pour kind=missing_in_ffbb (aucune ligne matches correspondante). Renseigné pour mismatch/missing_in_fbi.';
comment on column public.fbi_schedule_discrepancies.field_name is
  'Renseigné uniquement pour kind=mismatch : le champ qui diverge (match_datetime, venue, score, forfait).';
comment on column public.fbi_schedule_discrepancies.last_seen_at is
  'Mis à jour à chaque exécution du job reconcile_schedule qui revoit encore cette anomalie — distingue une anomalie toujours ouverte d''une anomalie plus détectée (voir resolved_at, mis à jour automatiquement quand un rapprochement ultérieur ne la revoit plus).';

create index fbi_schedule_discrepancies_club_id_idx on public.fbi_schedule_discrepancies (club_id);
create index fbi_schedule_discrepancies_match_id_idx on public.fbi_schedule_discrepancies (match_id);
create index fbi_schedule_discrepancies_open_idx on public.fbi_schedule_discrepancies (club_id) where resolved_at is null;

-- Une seule ligne OUVERTE par anomalie identique (club/division/numéro/nature/
-- champ) — un rapprochement répété (chaque job reconcile_schedule) met à jour
-- `last_seen_at` sur la ligne existante plutôt que d'en créer une nouvelle à
-- chaque exécution. `coalesce(field_name, '')` : field_name est NULL pour
-- missing_in_ffbb/missing_in_fbi, et NULL n'est jamais égal à NULL pour une
-- contrainte unique standard.
create unique index fbi_schedule_discrepancies_unique_open
  on public.fbi_schedule_discrepancies (club_id, coalesce(division_code, ''), coalesce(numero, ''), kind, coalesce(field_name, ''))
  where resolved_at is null;

alter table public.fbi_schedule_discrepancies enable row level security;

create policy "fbi_schedule_discrepancies_select_club_admin" on public.fbi_schedule_discrepancies for select to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());
