import type { DocumentExtractor } from "../extractors/types.js";
import { RESUME_STATS_TABLE } from "../layout/resume-layout.js";
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

interface TeamConfig {
  rowTop: number;
  rowHeight: number;
  cellZone: (row: number, column: import("../layout/resume-layout.js").ResumeStatColumn) => import("../extractors/types.js").ZoneFraction;
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
async function readRow(extractor: DocumentExtractor, team: TeamConfig, row: number): Promise<{ jerseyText: string; jerseyNumber: string | null }> {
  const { text } = await extractor.extractZone(1, team.cellZone(row, "jerseyNumber"), { expectDigitsOnly: true });
  return { jerseyText: text, jerseyNumber: extractJerseyNumber(text) };
}

async function readTeamStats(extractor: DocumentExtractor, teamSide: TeamSide, team: TeamConfig): Promise<ResumeRowResult[]> {
  const rows: ResumeRowResult[] = [];
  let consecutiveUnreadable = 0;

  for (let row = 0; row < RESUME_STATS_TABLE.maxRows; row++) {
    // Le numéro de maillot sert de "porte d'entrée" : une ligne vide du
    // gabarit (lignes de réserve non utilisées par ce match, voir le
    // document réel) ou une ligne de synthèse ("Total Équipe"...) n'a pas
    // de numéro de maillot valide — inutile de payer le coût des 10 autres
    // appels OCR de cette ligne dans ce cas.
    const { jerseyNumber } = await readRow(extractor, team, row);

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
    const nameText = (await extractor.extractZone(1, team.cellZone(row, "name"))).text;
    const starterText = (await extractor.extractZone(1, team.cellZone(row, "starter"))).text;
    const timeText = (await extractor.extractZone(1, team.cellZone(row, "secondsPlayed"), { expectDigitsOnly: true })).text;
    const pointsText = (await extractor.extractZone(1, team.cellZone(row, "points"), { expectDigitsOnly: true })).text;
    const shotsMadeText = (await extractor.extractZone(1, team.cellZone(row, "shotsMade"), { expectDigitsOnly: true })).text;
    const threePointsText = (await extractor.extractZone(1, team.cellZone(row, "threePointsMade"), { expectDigitsOnly: true })).text;
    const twoIntText = (await extractor.extractZone(1, team.cellZone(row, "twoPointsInteriorMade"), { expectDigitsOnly: true })).text;
    const twoExtText = (await extractor.extractZone(1, team.cellZone(row, "twoPointsExteriorMade"), { expectDigitsOnly: true })).text;
    const freeThrowsText = (await extractor.extractZone(1, team.cellZone(row, "freeThrowsMade"), { expectDigitsOnly: true })).text;
    const foulsText = (await extractor.extractZone(1, team.cellZone(row, "foulsCommitted"), { expectDigitsOnly: true })).text;

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

/** Parse le document resume_*.pdf : statistiques individuelles par joueur. */
export async function parseResume(extractor: DocumentExtractor): Promise<ResumeRowResult[]> {
  // Séquentiel, pas Promise.all : voir le commentaire équivalent dans
  // parse-feuillematch.ts (extracteur/worker OCR partagés).
  const home = await readTeamStats(extractor, "home", RESUME_STATS_TABLE.teamA);
  const away = await readTeamStats(extractor, "away", RESUME_STATS_TABLE.teamB);

  return [...home, ...away];
}
