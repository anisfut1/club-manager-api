-- Import AUTOMATIQUE des licenciés depuis FBI (retour du club, 2026-10-08 :
-- « faire un système qui importe automatiquement les licenciés, c'est une
-- galère de le faire manuellement, faut être technique, et faut que tout
-- soit pour les nuls »). Le worker FBI ouvre « Gestion des licences »
-- (rechercherLicence.fbi), filtre « Validation : Validé », télécharge
-- l'export Excel, puis l'API met à jour la liste des joueurs.
--
-- 1. Nouveau type de job `import_licences` (un seul actif par club, comme
--    `reconcile_schedule`).
-- 2. `licence_import_runs` : historique des imports (FBI automatique ou
--    fichier déposé), pour afficher « Dernière mise à jour : … » à l'admin.
--    Aucune donnée nominative : uniquement des compteurs.

alter table public.fbi_jobs drop constraint fbi_jobs_type_check;
alter table public.fbi_jobs add constraint fbi_jobs_type_check
  check (type in ('test_connection', 'discover_emarque', 'reconcile_schedule', 'check_derogation', 'check_all_derogations', 'import_licences'));

create unique index fbi_jobs_unique_pending_import_licences
  on public.fbi_jobs (club_id)
  where type = 'import_licences' and status in ('pending', 'claimed', 'running');

create table public.licence_import_runs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  source text not null check (source in ('fbi', 'file')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  total integer not null,
  inserted integer not null,
  updated integer not null,
  reactivated integer not null,
  unchanged integer not null,
  not_in_export integer not null
);

create index licence_import_runs_club_created on public.licence_import_runs (club_id, created_at desc);

-- Lecture/écriture uniquement par l'API (rôle service) après vérification club_admin : aucune policy.
alter table public.licence_import_runs enable row level security;

comment on table public.licence_import_runs is
  'Historique des imports de licenciés (export FBI « Rechercher une licence », filtre Validé) : compteurs seulement, aucune donnée nominative.';
