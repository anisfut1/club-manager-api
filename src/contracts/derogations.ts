import { z } from "./zod.js";

/**
 * Dernier état CONNU (via FBI, `rechercherDerogation.fbi`) de la
 * dérogation d'un match — LECTURE SEULE (demande du club, voir
 * docs/FBI.md : "faut qu'on gere les derog depuis l'outil", phase 1
 * volontairement limitée à la consultation). Toutes les valeurs restent au
 * format BRUT FBI (texte), jamais parsées — le format exact n'a été
 * observé que sur une capture d'écran, pas confirmé pour tous les états.
 *
 * `demandeur`/`motif`/`dateRencontreDemandee`/`heureDemandee`/`adversaire`/
 * `dateReponse`/`acceptation`/`motifRefus` viennent de la page de DÉTAIL
 * (`afficherDerogation.fbi`), pas du tableau de résultats — demande du
 * club, 2026-09-25 : "il me faut du détail sur le motif... les dates
 * initiales et demandées... comme sur fbi". `dateRencontre`/`heure`
 * restent les valeurs INITIALES (tableau de résultats), `null` quand la
 * page de détail n'a jamais pu être ouverte (best effort, voir
 * BrowserFbiClient).
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
    demandeur: z.string().nullable(),
    motif: z.string().nullable(),
    dateRencontreDemandee: z.string().nullable(),
    heureDemandee: z.string().nullable(),
    adversaire: z.string().nullable(),
    dateReponse: z.string().nullable(),
    acceptation: z.string().nullable(),
    motifRefus: z.string().nullable(),
    checkedAt: z.string(),
  })
  .openapi("DerogationStatusDto");

export type DerogationStatusDto = z.infer<typeof DerogationStatusDtoSchema>;

/**
 * Une ligne de `GET /v1/clubs/:clubId/derogations` — TOUTES les
 * dérogations connues du club en une fois (demande du club : "je veux un
 * bouton global qui check toutes les demandes, pas match par match"),
 * `DerogationStatusDto` enrichi du match FFBB correspondant pour pouvoir
 * lier vers sa fiche.
 */
export const DerogationListItemDtoSchema = DerogationStatusDtoSchema.extend({
  /**
   * Identifiant de CETTE ligne `fbi_derogation_checks` — jamais `matchId`
   * comme clé (§ "82 vs 51", docs/FBI.md, 2026-09-27) : une rencontre peut
   * légitimement avoir PLUSIEURS dérogations distinctes, `matchId` seul ne
   * les distingue pas.
   */
  id: z.string().uuid(),
  matchId: z.string().uuid(),
  opponentName: z.string().nullable(),
  matchDatetime: z.string().nullable(),
  /**
   * Catégorie FFBB lisible du match concerné (`competitions.category_label`,
   * ex. "U13", "Seniors") — demande du club, 2026-09-26 : "jaimerais quon
   * rajoute la catégorie concernée sur les derog". Distincte du code de
   * division FBI brut (`competitions.code`, ex. "BU13FN23") utilisé en
   * interne pour désambiguïser les numéros de rencontre.
   */
  categoryLabel: z.string().nullable(),
  /**
   * Nom de L'ÉQUIPE DU CLUB engagée sur ce match (`teams.name`, ex.
   * "Seniors 1 M", "Seniors 2", "U13 1") — demande du club, 2026-09-26 :
   * "faut préciser quelle équipe, seniors ya 4 equipes SM1 SM2 SM3 SF,
   * pareil sur dautres catégories" : `categoryLabel` seul ("Seniors") ne
   * distingue pas les 4 équipes seniors du club entre elles, `teamName` si.
   */
  teamName: z.string().nullable(),
}).openapi("DerogationListItemDto");

export type DerogationListItemDto = z.infer<typeof DerogationListItemDtoSchema>;
