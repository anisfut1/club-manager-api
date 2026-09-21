-- Shim minimal reproduisant ce qu'un vrai projet Supabase fournit déjà
-- (schéma `auth`, fonction `auth.uid()`, rôles anon/authenticated/service_role)
-- pour pouvoir exécuter isolation_test.sql sur un Postgres vanilla local,
-- SANS Docker ni Supabase CLI. Sur un vrai projet Supabase (ou
-- `supabase test db` avec la stack locale complète), ce fichier est
-- inutile — auth.uid() et les rôles existent déjà.
--
-- À exécuter AVANT les migrations (elles référencent auth.users).
create extension if not exists pgcrypto;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase's auth.uid() lit le claim JWT "sub" injecté par PostgREST à
-- chaque requête. On simule le même mécanisme via un GUC de session
-- (voir isolation_test.sql : `set request.jwt.claim.sub = '<uuid>'`).
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
