import type { ZoneFraction } from "../extractors/types";

/**
 * Coordonnées calibrées manuellement contre un échantillon réel
 * (RM3 régionale, e-Marque V2 — voir docs/FBI_AUTHENTICATED_SPIKE.md).
 * Toutes les pages e-Marque observées font 1240×1755 px à 150dpi (donc
 * A4 portrait) ; les zones sont exprimées en fractions de cette référence
 * pour rester indépendantes de la résolution de rendu réelle.
 *
 * Fiabilité par zone (voir docs/FBI_AUTHENTICATED_SPIKE.md pour le détail) :
 * - En-tête, noms d'équipe, code club, effectif équipe A, table des
 *   officiels (page 2) : validées par OCR réel sur l'échantillon fourni.
 * - Équipe B (effectif) : coordonnées estimées par symétrie visuelle, PAS
 *   validées par un test OCR séparé — confiance plus faible, à surveiller
 *   via les avertissements qualité (LOW_EXTRACTION_CONFIDENCE).
 */

const REF_WIDTH = 1240;
const REF_HEIGHT = 1755;

function zone(x: number, y: number, w: number, h: number): ZoneFraction {
  return { xFrac: x / REF_WIDTH, yFrac: y / REF_HEIGHT, widthFrac: w / REF_WIDTH, heightFrac: h / REF_HEIGHT };
}

export const FEUILLEMATCH_PAGE1 = {
  /** "Rencontre N° 2813   Date 27/09/25   Heure 21:00   Lieu SETE" */
  rencontreLine: zone(15, 100, 1210, 40),
  /** "Poule MED-B   1er arbitre ...   2e arbitre ...   3e arbitre ..." */
  pouleArbitresLine: zone(15, 140, 1210, 60),
  /** "Équipe A ...\nÉquipe B ..." */
  teamNames: zone(745, 10, 480, 45),
  teamAClubCode: zone(15, 245, 500, 25),
  teamBClubCode: zone(15, 788, 500, 25),
  /** "RÉSULTAT FINAL : Équipe A 69 Équipe B 101 ..." — estimée, non validée séparément par OCR. */
  finalResultLine: zone(600, 1650, 620, 50),
} as const;

export const FEUILLEMATCH_ROSTER = {
  teamA: { rowTop: 385, rowHeight: 27.3, columnZone: (row: number) => zone(15, 385 + row * 27.3, 560, 24) },
  teamB: { rowTop: 1055, rowHeight: 27.3, columnZone: (row: number) => zone(15, 1055 + row * 27.3, 560, 24) },
  /** Nombre maximal de lignes à lire avant d'abandonner (filet de sécurité). */
  maxRows: 15,
} as const;

/**
 * Table "OFFICIELS, RESPONSABLES DE L'ORGANISATION..." — page 2.
 * Ordre des lignes confirmé sur l'échantillon réel. Seuls les rôles
 * pertinents pour notre modèle (arbitres + OTM au sens strict) sont
 * conservés ; les lignes "Délégué..." ne sont pas mappées (pas des
 * officiels de table, voir ARCHITECTURE.md §12).
 */
export const OFFICIALS_TABLE_PAGE2 = {
  rowTop: 1322,
  rowHeight: 32,
  columnZone: (row: number) => zone(220, 1322 + row * 32 + 3, 1000, 26),
  rows: [
    { role: "referee_1", kind: "referee" },
    { role: "referee_2", kind: "referee" },
    { role: "referee_3", kind: "referee" },
    { role: "scorer", kind: "table_official" },
    { role: "assistant_scorer", kind: "table_official" },
    { role: "timekeeper", kind: "table_official" },
    { role: "shot_clock_operator", kind: "table_official" },
    { role: null, kind: "skip" }, // Délégué de club
    { role: null, kind: "skip" }, // Délégué aux officiels
    { role: null, kind: "skip" }, // Délégué médical
    { role: "commissioner", kind: "table_official" },
  ],
} as const;
