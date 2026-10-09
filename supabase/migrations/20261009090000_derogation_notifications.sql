-- Emails aux coordinateurs des dérogations (retour du club, 2026-10-08 :
-- « un système de mail au coordinateur, et un lien qui mène à la
-- dérogation »). Trace des notifications FBI déjà envoyées : la
-- vérification FBI repasse chaque jour, un même événement (dérogation
-- adverse à traiter, réponse reçue) n'est notifié qu'une fois.
create table public.derogation_notifications (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  kind text not null check (kind in ('fbi_incoming', 'fbi_outcome')),
  ref_key text not null,
  created_at timestamptz not null default now(),
  unique (club_id, kind, ref_key)
);

-- Lecture/écriture uniquement par l'API (rôle service) : aucune policy.
alter table public.derogation_notifications enable row level security;

comment on table public.derogation_notifications is
  'Notifications de dérogation FBI déjà envoyées aux coordinateurs (dédoublonnage), sans contenu nominatif.';
