-- Personnes extraites d'un document e-Marque pour un match donné.
--
-- Principe (voir ARCHITECTURE.md §26) : on stocke TOUJOURS l'identité brute
-- extraite (nom/prénom/licence tels qu'OCRisés), et on ne relie à un
-- `licencie` existant QUE si son numéro de licence correspond exactement.
-- On ne crée jamais automatiquement un nouveau `licencie` à partir d'une
-- extraction : ces lignes SONT le mécanisme de "participant externe /
-- non résolu" demandé — pas besoin d'une table séparée.

create table public.match_participants (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  emarque_import_id uuid not null references public.emarque_imports (id) on delete cascade,
  team_side text not null check (team_side in ('home', 'away')),
  jersey_number text,
  first_name text,
  last_name text,
  license_number text,
  is_captain boolean not null default false,
  is_starter boolean,
  licencie_id uuid references public.licencies (id) on delete set null,
  extraction_confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.match_participants is
  'Joueur listé sur la feuille de marque d''un match. licencie_id n''est renseigné que si license_number correspond exactement à un licencié existant (voir src/server/emarque/normalizers).';

create index match_participants_match_id_idx on public.match_participants (match_id);
create index match_participants_license_idx on public.match_participants (license_number);
create index match_participants_licencie_id_idx on public.match_participants (licencie_id);

create table public.match_coaches (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  emarque_import_id uuid not null references public.emarque_imports (id) on delete cascade,
  team_side text not null check (team_side in ('home', 'away')),
  role text not null default 'principal' check (role in ('principal', 'adjoint')),
  first_name text,
  last_name text,
  license_number text,
  licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.match_coaches is
  'Entraîneur(s) listé(s) sur la feuille de marque d''un match.';

create index match_coaches_match_id_idx on public.match_coaches (match_id);

create table public.match_officials (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  emarque_import_id uuid not null references public.emarque_imports (id) on delete cascade,
  role text not null check (role in ('referee_1', 'referee_2', 'referee_3')),
  first_name text,
  last_name text,
  license_number text,
  licencie_id uuid references public.licencies (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.match_officials is
  'Arbitres de la rencontre, extraits de la feuille de marque (table "OFFICIELS..." — voir docs/FFBB_ECOSYSTEM_RESEARCH.md §8/§12, ce sont des arbitres, pas des OTM).';

create index match_officials_match_id_idx on public.match_officials (match_id);

-- OTM (table de marque) — priorité forte du produit (ARCHITECTURE.md §21) :
-- c'est ce qui permettra plus tard de confirmer automatiquement une
-- `table_assignment` (module non encore développé). Le mécanisme de
-- rapprochement futur est volontairement découplé : il consistera à
-- interroger cette table (match_id + licencie_id + role) depuis le futur
-- module tables, sans qu'aucun couplage direct n'existe ici.
create table public.match_table_officials (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  emarque_import_id uuid not null references public.emarque_imports (id) on delete cascade,
  role text not null check (
    role in ('scorer', 'assistant_scorer', 'timekeeper', 'shot_clock_operator', 'commissioner', 'other')
  ),
  first_name text,
  last_name text,
  license_number text,
  licencie_id uuid references public.licencies (id) on delete set null,
  extraction_confidence numeric,
  created_at timestamptz not null default now()
);

comment on table public.match_table_officials is
  'OTM (marqueur, chronométreur...) extraits de la feuille de marque. Point d''ancrage futur pour confirmer automatiquement une table_assignment (module non encore développé) : interroger (match_id, licencie_id, role) depuis ce module le moment venu, sans dépendance inverse ici.';

create index match_table_officials_match_id_idx on public.match_table_officials (match_id);
create index match_table_officials_licencie_id_idx on public.match_table_officials (licencie_id);
