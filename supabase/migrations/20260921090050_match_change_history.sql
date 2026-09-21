-- Historique des changements détectés sur un match lors d'une synchronisation
-- FFBB (voir ARCHITECTURE.md §9). Un enregistrement par champ modifié.
create table public.match_change_history (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  sync_run_id uuid,
  field_name text not null,
  old_value text,
  new_value text,
  detected_at timestamptz not null default now()
);

comment on table public.match_change_history is
  'Historique des modifications FFBB détectées sur un match (un enregistrement par champ modifié).';

create index match_change_history_match_id_idx on public.match_change_history (match_id);
