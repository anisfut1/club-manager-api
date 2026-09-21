import type { ZoneFraction } from "../extractors/types";

/**
 * Coordonnées calibrées pour le document "résumé" (statistiques par
 * joueur), même échantillon que feuillematch-layout.ts. Voir ce fichier
 * pour la méthodologie et le niveau de confiance par zone.
 */

const REF_WIDTH = 1240;
const REF_HEIGHT = 1755;

function zone(x: number, y: number, w: number, h: number): ZoneFraction {
  return { xFrac: x / REF_WIDTH, yFrac: y / REF_HEIGHT, widthFrac: w / REF_WIDTH, heightFrac: h / REF_HEIGHT };
}

export const RESUME_STATS_TABLE = {
  /** Équipe "LOCAUX" (notre équipe si on joue à domicile) — validé par OCR réel. */
  teamA: { rowTop: 352, rowHeight: 30, columnZone: (row: number) => zone(15, 352 + row * 30 + 2, 1195, 22) },
  /** Équipe "VISITEURS" — coordonnées estimées par symétrie, non validées séparément. */
  teamB: { rowTop: 995, rowHeight: 30, columnZone: (row: number) => zone(15, 995 + row * 30 + 2, 1195, 22) },
  maxRows: 15,
  /** Motif qui marque la fin des lignes joueurs (arrêt de la lecture). */
  stopTextPattern: /total\s*équipe/i,
} as const;
