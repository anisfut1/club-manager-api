-- Signature du serveur/pare-feu devant FBI pour chaque session (noms de
-- cookies, en-têtes d'infrastructure) — jamais de valeur de cookie.
alter table public.fbi_session_traces add column if not exists fingerprint jsonb;
