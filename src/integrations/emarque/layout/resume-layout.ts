import type { ZoneFraction } from "../extractors/types.js";

/**
 * Colonnes calibrées PIXEL PAR PIXEL contre un document "résumé" RÉEL de
 * production (rencontre n°1481, § "Trente-et-unième déclenchement",
 * docs/FBI.md), mesurées en détectant les lignes de grille du tableau sur
 * le rendu produit par NOTRE PROPRE pipeline (`pdf-raster-ocr-
 * extractor.ts`, même échelle), puis vérifiées visuellement.
 *
 * Référence : page A4 rendue à 300dpi (RENDER_SCALE de
 * `pdf-raster-ocr-extractor.ts`), soit 2479×3508 px. Les deux tableaux
 * (LOCAUX/VISITEURS) partagent exactement les mêmes colonnes.
 *
 * La position VERTICALE des lignes (rowTop/rowHeight) n'est PLUS calibrée
 * ici depuis le retour du club, 2026-09-29 : un document réel à 12 joueurs
 * LOCAUX (contre 8 sur l'échantillon de calibrage) décalait entièrement la
 * lecture de l'équipe VISITEURS, dont la position dépend du nombre de
 * lignes LOCAUX au-dessus. Voir `table-structure.ts` — la position de
 * chaque ligne est désormais détectée PAR DOCUMENT, jamais supposée fixe.
 */

const REF_WIDTH = 2479;
const REF_HEIGHT = 3508;

function xFrac(px: number): number {
  return px / REF_WIDTH;
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

/** Marge intérieure pour ne jamais inclure un pixel de ligne de grille dans le rognage OCR. */
const COLUMN_INSET_X_FRAC = 6 / REF_WIDTH;
const ROW_INSET_Y_FRAC = 4 / REF_HEIGHT;

/**
 * Écart (fraction de PAGE, jamais de zone) entre deux lignes de grille
 * consécutives correspondant à une ligne d'EN-TÊTE de colonnes — mesuré
 * ~96px sur les deux documents réels utilisés (rencontre 1481 et rencontre
 * 6 vs Agde Basket, docs/EMARQUE.md "Correctifs d'import"), contre ~58-67px
 * pour une ligne de données (joueur ou synthèse "Total..."). Une marge
 * généreuse (±20px) absorbe une variation de rendu/OCR mineure sans jamais
 * chevaucher la plage "ligne de données" mesurée sur les deux échantillons.
 */
export const RESUME_HEADER_GAP_FRACTION_RANGE: readonly [number, number] = [80 / REF_HEIGHT, 120 / REF_HEIGHT];

/** Zone couvrant toutes les colonnes du tableau, page entière — pour `DocumentExtractor#detectHorizontalLines`. */
export const RESUME_TABLE_SCAN_ZONE: ZoneFraction = {
  xFrac: xFrac(COLUMN_BOUNDS.jerseyNumber[0]),
  yFrac: 0,
  widthFrac: xFrac(COLUMN_BOUNDS.foulsCommitted[1] - COLUMN_BOUNDS.jerseyNumber[0]),
  heightFrac: 1,
};

/** `rowTopFrac`/`rowBottomFrac` : bornes Y (fraction de page) d'UNE ligne détectée dynamiquement (voir `table-structure.ts`), jamais une position pré-calculée. */
export function resumeCellZone(rowTopFrac: number, rowBottomFrac: number, column: ResumeStatColumn): ZoneFraction {
  const [xStart, xEnd] = COLUMN_BOUNDS[column];
  const rowHeightFrac = Math.max(rowBottomFrac - rowTopFrac, 2 * ROW_INSET_Y_FRAC + 0.001);

  return {
    xFrac: xFrac(xStart) + COLUMN_INSET_X_FRAC,
    yFrac: rowTopFrac + ROW_INSET_Y_FRAC,
    widthFrac: xFrac(xEnd - xStart) - 2 * COLUMN_INSET_X_FRAC,
    heightFrac: rowHeightFrac - 2 * ROW_INSET_Y_FRAC,
  };
}

/** Nombre maximal de lignes à lire par équipe avant d'abandonner (filet de sécurité, jamais atteint en pratique — un roster FFBB ne dépasse pas 15 joueurs). */
export const RESUME_MAX_ROWS_PER_TEAM = 15;
