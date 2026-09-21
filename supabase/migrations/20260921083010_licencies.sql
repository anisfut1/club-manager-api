-- Une personne (licencié·e) du club, distincte d'un compte utilisateur Supabase Auth.
-- Un compte s'y rattache via profiles.licencie_id (0..1), jamais l'inverse : une personne
-- peut exister sans jamais avoir de compte (cf. ARCHITECTURE.md §6/§7).
create table public.licencies (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.club (id) on delete restrict,
  first_name text not null,
  last_name text not null,
  birth_date date,
  license_number text,
  email text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.licencies is
  'Personne physique du club (joueur, coach...). Peut exister sans compte utilisateur.';

create index licencies_club_id_idx on public.licencies (club_id);
