-- Extension applicative de auth.users : un profil par compte, avec rattachement
-- optionnel à un licencié. La contrainte unique sur licencie_id garantit qu'un
-- licencié n'a jamais plus d'un compte associé (0..1), conformément à ARCHITECTURE.md.
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  licencie_id uuid unique references public.licencies (id) on delete set null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Profil applicatif d''un compte Supabase Auth. licencie_id est nullable : un compte peut exister sans être (encore) rattaché à une personne du club.';

-- Crée automatiquement un profil vide à la création d'un compte Auth (invitation admin,
-- pas d'inscription publique en Phase 0). Le rattachement à un licencié et le nom affiché
-- sont renseignés ensuite manuellement par un administrateur.
create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user();
