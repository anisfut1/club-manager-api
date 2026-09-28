-- =============================================================================
-- Ajoute un 4e poste "Arbitre" aux Tables de marque (retour du club,
-- 2026-09-28 : "il faut aussi ajouter un arbitre dans la table de marque.
-- Mais il est possible qu'un arbitre officiel soit désigné, donc avoir la
-- possibilité de cocher un truc style pas besoin d'arbitre").
--
-- Deux besoins distincts, deux mécanismes distincts :
-- 1) REFEREE devient un 4e rôle assignable, exactement comme les 3 autres
--    (même table `table_assignments`, mêmes contraintes, même moteur de
--    suggestion/conflit — aucune règle de qualification d'arbitre n'existe
--    en V1, même limitation assumée que pour CLUB_DELEGATE).
-- 2) Un arbitre OFFICIEL (désigné par la FFBB, hors de ce club) peut déjà
--    couvrir le match : la club n'a alors PAS besoin d'en assigner un.
--    C'est une bascule ("pas besoin d'arbitre"), pas une affectation — elle
--    ne référence aucun licencié, donc ne peut pas vivre dans
--    `table_assignments` (licencie_id y est NOT NULL par construction).
--    Nouvelle table dédiée, RLS identique à `table_assignments`.
-- =============================================================================

alter table public.table_assignments drop constraint table_assignments_role_check;
alter table public.table_assignments add constraint table_assignments_role_check
  check (role in ('SCORER', 'TIMEKEEPER', 'CLUB_DELEGATE', 'REFEREE'));

comment on column public.table_assignments.role is
  'SCORER (marqueur) / TIMEKEEPER (chronométreur) / CLUB_DELEGATE (délégué de club) / REFEREE (arbitre, ajouté 2026-09-28) — les 4 postes couverts par la V1.';

create table public.match_referee_overrides (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  -- Toujours `true` en pratique (une ligne n'existe QUE quand la case est
  -- cochée) : le handler DELETE la ligne plutôt que d'écrire `false`,
  -- comme table_assignments ("pas de ligne" = état par défaut). La colonne
  -- reste booléenne (et non l'absence de ligne comme seule information) au
  -- cas où un futur "pourquoi" (motif texte) s'y ajoute sans migration.
  no_referee_needed boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (club_id, match_id)
);

comment on table public.match_referee_overrides is
  'Bascule "pas besoin d''arbitre" quand un arbitre officiel FFBB est déjà désigné pour ce match — jamais une affectation (aucun licencié référencé). Absence de ligne = un arbitre du club est nécessaire (état par défaut).';

alter table public.match_referee_overrides enable row level security;

create policy "match_referee_overrides_select_table_manager" on public.match_referee_overrides for select to authenticated
  using (
    public.has_club_role(club_id, 'club_admin')
    or public.has_club_role(club_id, 'responsable_tables')
    or public.is_platform_admin()
  );

create policy "match_referee_overrides_all_table_manager" on public.match_referee_overrides for all to authenticated
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
