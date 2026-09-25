import type { FbiDerogationDetailFields, FbiDerogationRow } from "./types.js";

/**
 * Colonnes du tableau de résultats `rechercherDerogation.fbi`, confirmées
 * par capture d'écran du VRAI FBI le 2026-09-25 : "Date de dépôt | N° Renc
 * | Division | Domicile | Visiteur | Date rencontre | Heure | Date déro |
 * Etat de la dérogation". Quelques variantes plausibles tolérées — jamais
 * un intitulé deviné qui ne viendrait pas d'une capture réelle. Exclut les
 * champs de `FbiDerogationDetailFields` : ce tableau ne les contient
 * jamais, ils viennent uniquement de la page de détail (voir
 * `normalizeDerogationRow`).
 */
const HEADER_ALIASES: Record<Exclude<keyof FbiDerogationRow, "raw" | keyof FbiDerogationDetailFields>, string[]> = {
  numero: ["N° Renc", "N°", "N° Rencontre", "Numéro"],
  division: ["Division"],
  domicile: ["Domicile"],
  visiteur: ["Visiteur"],
  dateRencontre: ["Date rencontre", "Date de rencontre"],
  heure: ["Heure"],
  dateDepot: ["Date de dépôt", "Date depot"],
  dateDerogation: ["Date déro", "Date dérogation", "Date de dérogation"],
  etat: ["Etat de la dérogation", "État de la dérogation", "Etat"],
};

function lookupHeader(raw: Record<string, string>, aliases: string[]): string | null {
  for (const alias of aliases) {
    if (!(alias in raw)) continue;
    const value = raw[alias].trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Convertit une ligne générique (`selectors.resultsTableGenericRows`,
 * dictionnaire "libellé d'en-tête" → "texte de cellule") en
 * `FbiDerogationRow` typée — fonction PURE, testable sans Playwright ni
 * FBI réel.
 */
/**
 * Champs de détail (`FbiDerogationDetailFields`) à `null` par défaut — ce
 * tableau de résultats ne les contient jamais, ils ne sont connus qu'après
 * un passage par la page de détail (voir `BrowserFbiClient`,
 * `extractDerogationDetailFields`).
 */
export function normalizeDerogationRow(raw: Record<string, string>): FbiDerogationRow {
  return {
    numero: lookupHeader(raw, HEADER_ALIASES.numero),
    division: lookupHeader(raw, HEADER_ALIASES.division),
    domicile: lookupHeader(raw, HEADER_ALIASES.domicile),
    visiteur: lookupHeader(raw, HEADER_ALIASES.visiteur),
    dateRencontre: lookupHeader(raw, HEADER_ALIASES.dateRencontre),
    heure: lookupHeader(raw, HEADER_ALIASES.heure),
    dateDepot: lookupHeader(raw, HEADER_ALIASES.dateDepot),
    dateDerogation: lookupHeader(raw, HEADER_ALIASES.dateDerogation),
    etat: lookupHeader(raw, HEADER_ALIASES.etat),
    demandeur: null,
    motif: null,
    dateRencontreDemandee: null,
    heureDemandee: null,
    adversaire: null,
    dateReponse: null,
    acceptation: null,
    motifRefus: null,
    raw,
  };
}
