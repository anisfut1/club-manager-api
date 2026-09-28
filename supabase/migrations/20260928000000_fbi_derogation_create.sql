-- =============================================================================
-- Création RÉELLE d'une dérogation FBI — demande du club, 2026-09-28 : "on a
-- vu comment accepter ou refuser une dérog, mtn faut en créer une... (sur
-- chaque rencontre faut un bouton "Créer une dérogation")... on remplit et
-- choisi le motif, et on envoie de la meme facon que pour accpter ou
-- refuser". ÉCRIT réellement sur FBI/FFBB (même famille d'action que
-- `fbi_derogation_responses`, migration 20260927030000) — engageante pour le
-- club, jamais annulable depuis cet outil une fois confirmée.
--
-- `fbi_derogation_creations` : trace d'audit de CHAQUE tentative de création
-- (qui, quand, quels champs soumis, quel résultat RÉEL renvoyé par FBI) —
-- table DISTINCTE de `fbi_derogation_responses` (pas de "decision"
-- accepter/refuser ici, mais les champs du formulaire de création réel :
-- motif obligatoire, date/horaire optionnellement modifiés, inversion de la
-- rencontre/des équipes). Écrite uniquement par le backend (service role)
-- après la tentative réelle, jamais insérable directement par un club_admin.
-- =============================================================================

create table public.fbi_derogation_creations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  motif text not null,
  modifier_date boolean not null default false,
  date_derogation text,
  modifier_horaire boolean not null default false,
  horaire text,
  inverser_rencontre boolean not null default false,
  inverser_equipe boolean not null default false,
  submitted_by uuid references auth.users (id) on delete set null,
  outcome text not null check (outcome in ('success', 'error', 'unknown')),
  fbi_message text,
  created_at timestamptz not null default now()
);

comment on table public.fbi_derogation_creations is
  'Audit de CHAQUE tentative de création d''une dérogation FBI (bouton "Créer une dérogation") — qui, quand, quels champs soumis, et ce que FBI a réellement renvoyé. Action réelle et engageante, jamais annulable depuis cet outil : cette trace est la seule façon de savoir après coup ce qui a été soumis.';
comment on column public.fbi_derogation_creations.submitted_by is
  'auth.users.id du club_admin ayant confirmé l''action — NULL si le compte a depuis été supprimé, jamais la trace elle-même.';

create index fbi_derogation_creations_club_id_idx on public.fbi_derogation_creations (club_id);
create index fbi_derogation_creations_match_id_idx on public.fbi_derogation_creations (match_id);

alter table public.fbi_derogation_creations enable row level security;

create policy "fbi_derogation_creations_select_club_admin" on public.fbi_derogation_creations for select to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- Écriture service role uniquement (le backend, après la tentative réelle
-- sur FBI) — jamais de policy INSERT/UPDATE/DELETE pour authenticated, même
-- principe que fbi_derogation_responses/fbi_jobs/fbi_derogation_checks.
