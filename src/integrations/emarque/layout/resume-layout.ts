import type { ZoneFraction } from "../extractors/types.js";

/**
 * Coordonnées calibrées PIXEL PAR PIXEL contre un document "résumé" RÉEL de
 * production (rencontre n°1481, § "Trente-et-unième déclenchement",
 * docs/FBI.md) — plus une estimation par symétrie sur un échantillon
 * générique comme avant. Mesurées en détectant automatiquement les lignes
 * de grille du tableau (contraste fort, longue portée horizontale/verticale)
 * sur le rendu produit par NOTRE PROPRE pipeline (`pdf-raster-ocr-
 * extractor.ts`, même échelle), puis vérifiées visuellement en superposant
 * ces coordonnées sur l'image d'origine — pas une estimation à l'œil.
 *
 * Référence : page A4 rendue à 300dpi (RENDER_SCALE de
 * `pdf-raster-ocr-extractor.ts`), soit 2479×3508 px. Les deux tableaux
 * (LOCAUX/VISITEURS) partagent exactement les mêmes colonnes ; seule la
 * position verticale de départ et la hauteur de ligne diffèrent légèrement
 * entre les deux (mesurées séparément, jamais supposées identiques).
 */

const REF_WIDTH = 2479;
const REF_HEIGHT = 3508;

function zone(x: number, y: number, w: number, h: number): ZoneFraction {
  return { xFrac: x / REF_WIDTH, yFrac: y / REF_HEIGHT, widthFrac: w / REF_WIDTH, heightFrac: h / REF_HEIGHT };
}

/**
 * Bornes X des colonnes (lignes de grille verticales mesurées). Une même
 * ligne entière de type "23:35 8 3 5 6 1 4 2" ne permet jamais de savoir de
 * façon fiable quel nombre appartient à quelle colonne dès qu'UN SEUL
 * chiffre est mal lu par l'OCR — lire chaque colonne séparément élimine
 * cette classe entière de bug (voir `extractSingleInteger`,
 * normalizers/text-fields.ts).
 */
const COLUMN_BOUNDS = {
  jerseyNumber: [40, 193],
  name: [193, 1018],
  starter: [1018, 1177],
  secondsPlayed: [1177, 1335],
  points: [1335, 1493],
  shotsMade: [1493, 1652],
  threePointsMade: [1652, 1810],
  twoPointsInteriorMade: [1810, 1968],
  twoPointsExteriorMade: [1968, 2127],
  freeThrowsMade: [2127, 2285],
  foulsCommitted: [2285, 2444],
} as const satisfies Record<string, readonly [number, number]>;

export type ResumeStatColumn = keyof typeof COLUMN_BOUNDS;

/** Marge intérieure (px) pour ne jamais inclure un pixel de ligne de grille dans le rognage OCR. */
const COLUMN_INSET_X = 6;
const ROW_INSET_Y = 4;

interface TeamRowConfig {
  /** Y du haut de la ligne 0 (juste sous la ligne de grille de l'en-tête). */
  rowTop: number;
  /** Hauteur moyenne d'une ligne, mesurée sur la plage réelle de lignes joueurs de CETTE équipe. */
  rowHeight: number;
}

function cellZone(config: TeamRowConfig, row: number, column: ResumeStatColumn): ZoneFraction {
  const [xStart, xEnd] = COLUMN_BOUNDS[column];
  const yStart = config.rowTop + row * config.rowHeight;
  return zone(xStart + COLUMN_INSET_X, yStart + ROW_INSET_Y, xEnd - xStart - 2 * COLUMN_INSET_X, config.rowHeight - 2 * ROW_INSET_Y);
}

/**
 * `rowTop` VÉRIFIÉ par extraction OCR directe (pas seulement par inspection
 * visuelle) : un premier calibrage à 748 (borne visuellement prise pour le
 * bas de l'en-tête) plaçait en réalité la ligne 0 sur le DEUXIÈME joueur
 * (Convert, maillot 4) — l'en-tête lui-même s'étend au-dessus de 681, qui
 * est la vraie limite haute de la ligne 0 (Georges, maillot 1 — confirmé en
 * OCR-ant isolément cette cellule : "1", jamais "4"). Ce décalage d'une
 * ligne complète faisait disparaître le premier joueur de chaque relevé.
 * L'équipe VISITEURS n'avait PAS ce décalage (2060 confirmé de la même
 * façon : lecture isolée "4", le bon maillot du premier visiteur).
 */
const TEAM_A_CONFIG: TeamRowConfig = { rowTop: 681, rowHeight: (1189 - 681) / 8 };
const TEAM_B_CONFIG: TeamRowConfig = { rowTop: 2060, rowHeight: (2510 - 2060) / 7 };

export const RESUME_STATS_TABLE = {
  /** Équipe "LOCAUX" — mesuré directement sur l'échantillon réel (8 lignes joueurs, 681→1189px). */
  teamA: { ...TEAM_A_CONFIG, cellZone: (row: number, column: ResumeStatColumn) => cellZone(TEAM_A_CONFIG, row, column) },
  /** Équipe "VISITEURS" — mesuré directement sur l'échantillon réel (7 lignes joueurs, 2060→2510px). */
  teamB: { ...TEAM_B_CONFIG, cellZone: (row: number, column: ResumeStatColumn) => cellZone(TEAM_B_CONFIG, row, column) },
  maxRows: 15,
} as const;
