import type { DocumentExtractor } from "../extractors/types.js";
import { RESUME_STATS_TABLE } from "../layout/resume-layout.js";
import {
  extractJerseyNumber,
  extractTrailingIntegers,
  hasCheckMark,
  parseMinutesSecondsToSeconds,
} from "../normalizers/text-fields.js";
import type { EMarquePlayerStat, TeamSide } from "../types.js";

const STAT_COLUMN_COUNT = 7; // Pts, Tirs, 3pts, 2Int, 2Ext, LF, Fautes

export interface ResumeRowResult extends EMarquePlayerStat {
  isStarter: boolean;
}

async function readTeamStats(
  extractor: DocumentExtractor,
  teamSide: TeamSide,
  config: { rowTop: number; rowHeight: number; columnZone: (row: number) => import("../extractors/types.js").ZoneFraction },
): Promise<ResumeRowResult[]> {
  const rows: ResumeRowResult[] = [];
  let consecutiveUnreadable = 0;

  for (let row = 0; row < RESUME_STATS_TABLE.maxRows; row++) {
    const { text } = await extractor.extractZone(1, config.columnZone(row));

    if (RESUME_STATS_TABLE.stopTextPattern.test(text)) break;

    const jerseyNumber = extractJerseyNumber(text);
    const timeMatch = text.match(/\d{1,3}:\d{2}/);
    const secondsPlayed = timeMatch ? parseMinutesSecondsToSeconds(timeMatch[0]) : null;
    const stats = extractTrailingIntegers(text, STAT_COLUMN_COUNT);

    // Une ligne "réelle" a un maillot ET au moins un autre signal (temps de
    // jeu ou statistiques) — un maillot isolé sans rien d'autre est très
    // probablement un artefact OCR sur une ligne vide du tableau (bordures
    // de cellule mal interprétées), pas un vrai joueur.
    if (!jerseyNumber || (secondsPlayed === null && stats === null)) {
      if (rows.length > 0) {
        consecutiveUnreadable += 1;
        if (consecutiveUnreadable >= 2) break;
      }
      continue;
    }
    consecutiveUnreadable = 0;

    rows.push({
      teamSide,
      jerseyNumber,
      lastName: null,
      firstName: null,
      isStarter: hasCheckMark(text.split(jerseyNumber)[1]?.slice(0, 20) ?? ""),
      secondsPlayed,
      points: stats?.[0] ?? null,
      shotsMade: stats?.[1] ?? null,
      threePointsMade: stats?.[2] ?? null,
      twoPointsInteriorMade: stats?.[3] ?? null,
      twoPointsExteriorMade: stats?.[4] ?? null,
      freeThrowsMade: stats?.[5] ?? null,
      foulsCommitted: stats?.[6] ?? null,
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
