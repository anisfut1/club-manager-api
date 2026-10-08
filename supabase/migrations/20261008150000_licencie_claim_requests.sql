-- Demandes de lien personnel pour une fiche SANS adresse email connue
-- (retour du club, 2026-10-08 : « si ce n'est pas son mail, c'est l'admin
-- qui décide de lui envoyer ou non, pour éviter qu'un mec fasse envoyer 40
-- mails en mode troll » ; risque R-018 de SCSB docs/migration/11 §7.9).
-- Aucun lien n'est généré tant qu'un club_admin n'a pas approuvé.
create table public.licencie_claim_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  requested_email text,
  return_to text not null default 'accueil',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz
);

-- Une seule demande en attente par fiche (les suivantes ne recréent rien et ne renvoient aucun email).
create unique index licencie_claim_requests_one_pending on public.licencie_claim_requests (licencie_id) where status = 'pending';
create index licencie_claim_requests_club_status on public.licencie_claim_requests (club_id, status);

-- Lecture/écriture uniquement par l'API (rôle service) après vérification club_admin : aucune policy.
alter table public.licencie_claim_requests enable row level security;

comment on table public.licencie_claim_requests is
  'Demandes de lien personnel pour une fiche sans email connu : validées ou refusées par un club_admin, jamais d''envoi automatique. Adresse effacée après décision ; demande expirée après 14 jours.';
