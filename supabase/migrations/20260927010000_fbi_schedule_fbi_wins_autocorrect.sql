-- =============================================================================
-- Revirement du 2026-09-27 : le club a explicitement demandé que FBI
-- l'EMPORTE sur FFBB en cas d'écart de date/heure OU de salle ("FBI doit
-- emporter sur FFBB car les vraies infos proviennent de FBI") — contrairement
-- à la décision d'origine (20260925120000_fbi_schedule_reconciliation.sql :
-- "FFBB reste la seule source ÉCRITE dans matches... jamais une écriture
-- automatique"). `missing_in_ffbb`/`missing_in_fbi` restent des anomalies
-- MANUELLES (FBI seul n'a pas assez d'information pour créer/compléter un
-- match) — voir schedule-reconciliation.ts/process-reconcile-schedule.ts.
--
-- `auto_corrected_at` distingue une anomalie "mismatch" résolue parce que
-- `processReconcileScheduleJob` vient d'appliquer la correction FBI, d'une
-- anomalie simplement résolue parce qu'elle ne se reproduit plus
-- (`resolved_at` seul, mécanisme déjà existant) — nécessaire pour que la
-- page Anomalies puisse continuer à montrer "corrigée automatiquement"
-- (demande du club) au lieu de la faire disparaître silencieusement comme
-- n'importe quelle autre anomalie résolue.
-- =============================================================================

alter table public.fbi_schedule_discrepancies
  add column auto_corrected_at timestamptz;

comment on column public.fbi_schedule_discrepancies.auto_corrected_at is
  'Renseigné UNIQUEMENT quand processReconcileScheduleJob vient de réécrire matches avec la valeur FBI (kind=mismatch, voir ScheduleDiscrepancyCorrection) — jamais pour missing_in_ffbb/missing_in_fbi. Toujours accompagné de resolved_at (même valeur) : l''anomalie est résolue PARCE QU''elle vient d''être corrigée automatiquement, pas parce qu''elle a cessé de se reproduire.';

comment on table public.fbi_schedule_discrepancies is
  'Anomalies détectées entre le calendrier synchronisé FFBB (matches) et le calendrier FBI du club (rechercherRencontreSaisieResultat.fbi), pour les clubs ayant FBI configuré. Pour kind=mismatch (date/heure, salle), FBI l''EMPORTE désormais sur FFBB : la correction est appliquée automatiquement sur matches (voir auto_corrected_at) — décision du club, 2026-09-27, "FBI doit emporter sur FFBB car les vraies infos proviennent de FBI". missing_in_ffbb/missing_in_fbi restent des anomalies à traiter MANUELLEMENT (FBI seul n''a pas assez d''information pour créer/compléter un match).';
