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
 * `resume-layout.ts` pour la même approche) : colonnes X mesurées PIXEL PAR
 * PIXEL contre un document "feuillematch" RÉEL de production (rencontre
 * n°1481, § "Trente-quatrième déclenchement", docs/FBI.md).
 *
 * Référence : page A4 rendue à 300dpi (RENDER_SCALE de
 * `pdf-raster-ocr-extractor.ts`), soit 2479×3508 px — comme
 * `resume-layout.ts`, mais UNIQUEMENT pour cette table (le reste du
 * fichier reste sur l'ancienne référence 150dpi, jamais retouché faute de
 * preuve).
 *
 * La position VERTICALE des lignes (rowTop/rowHeight) n'est PLUS calibrée
 * ici depuis le retour du club, 2026-09-29 : même bug que `resume-
 * layout.ts` (voir sa note) — la position de l'équipe B dépend du nombre
 * de lignes de l'équipe A au-dessus, jamais fixe d'un document à l'autre.
 * Voir `table-structure.ts` — détection dynamique PAR DOCUMENT.
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

interface RosterTeamColumns {
  columns: Record<RosterColumn, readonly [number, number]>;
  licenseWideColumn: readonly [number, number];
}

/** `rowTopFrac`/`rowBottomFrac` : bornes Y (fraction de page) d'UNE ligne détectée dynamiquement (voir `table-structure.ts`), jamais une position pré-calculée. */
function columnZone(team: RosterTeamColumns, rowTopFrac: number, rowBottomFrac: number, [xStart, xEnd]: readonly [number, number]): ZoneFraction {
  const rowInsetYFrac = ROSTER_ROW_INSET_Y / ROSTER_REF_HEIGHT;
  const rowHeightFrac = Math.max(rowBottomFrac - rowTopFrac, 2 * rowInsetYFrac + 0.001);

  return {
    xFrac: (xStart + ROSTER_COLUMN_INSET_X) / ROSTER_REF_WIDTH,
    yFrac: rowTopFrac + rowInsetYFrac,
    widthFrac: (xEnd - xStart - 2 * ROSTER_COLUMN_INSET_X) / ROSTER_REF_WIDTH,
    heightFrac: rowHeightFrac - 2 * rowInsetYFrac,
  };
}

const ROSTER_TEAM_A: RosterTeamColumns = { columns: ROSTER_COLUMNS_TEAM_A, licenseWideColumn: ROSTER_LICENSE_WIDE_TEAM_A };
const ROSTER_TEAM_B: RosterTeamColumns = { columns: ROSTER_COLUMNS_TEAM_B, licenseWideColumn: ROSTER_LICENSE_WIDE_TEAM_B };

function buildTeamRoster(team: RosterTeamColumns) {
  return {
    cellZone: (rowTopFrac: number, rowBottomFrac: number, column: RosterColumn) => columnZone(team, rowTopFrac, rowBottomFrac, team.columns[column]),
    /** Repli pour une ligne entraîneur — voir `ROSTER_LICENSE_WIDE_TEAM_A`. */
    licenseNumberWideZone: (rowTopFrac: number, rowBottomFrac: number) => columnZone(team, rowTopFrac, rowBottomFrac, team.licenseWideColumn),
  };
}

/**
 * Écart (fraction de PAGE) entre deux lignes de grille consécutives
 * correspondant à une ligne d'EN-TÊTE de ce tableau — mesuré ~141px sur
 * l'échantillon réel (rencontre 1481), contre 17-66px pour toute autre
 * ligne (donnée, séparateur, ligne entraîneur) — jamais dans la même plage,
 * marge généreuse pour absorber une variation de rendu/OCR mineure.
 */
export const ROSTER_HEADER_GAP_FRACTION_RANGE: readonly [number, number] = [120 / ROSTER_REF_HEIGHT, 170 / ROSTER_REF_HEIGHT];

/** Zone couvrant les deux jeux de colonnes (équipe A et B réunies), page entière — pour `DocumentExtractor#detectHorizontalLines`. */
export const ROSTER_TABLE_SCAN_ZONE: ZoneFraction = {
  xFrac: Math.min(ROSTER_COLUMNS_TEAM_A.licenseNumber[0], ROSTER_COLUMNS_TEAM_B.licenseNumber[0]) / ROSTER_REF_WIDTH,
  yFrac: 0,
  widthFrac:
    (Math.max(ROSTER_COLUMNS_TEAM_A.jerseyNumber[1], ROSTER_COLUMNS_TEAM_B.jerseyNumber[1]) - Math.min(ROSTER_COLUMNS_TEAM_A.licenseNumber[0], ROSTER_COLUMNS_TEAM_B.licenseNumber[0])) /
    ROSTER_REF_WIDTH,
  heightFrac: 1,
};

export const FEUILLEMATCH_ROSTER = {
  teamA: buildTeamRoster(ROSTER_TEAM_A),
  teamB: buildTeamRoster(ROSTER_TEAM_B),
  /**
   * Nombre maximal de lignes à lire par équipe — filet de sécurité contre
   * une détection de lignes de grille aberrante (jamais atteint sur un
   * document réel : un effectif + 2 entraîneurs ne dépasse pas ce total).
   */
  maxRows: 40,
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
