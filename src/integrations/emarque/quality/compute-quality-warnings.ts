import type { EMarqueMatchData, EMarqueQualityWarning } from "../types.js";

const LOW_CONFIDENCE_THRESHOLD = 40;

export interface QualityCheckContext {
  ffbbMatchNumero: string | null;
  ffbbScoreHome: number | null;
  ffbbScoreAway: number | null;
}

/**
 * Compare l'extraction e-Marque aux données FFBB déjà connues, et signale
 * les zones d'incertitude. Un avertissement n'échoue jamais l'import à lui
 * seul (ARCHITECTURE.md §24) — c'est à l'appelant de décider, en général en
 * passant le match en `needs_review` uniquement pour les avertissements de
 * sévérité "error".
 */
export function computeQualityWarnings(
  data: Pick<EMarqueMatchData, "match" | "players" | "tableOfficials">,
  context: QualityCheckContext,
): EMarqueQualityWarning[] {
  const warnings: EMarqueQualityWarning[] = [];

  if (context.ffbbMatchNumero && data.match.rencontreNumero && context.ffbbMatchNumero !== data.match.rencontreNumero) {
    warnings.push({
      code: "MATCH_NUMBER_MISMATCH",
      message: `Numéro de rencontre e-Marque (${data.match.rencontreNumero}) différent de celui connu côté FFBB (${context.ffbbMatchNumero}).`,
      severity: "error",
    });
  }

  const scoreHomeKnown = context.ffbbScoreHome !== null && data.match.scoreHome !== null;
  if (scoreHomeKnown && context.ffbbScoreHome !== data.match.scoreHome) {
    warnings.push({
      code: "SCORE_MISMATCH",
      message: `Score domicile e-Marque (${data.match.scoreHome}) différent du score FFBB (${context.ffbbScoreHome}).`,
      severity: "error",
    });
  }

  const scoreAwayKnown = context.ffbbScoreAway !== null && data.match.scoreAway !== null;
  if (scoreAwayKnown && context.ffbbScoreAway !== data.match.scoreAway) {
    warnings.push({
      code: "SCORE_MISMATCH",
      message: `Score extérieur e-Marque (${data.match.scoreAway}) différent du score FFBB (${context.ffbbScoreAway}).`,
      severity: "error",
    });
  }

  // Retour du club, 2026-09-29 : un document dont la structure du tableau
  // n'est pas reconnue (voir `table-structure.ts`) retourne désormais un
  // effectif VIDE plutôt qu'une lecture au hasard (ARCHITECTURE.md §22) —
  // sans ce signal, un tel échec silencieux passerait pour un import
  // "réussi" sans aucun joueur, jamais renvoyé en `needs_review`.
  if (data.players.length === 0) {
    warnings.push({
      code: "NO_PLAYERS_EXTRACTED",
      message: "Aucun joueur extrait du document — structure du tableau non reconnue, jamais une lecture au hasard.",
      severity: "error",
    });
  }

  for (const player of data.players) {
    if (!player.licenseNumber) {
      warnings.push({
        code: "PLAYER_LICENSE_MISSING",
        message: `Licence non lue pour le joueur maillot ${player.jerseyNumber ?? "?"} (${player.teamSide === "home" ? "domicile" : "extérieur"}).`,
        severity: "warning",
      });
    } else if (player.confidence !== null && player.confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.push({
        code: "LOW_EXTRACTION_CONFIDENCE",
        message: `Confiance d'extraction faible (${player.confidence.toFixed(0)}) pour le joueur maillot ${player.jerseyNumber ?? "?"}.`,
        severity: "info",
      });
    }
  }

  for (const official of data.tableOfficials) {
    if (!official.licenseNumber) {
      warnings.push({
        code: "OTM_LICENSE_MISSING",
        message: `Licence non lue pour l'officiel de table (${official.role}).`,
        severity: "warning",
      });
    } else if (official.confidence !== null && official.confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.push({
        code: "LOW_EXTRACTION_CONFIDENCE",
        message: `Confiance d'extraction faible (${official.confidence.toFixed(0)}) pour l'officiel de table (${official.role}).`,
        severity: "info",
      });
    }
  }

  return warnings;
}

/**
 * Contrôles de COHÉRENCE des statistiques avant publication (retour du club,
 * 2026-10-06 : "un coup les stats sont fausses") — sévérité "error", donc
 * import "à vérifier" (needs_review), jamais publié en l'état :
 * - la somme des points des joueurs de chaque équipe doit égaler le score
 *   officiel FFBB de cette équipe (un point mal lu, une ligne manquante ou
 *   une ligne attribuée au mauvais joueur se voient ici) ;
 * - un même maillot ne peut pas apparaître deux fois dans une équipe.
 */
export function computeStatsConsistencyWarnings(
  data: Pick<EMarqueMatchData, "players" | "playerStats">,
  context: QualityCheckContext,
): EMarqueQualityWarning[] {
  const warnings: EMarqueQualityWarning[] = [];

  for (const [side, label, officialScore] of [
    ["home", "domicile", context.ffbbScoreHome],
    ["away", "extérieur", context.ffbbScoreAway],
  ] as const) {
    if (officialScore === null) continue;
    const rows = data.playerStats.filter((stat) => stat.teamSide === side);
    if (rows.length === 0) continue;
    const unread = rows.filter((stat) => stat.points === null).length;
    const total = rows.reduce((sum, stat) => sum + (stat.points ?? 0), 0);
    if (unread > 0 || total !== officialScore) {
      warnings.push({
        code: "PLAYER_POINTS_TOTAL_MISMATCH",
        message: `Équipe ${label} : total des points des joueurs ${total}${unread > 0 ? ` (${unread} valeur(s) illisible(s))` : ""} différent du score officiel ${officialScore}.`,
        severity: "error",
      });
    }
  }

  for (const side of ["home", "away"] as const) {
    const seen = new Set<string>();
    for (const player of data.players) {
      if (player.teamSide !== side || player.jerseyNumber === null) continue;
      if (seen.has(player.jerseyNumber)) {
        warnings.push({
          code: "DUPLICATE_JERSEY_NUMBER",
          message: `Maillot ${player.jerseyNumber} présent deux fois (${side === "home" ? "domicile" : "extérieur"}).`,
          severity: "error",
        });
      }
      seen.add(player.jerseyNumber);
    }
  }

  return warnings;
}

export function computeOverallConfidence(confidences: (number | null)[]): number | null {
  const known = confidences.filter((c): c is number => c !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, c) => sum + c, 0) / known.length;
}
