-- =============================================================================
-- Réponse RÉELLE à une dérogation FBI (accepter/refuser) — demande du club,
-- 2026-09-27 : "je veux le faire via loutil... voici les boutons a utiliser
-- pour accetper ou refuser". Contrairement à tout le reste de l'intégration
-- FBI (strictement LECTURE SEULE jusqu'ici, voir docs/FBI.md), cette action
-- ÉCRIT réellement sur FBI/FFBB — engageante pour le club, jamais annulable
-- depuis cet outil une fois confirmée.
--
-- `id_derogation` : jeton FBI (`FbiDerogationRow.idDerogation`) distinct de
-- `fbi_row_key` (qui peut être une clé composite de repli quand ce jeton
-- est absent, voir sa doc) — nécessaire pour renaviguer vers
-- `afficherDerogation.fbi?idDerogation=...` et y soumettre une réponse.
-- `null` pour les lignes déjà connues AVANT cette migration (jamais
-- rétro-rempli par un backfill deviné) : la fonctionnalité "répondre" est
-- alors simplement indisponible pour cette ligne tant qu'une vérification
-- FBI plus récente ne l'a pas repeuplée.
--
-- `fbi_derogation_responses` : trace d'audit de CHAQUE tentative de réponse
-- (qui, quand, quelle décision, quel motif, quel résultat RÉEL renvoyé par
-- FBI) — indispensable pour une action réelle et engageante envers un tiers
-- (le club adverse, l'organisme dirigeant), jamais une simple donnée de
-- confort. Écrite uniquement par le backend (service role) après la
-- tentative réelle, jamais insérable directement par un club_admin (qui
-- pourrait sinon fabriquer un historique sans rapport avec ce qui s'est
-- réellement passé sur FBI).
-- =============================================================================

alter table public.fbi_derogation_checks add column id_derogation text;

comment on column public.fbi_derogation_checks.id_derogation is
  'Jeton FBI (idDerogation) de CETTE ligne, distinct de fbi_row_key (peut être une clé composite de repli) — nécessaire pour POST enregistrerDerogation.fbi (répondre). NULL pour les lignes connues avant cette migration.';

create table public.fbi_derogation_responses (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  fbi_row_key text not null,
  id_derogation text not null,
  decision text not null check (decision in ('accepted', 'refused')),
  motif_refus text,
  submitted_by uuid references auth.users (id) on delete set null,
  outcome text not null check (outcome in ('success', 'error', 'unknown')),
  fbi_message text,
  created_at timestamptz not null default now()
);

comment on table public.fbi_derogation_responses is
  'Audit de CHAQUE tentative de réponse (accepter/refuser) à une dérogation FBI — qui, quand, quelle décision, et ce que FBI a réellement renvoyé. Action réelle et engageante, jamais annulable depuis cet outil : cette trace est la seule façon de savoir après coup ce qui a été soumis.';
comment on column public.fbi_derogation_responses.submitted_by is
  'auth.users.id du club_admin ayant confirmé l''action — NULL si le compte a depuis été supprimé, jamais la trace elle-même.';

create index fbi_derogation_responses_club_id_idx on public.fbi_derogation_responses (club_id);
create index fbi_derogation_responses_match_id_idx on public.fbi_derogation_responses (match_id);

alter table public.fbi_derogation_responses enable row level security;

create policy "fbi_derogation_responses_select_club_admin" on public.fbi_derogation_responses for select to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

-- Écriture service role uniquement (le backend, après la tentative réelle
-- sur FBI) — jamais de policy INSERT/UPDATE/DELETE pour authenticated, même
-- principe que fbi_jobs/fbi_derogation_checks.
