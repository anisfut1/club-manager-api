-- Un enregistrement par document e-Marque découvert/téléchargé/traité pour
-- un match. `file_hash` (SHA-256 du ZIP) garantit l'idempotence : si FBI
-- renvoie exactement le même fichier, il n'est pas re-parsé (voir
-- src/server/emarque). `next_attempt_at` porte le retry/backoff (le ZIP
-- peut apparaître plusieurs heures après la fin du match).
create table public.emarque_imports (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  source text not null default 'fbi' check (source in ('fbi')),
  file_hash text unique,
  source_file_name text,
  storage_path text,
  status text not null default 'discovered'
    check (status in ('discovered', 'downloading', 'downloaded', 'parsing', 'imported', 'error', 'needs_review')),
  parser_version text,
  quality_warnings jsonb not null default '[]'::jsonb,
  discovered_at timestamptz not null default now(),
  downloaded_at timestamptz,
  imported_at timestamptz,
  last_error text,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.emarque_imports is
  'Cycle de vie d''un document e-Marque pour un match : découverte FBI, téléchargement, statut de parsing, avertissements qualité.';
comment on column public.emarque_imports.file_hash is
  'SHA-256 du ZIP téléchargé. UNIQUE : un fichier identique n''est jamais re-traité.';
comment on column public.emarque_imports.quality_warnings is
  'Liste de codes d''avertissement (ex: SCORE_MISMATCH, OTM_LICENSE_MISSING) — voir src/server/emarque/quality. Un avertissement ne fait pas nécessairement échouer l''import.';

create index emarque_imports_match_id_idx on public.emarque_imports (match_id);
create index emarque_imports_retry_idx on public.emarque_imports (status, next_attempt_at)
  where status in ('discovered', 'error');
