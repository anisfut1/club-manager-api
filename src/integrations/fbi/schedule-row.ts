import type { FbiScheduleRow } from "./types.js";

/**
 * Colonnes du tableau de résultats `rechercherRencontreSaisieResultat.fbi`,
 * confirmées en production le 2026-09-24/25 (captures d'écran du VRAI FBI,
 * fournies par le club) : "Division | N° | Equipe 1 | Equipe 2 | Date de
 * rencontre | Heure | Salle | EM | Score 1 | Forfait 1". Quelques variantes
 * plausibles (accent, espace) tolérées — jamais un intitulé deviné qui ne
 * viendrait pas d'une capture réelle.
 */
const HEADER_ALIASES: Record<Exclude<keyof FbiScheduleRow, "raw">, string[]> = {
  division: ["Division"],
  numero: ["N°", "N", "N° Rencontre", "Numéro", "Numero"],
  equipe1: ["Equipe 1", "Équipe 1"],
  equipe2: ["Equipe 2", "Équipe 2"],
  dateRencontre: ["Date de rencontre", "Date"],
  heure: ["Heure"],
  salle: ["Salle"],
  em: ["EM"],
  score1: ["Score 1"],
  forfait1: ["Forfait 1"],
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
 * dictionnaire "libellé d'en-tête" → "texte de cellule") en `FbiScheduleRow`
 * typée — fonction PURE, testable sans Playwright ni FBI réel.
 */
export function normalizeScheduleRow(raw: Record<string, string>): FbiScheduleRow {
  return {
    division: lookupHeader(raw, HEADER_ALIASES.division),
    numero: lookupHeader(raw, HEADER_ALIASES.numero),
    equipe1: lookupHeader(raw, HEADER_ALIASES.equipe1),
    equipe2: lookupHeader(raw, HEADER_ALIASES.equipe2),
    dateRencontre: lookupHeader(raw, HEADER_ALIASES.dateRencontre),
    heure: lookupHeader(raw, HEADER_ALIASES.heure),
    salle: lookupHeader(raw, HEADER_ALIASES.salle),
    em: lookupHeader(raw, HEADER_ALIASES.em),
    score1: lookupHeader(raw, HEADER_ALIASES.score1),
    forfait1: lookupHeader(raw, HEADER_ALIASES.forfait1),
    raw,
  };
}
