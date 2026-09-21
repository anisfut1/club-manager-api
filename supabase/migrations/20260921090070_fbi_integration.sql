-- Identifiants FBI du club, chiffrés côté serveur (AES-256-GCM, voir
-- src/lib/security/crypto.ts). Cette table n'a AUCUNE policy RLS accordant
-- un accès à `authenticated` : seule la service role (qui bypass la RLS,
-- utilisée uniquement par le serveur) peut la lire ou l'écrire. C'est la
-- garantie technique — pas seulement applicative — que le mot de passe FBI
-- ne quitte jamais le serveur, conformément à la demande.
create table public.fbi_credentials (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null unique references public.club (id) on delete cascade,
  username text not null,
  password_ciphertext text not null,
  password_iv text not null,
  password_auth_tag text not null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.fbi_credentials is
  'Identifiants FBI du club. password_* est chiffré (AES-256-GCM) avec FBI_CREDENTIALS_ENCRYPTION_KEY (variable d''environnement serveur, jamais en base). Aucune policy RLS pour `authenticated` : accès service role uniquement.';
comment on column public.fbi_credentials.username is
  'Identifiant FBI (pas un secret au même titre que le mot de passe, mais affiché uniquement côté admin).';

-- Statut d'intégration FBI, séparé des identifiants : lisible par les
-- super_admins pour /admin/integrations, sans jamais exposer de secret
-- (aucune colonne sensible ici).
create table public.fbi_integration_status (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null unique references public.club (id) on delete cascade,
  configured boolean not null default false,
  last_test_at timestamptz,
  last_test_success boolean,
  last_test_message text,
  last_login_at timestamptz,
  last_login_success boolean,
  last_job_at timestamptz,
  last_job_status text,
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.fbi_integration_status is
  'État observable de l''intégration FBI (jamais de secret). Alimenté par le serveur (test de connexion, jobs). Lu par /admin/integrations.';
