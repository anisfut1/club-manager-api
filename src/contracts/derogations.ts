import { z } from "./zod.js";

/**
 * Dernier état CONNU (via FBI, `rechercherDerogation.fbi`) de la
 * dérogation d'un match — LECTURE SEULE (demande du club, voir
 * docs/FBI.md : "faut qu'on gere les derog depuis l'outil", phase 1
 * volontairement limitée à la consultation). Toutes les valeurs restent au
 * format BRUT FBI (texte), jamais parsées — le format exact n'a été
 * observé que sur une capture d'écran, pas confirmé pour tous les états.
 */
export const DerogationStatusDtoSchema = z
  .object({
    numero: z.string().nullable(),
    etat: z.string().nullable(),
    dateDepot: z.string().nullable(),
    dateDerogation: z.string().nullable(),
    dateRencontre: z.string().nullable(),
    heure: z.string().nullable(),
    domicile: z.string().nullable(),
    visiteur: z.string().nullable(),
    checkedAt: z.string(),
  })
  .openapi("DerogationStatusDto");

export type DerogationStatusDto = z.infer<typeof DerogationStatusDtoSchema>;
