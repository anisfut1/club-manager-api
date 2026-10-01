-- Retour du club, 2026-10-01 : « dans la liste des joueurs, comme on a fait
-- pour l'admin, on le fait pour les coachs et coordinateurs. Pas besoin de
-- spécifier l'équipe, juste le rôle coach. Et coordinateur pour le
-- coordinateur ».
--
-- Mêmes principes que `licencies.public_admin` (20261001090000) : drapeaux
-- posés par un club_admin depuis /joueurs (PATCH /v1/clubs/:clubId/licencies/:id),
-- utilisés par l'espace public SANS COMPTE (lien personnel) :
--   - public_coach        : demande des dérogations internes pour TOUS les
--                           matchs à venir du club (pas de portée équipe) ;
--   - public_coordinator  : reçoit et traite les demandes (rôle « Coordinateur »).
-- Aucun droit dans l'espace connecté (/c/...), toujours régi par membership_roles.
alter table public.licencies
  add column if not exists public_coach boolean not null default false,
  add column if not exists public_coordinator boolean not null default false;

comment on column public.licencies.public_coach is
  'Coach (espace public sans compte) : peut demander une dérogation interne pour tout match à venir du club. Posé par un club_admin.';
comment on column public.licencies.public_coordinator is
  'Coordinateur des dérogations (espace public sans compte) : reçoit et traite les demandes internes. Posé par un club_admin.';

-- Un demandeur / auteur peut désormais être un LICENCIÉ identifié par son
-- lien personnel (aucun auth.users) : l'identité est un compte OU un licencié
-- (garanti par l'API). `on delete set null` : la suppression définitive d'un
-- licencié depuis /joueurs reste toujours possible — le nom affiché
-- (`requester_display_name`, `proposed_by_display_name`,
-- `author_display_name`) est un instantané et reste lisible.
alter table public.derogation_requests
  alter column created_by_user_id drop not null,
  add column if not exists created_by_licencie_id uuid references public.licencies (id) on delete set null;
create index if not exists derogation_requests_created_by_licencie_idx on public.derogation_requests (created_by_licencie_id);

alter table public.derogation_proposals
  alter column proposed_by_user_id drop not null,
  add column if not exists proposed_by_licencie_id uuid references public.licencies (id) on delete set null;

alter table public.derogation_messages
  add column if not exists author_licencie_id uuid references public.licencies (id) on delete set null;
