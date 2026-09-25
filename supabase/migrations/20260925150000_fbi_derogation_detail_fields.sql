-- =============================================================================
-- Détail d'une dérogation (page afficherDerogation.fbi) — demande du club,
-- 2026-09-25 : "il me faut du détail sur le motif, le pk du comment, les
-- dates initiales et demandées etc (comme sur fbi)". Les dates/heure
-- INITIALES sont déjà `date_rencontre`/`heure` (tableau de résultats,
-- migration précédente) — ces colonnes-ci ne portent que ce qui n'existe
-- QUE sur la page de détail : la date/heure DEMANDÉE, le motif, et la
-- réponse de l'adversaire. Toujours en LECTURE SEULE (voir migration
-- 20260925130000) : ces colonnes journalisent un état déjà connu par FBI,
-- jamais une soumission/modification.
-- =============================================================================

alter table public.fbi_derogation_checks
  add column demandeur text,
  add column motif text,
  add column date_rencontre_demandee text,
  add column heure_demandee text,
  add column adversaire text,
  add column date_reponse text,
  add column acceptation text,
  add column motif_refus text;

comment on column public.fbi_derogation_checks.date_rencontre_demandee is
  'Date de rencontre DEMANDÉE par la dérogation (section "Demande de dérogation" de afficherDerogation.fbi) — distincte de date_rencontre, qui reste la date INITIALE (tableau de résultats).';
comment on column public.fbi_derogation_checks.heure_demandee is
  'Heure DEMANDÉE par la dérogation — distincte de heure (INITIALE).';
