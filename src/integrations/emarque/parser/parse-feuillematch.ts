import type { DocumentExtractor, ZoneFraction } from "../extractors/types.js";
import { FEUILLEMATCH_PAGE1, FEUILLEMATCH_ROSTER, OFFICIALS_TABLE_PAGE2 } from "../layout/feuillematch-layout.js";
import { parseFinalResultLine, parsePouleLabel, parseRencontreHeaderLine } from "../normalizers/header-fields.js";
import { extractJerseyNumber, findLicenseMatch, splitUppercaseAbbreviatedName } from "../normalizers/text-fields.js";
import type {
  EMarqueCoach,
  EMarqueMatchInfo,
  EMarqueOfficial,
  EMarquePlayer,
  EMarqueTableOfficial,
  RefereeRole,
  TableOfficialRole,
  TeamSide,
} from "../types.js";

export interface FeuillematchResult {
  matchInfo: Pick<
    EMarqueMatchInfo,
    "rencontreNumero" | "date" | "heure" | "lieu" | "pouleLabel" | "homeTeamName" | "awayTeamName" | "homeClubCode" | "awayClubCode" | "scoreHome" | "scoreAway"
  >;
  players: EMarquePlayer[];
  coaches: EMarqueCoach[];
  officials: EMarqueOfficial[];
  tableOfficials: EMarqueTableOfficial[];
}

