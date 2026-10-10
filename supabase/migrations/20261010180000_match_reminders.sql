-- Relance en un clic des « sans réponse » (retour du club, 2026-10-10).
-- Pas d'email / push en V1 : la relance est marquée et affichée sur la Home
-- des familles concernées (« Le coach attend ta réponse »).
alter table public.match_availability_requests add column if not exists reminded_at timestamptz;
alter table public.match_convocations add column if not exists reminded_at timestamptz;
