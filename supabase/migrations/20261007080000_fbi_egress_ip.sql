-- Adresse IP de sortie de l'API (Vercel) à chaque contrôle de joignabilité
-- FBI (2026-10-07) : vérifie si les coupures FBI suivent l'adresse (même
-- adresse réutilisée d'un passage à l'autre depuis la région Paris).
alter table public.fbi_reachability_checks add column if not exists egress_ip text;
