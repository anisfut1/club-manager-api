-- Réglages techniques de la plateforme, modifiables sans redéploiement Vercel
-- (2026-10-06). Première clé : `fbi_proxy_url` (proxy à IP fixe vers FBI,
-- voir docs/FBI.md). Lecture/écriture service_role UNIQUEMENT : RLS activée
-- sans aucune policy, aucun droit pour anon/authenticated.
create table if not exists public.platform_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;
revoke all on table public.platform_settings from anon, authenticated;
