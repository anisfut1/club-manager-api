-- =============================================================================
-- FBI/e-Marque réellement automatisé — Étape 2/3 : manifeste de documents.
--
-- Distinct de `emarque_imports` (qui suit le cycle de vie du PARSING d'un
-- ZIP donné). `match_documents` liste les FICHIERS individuels découverts
-- pour un match (le ZIP complet en priorité, ou des PDF séparés si FBI ne
-- fournit pas de ZIP), indépendamment du succès du parsing — utile pour
-- l'UI (lister "Feuille / Résumé / Position tirs" comme entrées
-- téléchargeables même avant/sans parsing réussi, voir §33/§34 du brief).
-- =============================================================================

create table public.match_documents (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  type text not null check (type in ('emarque_zip', 'match_sheet', 'summary', 'shot_chart', 'other')),
  source text not null default 'fbi' check (source in ('fbi')),
  filename text,
  mime_type text,
  sha256 text not null,
  storage_path text not null,
  status text not null default 'downloaded' check (status in ('downloaded', 'parsing', 'imported', 'error')),
  discovered_at timestamptz not null default now(),
  downloaded_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.match_documents is
  'Manifeste des fichiers e-Marque individuels découverts pour un match (déposés par le worker FBI). Le pipeline de parsing (src/server/emarque) traite les lignes type=emarque_zip, status=downloaded, et met à jour leur statut — voir docs/FBI_WORKER.md.';
comment on column public.match_documents.sha256 is
  'Empreinte du fichier réellement stocké. Une nouvelle version du même document (nouveau hash) crée une NOUVELLE ligne : l''historique des versions est conservé, jamais de suppression silencieuse (voir §24 du brief FBI).';

create index match_documents_club_id_idx on public.match_documents (club_id);
create index match_documents_match_id_idx on public.match_documents (match_id);
create index match_documents_pending_parse_idx on public.match_documents (status) where type = 'emarque_zip' and status = 'downloaded';

-- Idempotence (§24 du brief FBI) : le même fichier (même club, même match,
-- même type, même contenu) n'est jamais dupliqué.
create unique index match_documents_club_match_type_hash_unique
  on public.match_documents (club_id, match_id, type, sha256);

alter table public.match_documents enable row level security;

create policy "match_documents_select_member" on public.match_documents for select to authenticated
  using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "match_documents_all_club_admin" on public.match_documents for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());
