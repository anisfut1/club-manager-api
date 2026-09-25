import type { DocumentExtractor, ZoneFraction } from "../extractors/types.js";
import { FEUILLEMATCH_PAGE1, FEUILLEMATCH_ROSTER, OFFICIALS_TABLE_PAGE2, type RosterColumn } from "../layout/feuillematch-layout.js";
import { parseFinalResultLine, parsePouleLabel, parseRencontreHeaderLine } from "../normalizers/header-fields.js";
import { extractIsolatedLicenseNumber, extractJerseyNumber, extractLicenseNumber, findLicenseMatch, splitUppercaseAbbreviatedName } from "../normalizers/text-fields.js";
import type {
  CoachRole,
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

/** "Entraineur Principal: TOUR DE WILDEMAN L." -> "TOUR DE WILDEMAN L." — jamais le mot-clé lui-même dans le nom. */
function stripCoachRolePrefix(text: string): string {
  return text.replace(/^.*?entra[iî]neur\s*(principal|adjoint)?\s*:?/i, "");
}

/**
 * Lit chaque colonne d'une ligne SÉPARÉMENT (licence, nom, maillot) plutôt
 * que la ligne entière en un seul appel OCR suivi d'un découpage par regex
 * — corrigé en production le 2026-09-25 (rencontre n°1481, § "Trente-
 * quatrième déclenchement", docs/FBI.md), même classe de bug déjà
 * rencontrée et corrigée sur le document "résumé" (§ "Trente-et-unième
 * déclenchement") : un chiffre ou caractère mal lu n'importe où dans la
 * ligne entière risquait de décaler TOUTES ses valeurs.
 *
 * La colonne LICENCE sert de "porte d'entrée" (comme le maillot dans
 * `parse-resume.ts`) : une ligne vide du gabarit n'a pas de licence valide
 * — inutile de payer le coût des autres colonnes dans ce cas. On ne
 * s'arrête JAMAIS sur un nombre de lignes vides consécutives : les lignes
 * "Entraineur Principal"/"1er Entraineur adjoint" sont précédées de
 * plusieurs lignes vides du gabarit (5 à 6 sur l'échantillon réel) — un
 * seuil bas les aurait fait manquer entièrement. Le nombre fixe
 * `FEUILLEMATCH_ROSTER.maxRows` reste l'unique filet de sécurité.
 *
 * Jamais de `break` sur la première ligne entraîneur trouvée (bug
 * silencieux de l'ancienne version : le rôle "adjoint", sur la ligne
 * suivante, n'était alors jamais atteint) — les deux rôles sont collectés
 * séparément, distingués par le mot-clé "principal"/"adjoint" présent
 * dans la cellule elle-même.
 */
async function readTeamRosterAndCoaches(
  extractor: DocumentExtractor,
  teamSide: TeamSide,
  team: { cellZone: (row: number, column: RosterColumn) => ZoneFraction; licenseNumberWideZone: (row: number) => ZoneFraction },
): Promise<{ players: EMarquePlayer[]; coaches: EMarqueCoach[] }> {
  const players: EMarquePlayer[] = [];
  const coaches: EMarqueCoach[] = [];

  for (let row = 0; row < FEUILLEMATCH_ROSTER.maxRows; row++) {
    const licenseText = (await extractor.extractZone(1, team.cellZone(row, "licenseNumber"))).text;
    let licenseNumber = extractIsolatedLicenseNumber(licenseText);

    const { text: nameText, confidence } = await extractor.extractZone(1, team.cellZone(row, "name"));
    const coachRoleMatch = nameText.match(/entra[iî]neur\s*(principal|adjoint)?/i);

    // Repli UNIQUEMENT pour une ligne entraîneur (voir
    // `licenseNumberWideZone`) : la colonne "type/surclassement", vide sur
    // ce type de ligne, n'y est pas séparée par un filet, donc la borne
    // étroite ci-dessus tronque systématiquement le préfixe lettre du
    // numéro de licence — jamais utilisé pour un joueur (où cette colonne
    // contient un vrai marqueur, contaminerait la lecture).
    if (!licenseNumber && coachRoleMatch) {
      const wideLicenseText = (await extractor.extractZone(1, team.licenseNumberWideZone(row))).text;
      licenseNumber = extractLicenseNumber(wideLicenseText);
    }

    if (!licenseNumber) continue;

    if (coachRoleMatch) {
      const role: CoachRole = /adjoint/i.test(coachRoleMatch[0]) ? "adjoint" : "principal";
      const { lastName, firstName } = splitUppercaseAbbreviatedName(cleanNameFragment(stripCoachRolePrefix(nameText)));
      coaches.push({ teamSide, role, lastName, firstName, licenseNumber });
      continue;
    }

    const jerseyText = (await extractor.extractZone(1, team.cellZone(row, "jerseyNumber"), { expectDigitsOnly: true })).text;
    const { lastName, firstName } = splitUppercaseAbbreviatedName(cleanNameFragment(nameText));

    players.push({
      teamSide,
      jerseyNumber: extractJerseyNumber(jerseyText),
      lastName,
      firstName,
      licenseNumber,
      isCaptain: /\(CAP\)/i.test(nameText),
      // La case "en jeu" (titulaire) n'est pas dans cette zone : renseignée
      // plus tard depuis le document "résumé" (colonne "5 de départ"),
      // voir parse-resume.ts et parser/merge.ts.
      isStarter: null,
      confidence,
    });
  }

  return { players, coaches };
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

  const { players: homeRoster, coaches: homeCoaches } = await readTeamRosterAndCoaches(extractor, "home", FEUILLEMATCH_ROSTER.teamA);
  const { players: awayRoster, coaches: awayCoaches } = await readTeamRosterAndCoaches(extractor, "away", FEUILLEMATCH_ROSTER.teamB);
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
    coaches: [...homeCoaches, ...awayCoaches],
    officials: officialsResult.officials,
    tableOfficials: officialsResult.tableOfficials,
  };
}
