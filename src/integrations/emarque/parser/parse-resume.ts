import type { DocumentExtractor } from "../extractors/types.js";
import { locateTeamTables } from "../layout/table-structure.js";
import { RESUME_HEADER_GAP_FRACTION_RANGE, RESUME_MAX_ROWS_PER_TEAM, RESUME_TABLE_SCAN_ZONE, resumeCellZone, type ResumeStatColumn } from "../layout/resume-layout.js";
import {
  extractJerseyNumber,
  extractSingleInteger,
  hasCheckMark,
  parseMinutesSecondsToSeconds,
  splitCommaSeparatedName,
} from "../normalizers/text-fields.js";
import type { EMarquePlayerStat, TeamSide } from "../types.js";

export interface ResumeRowResult extends EMarquePlayerStat {
  isStarter: boolean;
}

/**
 * Lit chaque colonne d'une ligne SÉPARÉMENT (voir `resume-layout.ts` et
 * `extractSingleInteger`) plutôt que la ligne entière en un seul appel OCR
 * suivi d'une tentative de découpage par regex — corrigé en production le
 * 2026-09-24 (rencontre n°1481, § "Trente-et-unième déclenchement",
 * docs/FBI.md) après avoir constaté qu'un seul chiffre mal lu N'IMPORTE OÙ
 * dans la ligne entière (le numéro de maillot, le temps de jeu "23:35" qui
 * contribue déjà deux entiers parasites...) décalait TOUTES les statistiques
 * de la ligne, silencieusement. Chaque cellule isolée ne peut plus affecter
 * que sa propre valeur.
 */
async function readRow(extractor: DocumentExtractor, rowTop: number, rowBottom: number): Promise<{ jerseyNumber: string | null }> {
  const { text } = await extractor.extractZone(1, resumeCellZone(rowTop, rowBottom, "jerseyNumber"), { expectDigitsOnly: true });
  return { jerseyNumber: extractJerseyNumber(text) };
}

async function readTeamStats(extractor: DocumentExtractor, teamSide: TeamSide, rowBoundaries: number[]): Promise<ResumeRowResult[]> {
  const rows: ResumeRowResult[] = [];
  let consecutiveUnreadable = 0;

  for (let row = 0; row < rowBoundaries.length - 1 && row < RESUME_MAX_ROWS_PER_TEAM; row++) {
    const rowTop = rowBoundaries[row]!;
    const rowBottom = rowBoundaries[row + 1]!;

    // Le numéro de maillot sert de "porte d'entrée" : une ligne vide du
    // gabarit (lignes de réserve non utilisées par ce match, voir le
    // document réel) ou une ligne de synthèse ("Total Équipe"...) n'a pas
    // de numéro de maillot valide — inutile de payer le coût des 10 autres
    // appels OCR de cette ligne dans ce cas.
    const { jerseyNumber } = await readRow(extractor, rowTop, rowBottom);

    if (!jerseyNumber) {
      if (rows.length > 0) {
        consecutiveUnreadable += 1;
        if (consecutiveUnreadable >= 2) break;
      }
      continue;
    }
    consecutiveUnreadable = 0;

    // Appels SÉQUENTIELS (jamais Promise.all) : voir le commentaire
    // équivalent dans parse-feuillematch.ts — un même extracteur partage un
    // rendu de page et un worker OCR uniques (PdfRasterOcrExtractor), des
    // appels concurrents s'y sont révélés source de résultats corrompus
    // pendant le développement (mélange de zones entre appels concurrents).
    const zone = (column: ResumeStatColumn) => resumeCellZone(rowTop, rowBottom, column);
    const nameText = (await extractor.extractZone(1, zone("name"))).text;
    const starterText = (await extractor.extractZone(1, zone("starter"))).text;
    const timeText = (await extractor.extractZone(1, zone("secondsPlayed"), { expectDigitsOnly: true })).text;
    const pointsText = (await extractor.extractZone(1, zone("points"), { expectDigitsOnly: true })).text;
    const shotsMadeText = (await extractor.extractZone(1, zone("shotsMade"), { expectDigitsOnly: true })).text;
    const threePointsText = (await extractor.extractZone(1, zone("threePointsMade"), { expectDigitsOnly: true })).text;
    const twoIntText = (await extractor.extractZone(1, zone("twoPointsInteriorMade"), { expectDigitsOnly: true })).text;
    const twoExtText = (await extractor.extractZone(1, zone("twoPointsExteriorMade"), { expectDigitsOnly: true })).text;
    const freeThrowsText = (await extractor.extractZone(1, zone("freeThrowsMade"), { expectDigitsOnly: true })).text;
    const foulsText = (await extractor.extractZone(1, zone("foulsCommitted"), { expectDigitsOnly: true })).text;

    const { lastName, firstName } = splitCommaSeparatedName(nameText);
    const timeMatch = timeText.match(/\d{1,3}:\d{2}/);

    rows.push({
      teamSide,
      jerseyNumber,
      lastName,
      firstName,
      isStarter: hasCheckMark(starterText),
      secondsPlayed: timeMatch ? parseMinutesSecondsToSeconds(timeMatch[0]) : null,
      points: extractSingleInteger(pointsText),
      shotsMade: extractSingleInteger(shotsMadeText),
      threePointsMade: extractSingleInteger(threePointsText),
      twoPointsInteriorMade: extractSingleInteger(twoIntText),
      twoPointsExteriorMade: extractSingleInteger(twoExtText),
      freeThrowsMade: extractSingleInteger(freeThrowsText),
      foulsCommitted: extractSingleInteger(foulsText),
    });
  }

  return rows;
}

/**
 * Parse le document resume_*.pdf : statistiques individuelles par joueur.
 *
 * La position de chaque tableau (LOCAUX/VISITEURS) est détectée
 * DYNAMIQUEMENT sur CE document (voir `table-structure.ts`) plutôt que
 * supposée à une position fixe — retour du club, 2026-09-29 : un document
 * réel à 12 joueurs LOCAUX (l'échantillon de calibrage en avait 8) décalait
 * entièrement la lecture de l'équipe VISITEURS, dont la position dépend du
 * nombre de lignes LOCAUX au-dessus.
 */
export async function parseResume(extractor: DocumentExtractor): Promise<ResumeRowResult[]> {
  const lines = await extractor.detectHorizontalLines(1, RESUME_TABLE_SCAN_ZONE);
  const tables = locateTeamTables(lines, RESUME_HEADER_GAP_FRACTION_RANGE);

  // Structure du document non reconnue (moins de 2 tableaux détectés) :
  // jamais deviner une position (ARCHITECTURE.md §22), retourner vide plutôt
  // qu'une lecture au hasard — remonte comme avertissement qualité côté
  // `persist-emarque-match.ts` (aucune statistique liée à aucun joueur).
  if (tables.length < 2) return [];

  // Séquentiel, pas Promise.all : voir le commentaire équivalent dans
  // parse-feuillematch.ts (extracteur/worker OCR partagés).
  const home = await readTeamStats(extractor, "home", tables[0]!.rowBoundaries);
  const away = await readTeamStats(extractor, "away", tables[1]!.rowBoundaries);

  return [...home, ...away];
}
