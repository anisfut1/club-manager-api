import type { EMarqueMatchData, EMarqueQualityWarning } from "../types";

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

export function computeOverallConfidence(confidences: (number | null)[]): number | null {
  const known = confidences.filter((c): c is number => c !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, c) => sum + c, 0) / known.length;
}
