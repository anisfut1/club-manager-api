import type { ZoneFraction } from "../extractors/types.js";

/**
 * Coordonnées calibrées manuellement contre un échantillon réel
 * (RM3 régionale, e-Marque V2 — voir docs/FBI_AUTHENTICATED_SPIKE.md).
 * Toutes les pages e-Marque observées font 1240×1755 px à 150dpi (donc
 * A4 portrait) ; les zones sont exprimées en fractions de cette référence
 * pour rester indépendantes de la résolution de rendu réelle.
 *
 * Fiabilité par zone (voir docs/FBI_AUTHENTICATED_SPIKE.md pour le détail) :
 * en-tête, noms d'équipe, code club, table des officiels (page 2) :
 * validées par OCR réel sur l'échantillon fourni à l'origine du projet —
 * jamais recalibrées depuis, contrairement à `FEUILLEMATCH_ROSTER`
 * ci-dessous (voir sa propre note).
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

/**
 * Table effectif (LICENCES/Noms des joueurs/N°/en jeu/Fautes) — référence
 * et méthodologie propres, DISTINCTES du reste de ce fichier (voir
 * `resume-layout.ts` pour la même approche) : coordonnées mesurées PIXEL
 * PAR PIXEL contre un document "feuillematch" RÉEL de production
 * (rencontre n°1481, § "Trente-quatrième déclenchement", docs/FBI.md) —
 * détection automatique des lignes de grille du tableau sur le rendu
 * produit par notre propre pipeline, vérifiées en superposant ces
 * coordonnées sur l'image d'origine ET en OCR-ant isolément des cellules
 * choisies (15 joueurs, 2 équipes) — jamais une estimation visuelle.
 *
 * Référence : page A4 rendue à 300dpi (RENDER_SCALE de
 * `pdf-raster-ocr-extractor.ts`), soit 2479×3508 px — comme
 * `resume-layout.ts`, mais UNIQUEMENT pour cette table (le reste du
 * fichier reste sur l'ancienne référence 150dpi, jamais retouché faute de
 * preuve).
 *
 * Découverte importante : contrairement au document "résumé" (mêmes
 * colonnes pour les deux équipes), les deux encadrés "Équipe A"/"Équipe B"
 * de CE document sont dessinés INDÉPENDAMMENT dans le gabarit FFBB, avec
 * des largeurs de colonnes LICENCES/Noms légèrement différentes entre les
 * deux — jamais supposé identique sans mesure séparée, après avoir
 * découvert en production qu'une lecture de colonne calibrée sur l'équipe
 * A appliquée telle quelle à l'équipe B tronquait systématiquement le
 * préfixe des numéros de licence (ex : "00970" au lieu de "VT000970").
 */
const ROSTER_REF_WIDTH = 2479;
const ROSTER_REF_HEIGHT = 3508;

function rosterZone(x: number, y: number, w: number, h: number): ZoneFraction {
  return { xFrac: x / ROSTER_REF_WIDTH, yFrac: y / ROSTER_REF_HEIGHT, widthFrac: w / ROSTER_REF_WIDTH, heightFrac: h / ROSTER_REF_HEIGHT };
}

const ROSTER_COLUMN_INSET_X = 6;
const ROSTER_ROW_INSET_Y = 4;

const ROSTER_COLUMNS_TEAM_A = {
  licenseNumber: [277, 539],
  name: [539, 1048],
  jerseyNumber: [1048, 1123],
} as const satisfies Record<string, readonly [number, number]>;

const ROSTER_COLUMNS_TEAM_B = {
  licenseNumber: [185, 460],
  name: [460, 1039],
  jerseyNumber: [1039, 1118],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * Bornes X ÉLARGIES de la colonne licence, absorbant la colonne
 * "type/surclassement" adjacente — jamais utilisées pour un joueur (le
 * contenu de cette colonne y contaminerait la licence, voir la note plus
 * bas), UNIQUEMENT en repli pour une ligne entraîneur : constaté en
 * production (rencontre n°1481, § "Trente-quatrième déclenchement",
 * docs/FBI.md) que le texte "JH962758"/"VT955805" de ces lignes démarre
 * PLUS À GAUCHE que la colonne licence habituelle (la colonne
 * "type/surclassement", vide sur une ligne entraîneur, n'y est
 * visuellement pas séparée par un filet) — la borne étroite ci-dessus
 * tronque alors systématiquement les deux premiers caractères (le
 * préfixe lettre).
 */
const ROSTER_LICENSE_WIDE_TEAM_A: readonly [number, number] = [210, 539];
const ROSTER_LICENSE_WIDE_TEAM_B: readonly [number, number] = [114, 460];

export type RosterColumn = keyof typeof ROSTER_COLUMNS_TEAM_A;

interface RosterTeamConfig {
  rowTop: number;
  rowHeight: number;
  columns: Record<RosterColumn, readonly [number, number]>;
  licenseWideColumn: readonly [number, number];
}

function columnZone(config: RosterTeamConfig, row: number, [xStart, xEnd]: readonly [number, number]): ZoneFraction {
  const yStart = config.rowTop + row * config.rowHeight;
  return rosterZone(
    xStart + ROSTER_COLUMN_INSET_X,
    yStart + ROSTER_ROW_INSET_Y,
    xEnd - xStart - 2 * ROSTER_COLUMN_INSET_X,
    config.rowHeight - 2 * ROSTER_ROW_INSET_Y,
  );
}

/**
 * `rowTop`/`rowHeight` mesurés directement sur l'échantillon réel : équipe
 * A (8 lignes joueuses réelles, 860→1327px), équipe B (7 lignes, 2135→2544px).
 */
const ROSTER_TEAM_A_CONFIG: RosterTeamConfig = { rowTop: 860, rowHeight: (1327 - 860) / 8, columns: ROSTER_COLUMNS_TEAM_A, licenseWideColumn: ROSTER_LICENSE_WIDE_TEAM_A };
const ROSTER_TEAM_B_CONFIG: RosterTeamConfig = { rowTop: 2135, rowHeight: (2544 - 2135) / 7, columns: ROSTER_COLUMNS_TEAM_B, licenseWideColumn: ROSTER_LICENSE_WIDE_TEAM_B };

function buildTeamRoster(config: RosterTeamConfig) {
  return {
    ...config,
    cellZone: (row: number, column: RosterColumn) => columnZone(config, row, config.columns[column]),
    /** Repli pour une ligne entraîneur — voir `ROSTER_LICENSE_WIDE_TEAM_A`. */
    licenseNumberWideZone: (row: number) => columnZone(config, row, config.licenseWideColumn),
  };
}

export const FEUILLEMATCH_ROSTER = {
  teamA: buildTeamRoster(ROSTER_TEAM_A_CONFIG),
  teamB: buildTeamRoster(ROSTER_TEAM_B_CONFIG),
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
