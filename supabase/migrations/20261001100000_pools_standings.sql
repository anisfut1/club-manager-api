-- Retour du club, 2026-10-01 : "mettre du coup les résultats qu'on a déjà,
-- par catégorie, et même le classement si on pousse le truc qui est dispo
-- sur FFBB et important quand même".
--
-- Classement FFBB d'une poule (`ffbbserver_poules.classements`), copié tel
-- quel (normalisé, voir NormalizedStandingRow) à chaque synchronisation
-- FFBB. `pools` est un référentiel GLOBAL (partagé entre clubs, RLS
-- inchangée : lecture authentifiée, écriture par la sync uniquement) — le
-- classement d'une poule est le même pour tous les clubs qui y jouent.
alter table public.pools
  add column if not exists standings jsonb,
  add column if not exists standings_updated_at timestamptz;

comment on column public.pools.standings is
  'Classement FFBB de la poule (tableau de lignes normalisées : position, points, joués, gagnés, perdus, paniers...). NULL tant que la sync ne l''a pas récupéré.';
