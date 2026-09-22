import JSZip from "jszip";
import { selectExtractor } from "./select-extractor.js";
import { parseFeuillematch } from "./parse-feuillematch.js";
import { parseResume } from "./parse-resume.js";
import { mergePlayersWithStats } from "./merge.js";
import { computeOverallConfidence, computeQualityWarnings, type QualityCheckContext } from "../quality/compute-quality-warnings.js";
import { emarqueMatchDataSchema } from "../schemas/emarque-match-data.js";
import type { EMarqueMatchData, EMarqueQualityWarning } from "../types.js";

export const PARSER_VERSION = "2026.09.1";

/**
 * Dernière barrière avant retour au code appelant (puis écriture en base) :
 * vérifie uniquement la FORME du résultat produit par le parser. Un échec
 * ici signale un bug du parser (une valeur qui ne respecte pas le contrat
 * EMarqueMatchData), jamais une donnée manquante — celles-ci restent `null`
 * et sont déjà couvertes par les avertissements qualité.
 */
function validateShape(data: EMarqueMatchData): EMarqueMatchData {
  return emarqueMatchDataSchema.parse(data);
}

function findFile(zip: JSZip, prefix: string): JSZip.JSZipObject | null {
  const entry = Object.values(zip.files).find((file) => !file.dir && /^[^/]*\//.test(file.name) === false && file.name.toLowerCase().startsWith(prefix));
  // Certains ZIP peuvent placer les fichiers dans un sous-dossier ; on retombe
  // sur une recherche par simple nom de fichier si rien n'est trouvé à la racine.
  if (entry) return entry;
  return Object.values(zip.files).find((file) => !file.dir && file.name.toLowerCase().includes(`/${prefix}`)) ?? null;
}

/**
 * Parse un ZIP e-Marque V2 complet (feuillematch/resume/positiontir) en
 * EMarqueMatchData. `context` fournit les données FFBB déjà connues du
 * match pour le contrôle qualité (§18/§24) — jamais utilisées pour deviner
 * une valeur manquante, seulement pour comparer.
 */
export async function parseEmarqueZip(zipBuffer: Buffer, context: QualityCheckContext): Promise<EMarqueMatchData> {
  const zip = await JSZip.loadAsync(zipBuffer);

  const feuillematchEntry = findFile(zip, "feuillematch_");
  const resumeEntry = findFile(zip, "resume_");
  const positiontirEntry = findFile(zip, "positiontir_");

  const warnings: EMarqueQualityWarning[] = [];

  if (!feuillematchEntry) {
    warnings.push({
      code: "DOCUMENT_MISSING",
      message: "Aucun document feuillematch_*.pdf trouvé dans le ZIP.",
      severity: "error",
    });
  }

  const emptyMatch: EMarqueMatchData["match"] = {
    rencontreNumero: null,
    competitionLabel: null,
    pouleLabel: null,
    date: null,
    heure: null,
    lieu: null,
    homeTeamName: null,
    awayTeamName: null,
    homeClubCode: null,
    awayClubCode: null,
    scoreHome: null,
    scoreAway: null,
    scoreByPeriod: [],
  };

  if (!feuillematchEntry) {
    return validateShape({
      match: emptyMatch,
      players: [],
      coaches: [],
      officials: [],
      tableOfficials: [],
      playerStats: [],
      shotData: { experimental: true, documentPresent: Boolean(positiontirEntry) },
      quality: { warnings, overallConfidence: null },
    });
  }

  const feuillematchBuffer = Buffer.from(await feuillematchEntry.async("nodebuffer"));
  const feuillematchExtractor = await selectExtractor(feuillematchBuffer);

  let feuillematchResult: Awaited<ReturnType<typeof parseFeuillematch>>;
  try {
    feuillematchResult = await parseFeuillematch(feuillematchExtractor);
  } finally {
    await feuillematchExtractor.dispose();
  }

  let players = feuillematchResult.players;
  let playerStats: EMarqueMatchData["playerStats"] = [];

  if (resumeEntry) {
    const resumeBuffer = Buffer.from(await resumeEntry.async("nodebuffer"));
    const resumeExtractor = await selectExtractor(resumeBuffer);
    try {
      const statsRows = await parseResume(resumeExtractor);
      const merged = mergePlayersWithStats(players, statsRows);
      players = merged.players;
      playerStats = merged.playerStats;
    } finally {
      await resumeExtractor.dispose();
    }
  } else {
    warnings.push({
      code: "DOCUMENT_MISSING",
      message: "Aucun document resume_*.pdf trouvé : statistiques individuelles indisponibles.",
      severity: "warning",
    });
  }

  const match: EMarqueMatchData["match"] = { ...emptyMatch, ...feuillematchResult.matchInfo };

  const dataForQuality = { match, players, tableOfficials: feuillematchResult.tableOfficials };
  warnings.push(...computeQualityWarnings(dataForQuality, context));

  const overallConfidence = computeOverallConfidence([
    ...players.map((p) => p.confidence),
    ...feuillematchResult.tableOfficials.map((o) => o.confidence),
  ]);

  return validateShape({
    match,
    players,
    coaches: feuillematchResult.coaches,
    officials: feuillematchResult.officials,
    tableOfficials: feuillematchResult.tableOfficials,
    playerStats,
    shotData: { experimental: true, documentPresent: Boolean(positiontirEntry) },
    quality: { warnings, overallConfidence },
  });
}
