-- Diagnostic de la lecture des licences (feuillematch, équipe A, 2026-10-07) :
-- image de la zone licence de chaque ligne + texte OCR par gabarit de colonnes,
-- exportés par ops/emarque-debug/license-cells.ts (poste du club). Service
-- uniquement (RLS sans politique) ; à vider après analyse.
create table if not exists public.emarque_debug_cells (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null,
  team text not null,
  row_index integer not null,
  row_top double precision not null,
  row_bottom double precision not null,
  results jsonb not null,
  png_base64 text,
  created_at timestamptz not null default now()
);
alter table public.emarque_debug_cells enable row level security;
