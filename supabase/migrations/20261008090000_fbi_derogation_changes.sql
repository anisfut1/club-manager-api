-- Ce que demande chaque dérogation au-delà de la date/heure (retour du club,
-- 2026-10-08 : "intégrer le changement de salle et inversion de rencontre
-- pour que ce soit 100% fonctionnel"). Cases de la page FBI de la
-- dérogation (ids réels du formulaire afficherDerogation.fbi) ; null = non
-- lu ou case absente de la page, jamais deviné.
alter table public.fbi_derogation_checks
  add column if not exists modifier_date boolean,
  add column if not exists modifier_horaire boolean,
  add column if not exists modifier_salle boolean,
  add column if not exists salle_demandee text,
  add column if not exists inverser_rencontre boolean,
  add column if not exists inverser_equipe boolean,
  -- Détail lu par une version qui sait lire ces cases : sinon la page de
  -- détail est relue une fois (voir process-check-all-derogations.ts).
  add column if not exists changes_read_at timestamptz;