function cleanNameFragment(text: string): string {
  return text.replace(/\(CAP\)/i, "").replace(/[^A-Za-zÀ-ÿ.'\- ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Lit l'effectif ET la ligne entraîneur d'une équipe en un seul balayage de
 * lignes. Volontairement tolérant à un décalage de calibration (lignes
 * d'en-tête de tableau sans licence en tout début, lignes vides
 * intercalaires) : on ne s'arrête jamais tant qu'aucun joueur n'a encore été
 * trouvé, et la ligne entraîneur est identifiée par le mot-clé
 * "entraineur", pas par sa position supposée — beaucoup plus robuste qu'un
 * calcul de ligne par index (voir docs/FBI_AUTHENTICATED_SPIKE.md sur la
 * fragilité de la calibration pixel).
 */
async function readTeamRosterAndCoach(
  extractor: DocumentExtractor,
  teamSide: TeamSide,
  rowZone: (row: number) => ZoneFraction,
): Promise<{ players: EMarquePlayer[]; coach: EMarqueCoach | null }> {
  const players: EMarquePlayer[] = [];
  let coach: EMarqueCoach | null = null;
  let consecutiveEmptyAfterFirstPlayer = 0;

  for (let row = 0; row < FEUILLEMATCH_ROSTER.maxRows; row++) {
    const { text, confidence } = await extractor.extractZone(1, rowZone(row));
    const isCoachLine = /entra[iî]neur/i.test(text);
    const match = findLicenseMatch(text);

    if (!match) {
      if (players.length > 0 && !isCoachLine) {
        consecutiveEmptyAfterFirstPlayer += 1;
        if (consecutiveEmptyAfterFirstPlayer >= 5) break; // fin de la section équipe
      }
      continue;
    }
    consecutiveEmptyAfterFirstPlayer = 0;

    const { lastName, firstName } = splitUppercaseAbbreviatedName(cleanNameFragment(match.remainder));

    if (isCoachLine) {
      coach = { teamSide, role: "principal", lastName, firstName, licenseNumber: match.license };
      break; // la ligne entraîneur marque la fin de la section équipe
    }

    players.push({
      teamSide,
      jerseyNumber: extractJerseyNumber(match.remainder),
      lastName,
      firstName,
      licenseNumber: match.license,
      isCaptain: /\(CAP\)/i.test(match.remainder),
      // La case "en jeu" (titulaire) n'est pas dans cette zone : renseignée
      // plus tard depuis le document "résumé" (colonne "5 de départ"),
      // voir parse-resume.ts et parser/merge.ts.
      isStarter: null,
      confidence,
    });
  }

  return { players, coach };
}

async function readOfficialsTable(extractor: DocumentExtractor): Promise<{ officials: EMarqueOfficial[]; tableOfficials: EMarqueTableOfficial[] }> {
  const officials: EMarqueOfficial[] = [];
  const tableOfficials: EMarqueTableOfficial[] = [];

  for (let row = 0; row < OFFICIALS_TABLE_PAGE2.rows.length; row++) {
    const rowConfig = OFFICIALS_TABLE_PAGE2.rows[row];
    if (!rowConfig || rowConfig.kind === "skip") continue;

    const { text, confidence } = await extractor.extractZone(2, OFFICIALS_TABLE_PAGE2.columnZone(row));
    const match = findLicenseMatch(text);
    if (!match) continue; // rôle non pourvu pour ce match (ex: 3e arbitre)

    const { lastName, firstName } = splitUppercaseAbbreviatedName(cleanNameFragment(match.remainder));

    if (rowConfig.kind === "referee") {
      officials.push({ role: rowConfig.role as RefereeRole, lastName, firstName, licenseNumber: match.license });
    } else {
      tableOfficials.push({ role: rowConfig.role as TableOfficialRole, lastName, firstName, licenseNumber: match.license, confidence });
    }
  }

  return { officials, tableOfficials };
}

/**
 * Parse le document feuillematch_*.pdf : en-tête, effectifs, entraîneurs,
 * arbitres et OTM (page 2). Voir docs/FBI_AUTHENTICATED_SPIKE.md pour le
 * niveau de confiance de chaque zone.
 */
export async function parseFeuillematch(extractor: DocumentExtractor): Promise<FeuillematchResult> {
  // Appels SÉQUENTIELS (pas de Promise.all) : un même extracteur partage un
  // rendu de page et un worker OCR uniques (voir PdfRasterOcrExtractor) —
  // des appels concurrents s'y sont révélés source de résultats corrompus
  // pendant le développement (mélange de zones entre appels concurrents).
  const headerLine = await extractor.extractZone(1, FEUILLEMATCH_PAGE1.rencontreLine);
  const pouleLine = await extractor.extractZone(1, FEUILLEMATCH_PAGE1.pouleArbitresLine);
  const teamNamesText = await extractor.extractZone(1, FEUILLEMATCH_PAGE1.teamNames);
  const homeCodeText = await extractor.extractZone(1, FEUILLEMATCH_PAGE1.teamAClubCode);
  const awayCodeText = await extractor.extractZone(1, FEUILLEMATCH_PAGE1.teamBClubCode);
  const finalResultText = await extractor.extractZone(1, FEUILLEMATCH_PAGE1.finalResultLine);

  const header = parseRencontreHeaderLine(headerLine.text);
  const pouleLabel = parsePouleLabel(pouleLine.text);
  const finalResult = parseFinalResultLine(finalResultText.text);

  const teamNameLines = teamNamesText.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const homeTeamName = teamNameLines[0]?.replace(/^équipe\s*a\s*/i, "").trim() ?? null;
  const awayTeamName = teamNameLines[1]?.replace(/^équipe\s*b\s*/i, "").trim() ?? null;

  // Le code club (ex: OCC0034008 = 3 lettres + 7 chiffres) est imprimé case
  // par case ; O/0 sont fréquemment confondus par l'OCR sur le premier
  // caractère (toujours une lettre en réalité).
  const normalizeClubCode = (raw: string): string | null => {
    const digitsAndLetters = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const match = digitsAndLetters.match(/[A-Z0]{3}(\d{7})/);
    if (!match?.[0] || !match[1]) return null;
    const prefix = match[0].slice(0, 3).replace(/0/g, "O");
    return `${prefix}${match[1]}`;
  };

  const homeClubCode = normalizeClubCode(homeCodeText.text);
  const awayClubCode = normalizeClubCode(awayCodeText.text);

  const { players: homeRoster, coach: homeCoach } = await readTeamRosterAndCoach(extractor, "home", FEUILLEMATCH_ROSTER.teamA.columnZone);
  const { players: awayRoster, coach: awayCoach } = await readTeamRosterAndCoach(extractor, "away", FEUILLEMATCH_ROSTER.teamB.columnZone);
  const officialsResult = await readOfficialsTable(extractor);

  return {
    matchInfo: {
      rencontreNumero: header.rencontreNumero,
      date: header.date,
      heure: header.heure,
      lieu: header.lieu,
      pouleLabel,
      homeTeamName,
      awayTeamName,
      homeClubCode,
      awayClubCode,
      scoreHome: finalResult.scoreHome,
      scoreAway: finalResult.scoreAway,
    },
    players: [...homeRoster, ...awayRoster],
    coaches: [homeCoach, awayCoach].filter((c): c is EMarqueCoach => c !== null),
    officials: officialsResult.officials,
    tableOfficials: officialsResult.tableOfficials,
  };
}
