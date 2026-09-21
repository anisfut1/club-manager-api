-- État de retry/backoff pour la DÉCOUVERTE d'un document e-Marque chez FBI
-- (avant même qu'un fichier existe : "pas encore trouvé côté FBI"). Distinct
-- du cycle de vie d'un fichier une fois trouvé (emarque_imports.next_attempt_at) :
-- ici on ne sait pas encore si/quand FBI publiera le document (ARCHITECTURE.md §20).
alter table public.matches
  add column emarque_discovery_attempt_count integer not null default 0,
  add column emarque_next_discovery_attempt_at timestamptz;

comment on column public.matches.emarque_discovery_attempt_count is
  'Nombre de tentatives de découverte e-Marque effectuées côté FBI pour ce match (voir src/server/jobs/discover-emarque.ts).';
comment on column public.matches.emarque_next_discovery_attempt_at is
  'Prochaine tentative de découverte autorisée (calendrier 30min/2h/6h/24h puis répétition quotidienne). NULL = à tenter dès que possible.';
