-- =============================================================================
-- Tables de marque — module métier majeur (demande du club, 2026-09-28) :
-- pour chaque match du club joué À DOMICILE, affecter un licencié à chacun
-- des 3 postes (marqueur, chronométreur, délégué de club).
--
-- PRINCIPE FONDAMENTAL, à ne jamais perdre en relisant ce schéma : cette
-- table ne stocke QUE des AFFECTATIONS réelles, créées par un clic humain
-- explicite (voir modules/tables/routes.ts, PUT .../table-assignments/:role).
-- Les SUGGESTIONS (qui calculent les meilleurs candidats) sont calculées à
-- la volée (voir modules/tables/table-suggestion-service.ts) et ne touchent
-- JAMAIS cette table — "LE LOGICIEL SUGGÈRE. LE RESPONSABLE DÉCIDE."
--
-- Toute affectation est MANUELLE par construction en V1 (aucun auto-assign,
-- aucun cron de remplissage) : pas de colonne `source` (inutile tant
-- qu'elle ne vaudrait jamais que 'MANUAL').
-- =============================================================================

create table public.table_assignments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  role text not null check (role in ('SCORER', 'TIMEKEEPER', 'CLUB_DELEGATE')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Un seul licencié par poste sur un match donné (§28 de la demande).
  unique (club_id, match_id, role),
  -- Un licencié ne peut pas cumuler 2 postes sur le MÊME match (§11/§28).
  unique (club_id, match_id, licencie_id)
);

comment on table public.table_assignments is
  'Affectations RÉELLES (marqueur/chronométreur/délégué de club) pour les matchs à domicile — jamais une suggestion, jamais écrite automatiquement. Un match extérieur ne doit jamais y apparaître (vérifié applicativement dans modules/tables/routes.ts avant tout INSERT, matches.is_home n''étant pas directement contraignable ici sans dupliquer la donnée).';
comment on column public.table_assignments.role is
  'SCORER (marqueur) / TIMEKEEPER (chronométreur) / CLUB_DELEGATE (délégué de club) — les 3 seuls postes couverts par la V1 (§1 de la demande).';
comment on column public.table_assignments.created_by is
  'auth.users.id de la personne ayant cliqué "Choisir" — NULL si le compte a depuis été supprimé, jamais la ligne elle-même (même raisonnement que fbi_derogation_creations.submitted_by).';

-- Recherches "tous les postes d'un match", "toutes les affectations d'un
-- licencié" (équité, conflits cross-match) — les deux contraintes UNIQUE
-- ci-dessus couvrent déjà club_id+match_id ; licencie_id seul est
-- nécessaire pour parcourir les matchs d'UN licencié sans connaître le
-- match à l'avance (§33 : ne pas sur-indexer, un seul index ajouté).
create index table_assignments_licencie_id_idx on public.table_assignments (licencie_id);

alter table public.table_assignments enable row level security;

-- Lecture ET écriture réservées à club_admin ou responsable_tables (rôle
-- déjà présent dans club_role depuis la migration multi-tenant, jamais
-- encore utilisé par aucun module — §31 de la demande : "s'il existe déjà
-- un rôle adapté... utilise-le"). Même portée que les autres tables
-- sensibles côté membres (ex: fbi_derogation_creations) : la lecture
-- expose déjà qui joue où et quand pour d'autres équipes (raisons de
-- suggestion), pas une donnée à ouvrir à tout membre par défaut.
create policy "table_assignments_select_table_manager" on public.table_assignments for select to authenticated
  using (
    public.has_club_role(club_id, 'club_admin')
    or public.has_club_role(club_id, 'responsable_tables')
    or public.is_platform_admin()
  );

create policy "table_assignments_all_table_manager" on public.table_assignments for all to authenticated
  using (
    public.has_club_role(club_id, 'club_admin')
    or public.has_club_role(club_id, 'responsable_tables')
    or public.is_platform_admin()
  )
  with check (
    public.has_club_role(club_id, 'club_admin')
    or public.has_club_role(club_id, 'responsable_tables')
    or public.is_platform_admin()
  );
