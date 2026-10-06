import { describe, expect, it } from "vitest";
import { computeOverallConfidence, computeQualityWarnings, computeStatsConsistencyWarnings } from "./compute-quality-warnings.js";
import type { EMarqueMatchData } from "../types.js";

function baseData(): Pick<EMarqueMatchData, "match" | "players" | "tableOfficials"> {
  return {
    match: {
      rencontreNumero: "2813",
      competitionLabel: null,
      pouleLabel: "MED-B",
      date: "27/09/25",
      heure: "21:00",
      lieu: "SETE",
      homeTeamName: "SPORT CLUB DE SETE BASKET-1",
      awayTeamName: "BC THUIRINOIS-1",
      homeClubCode: "OCC0034008",
      awayClubCode: null,
      scoreHome: 69,
      scoreAway: 101,
      scoreByPeriod: [],
    },
    players: [
      { teamSide: "home", jerseyNumber: "4", lastName: "MARTIN", firstName: "A.", licenseNumber: "VT880543", isCaptain: false, isStarter: true, confidence: 80 },
    ],
    tableOfficials: [
      { role: "scorer", lastName: "DURAND", firstName: "T.", licenseNumber: "VT013405", confidence: 70 },
    ],
  };
}

describe("computeQualityWarnings", () => {
  it("ne remonte aucun avertissement quand tout concorde", () => {
    const warnings = computeQualityWarnings(baseData(), {
      ffbbMatchNumero: "2813",
      ffbbScoreHome: 69,
      ffbbScoreAway: 101,
    });
    expect(warnings).toEqual([]);
  });

  it("signale un numéro de rencontre différent (sévérité error)", () => {
    const warnings = computeQualityWarnings(baseData(), {
      ffbbMatchNumero: "9999",
      ffbbScoreHome: 69,
      ffbbScoreAway: 101,
    });
    expect(warnings).toContainEqual(expect.objectContaining({ code: "MATCH_NUMBER_MISMATCH", severity: "error" }));
  });

  it("signale une incohérence de score", () => {
    const warnings = computeQualityWarnings(baseData(), {
      ffbbMatchNumero: "2813",
      ffbbScoreHome: 70,
      ffbbScoreAway: 101,
    });
    expect(warnings).toContainEqual(expect.objectContaining({ code: "SCORE_MISMATCH", severity: "error" }));
  });

  it("ne compare pas le score si l'un des deux est inconnu (null)", () => {
    const data = baseData();
    data.match.scoreHome = null;
    const warnings = computeQualityWarnings(data, { ffbbMatchNumero: "2813", ffbbScoreHome: 69, ffbbScoreAway: 101 });
    expect(warnings.some((w) => w.code === "SCORE_MISMATCH")).toBe(false);
  });

  it("signale une licence joueur manquante", () => {
    const data = baseData();
    data.players[0]!.licenseNumber = null;
    const warnings = computeQualityWarnings(data, { ffbbMatchNumero: "2813", ffbbScoreHome: 69, ffbbScoreAway: 101 });
    expect(warnings).toContainEqual(expect.objectContaining({ code: "PLAYER_LICENSE_MISSING", severity: "warning" }));
  });

  it("signale une licence OTM manquante", () => {
    const data = baseData();
    data.tableOfficials[0]!.licenseNumber = null;
    const warnings = computeQualityWarnings(data, { ffbbMatchNumero: "2813", ffbbScoreHome: 69, ffbbScoreAway: 101 });
    expect(warnings).toContainEqual(expect.objectContaining({ code: "OTM_LICENSE_MISSING", severity: "warning" }));
  });

  it("signale un effectif totalement vide (sévérité error) — jamais un import 'réussi' silencieux sans aucun joueur", () => {
    const data = baseData();
    data.players = [];
    const warnings = computeQualityWarnings(data, { ffbbMatchNumero: "2813", ffbbScoreHome: 69, ffbbScoreAway: 101 });
    expect(warnings).toContainEqual(expect.objectContaining({ code: "NO_PLAYERS_EXTRACTED", severity: "error" }));
  });

  it("signale une confiance faible sans bloquer (sévérité info)", () => {
    const data = baseData();
    data.players[0]!.confidence = 10;
    const warnings = computeQualityWarnings(data, { ffbbMatchNumero: "2813", ffbbScoreHome: 69, ffbbScoreAway: 101 });
    expect(warnings).toContainEqual(expect.objectContaining({ code: "LOW_EXTRACTION_CONFIDENCE", severity: "info" }));
  });
});

describe("computeOverallConfidence", () => {
  it("calcule la moyenne des confiances connues", () => {
    expect(computeOverallConfidence([80, 60, 100])).toBeCloseTo(80);
  });

  it("ignore les valeurs null", () => {
    expect(computeOverallConfidence([80, null, 60])).toBeCloseTo(70);
  });

  it("retourne null si aucune confiance n'est connue", () => {
    expect(computeOverallConfidence([null, null])).toBeNull();
  });
});

describe("computeStatsConsistencyWarnings (garde-fou avant publication, 2026-10-06)", () => {
  const stat = (teamSide: "home" | "away", jerseyNumber: string, points: number | null) => ({
    teamSide,
    jerseyNumber,
    lastName: "X",
    firstName: "Y",
    secondsPlayed: null,
    points,
    shotsMade: null,
    threePointsMade: null,
    twoPointsInteriorMade: null,
    twoPointsExteriorMade: null,
    freeThrowsMade: null,
    foulsCommitted: null,
  });
  const player = (teamSide: "home" | "away", jerseyNumber: string | null) => ({
    teamSide,
    jerseyNumber,
    lastName: "X",
    firstName: "Y",
    licenseNumber: null,
    isCaptain: false,
    isStarter: null,
    confidence: null,
  });
  const context = { ffbbMatchNumero: "1", ffbbScoreHome: 10, ffbbScoreAway: 7 };

  it("aucun avertissement quand chaque total d'équipe égale le score officiel et que les maillots sont uniques", () => {
    const data = { players: [player("home", "4"), player("home", "5"), player("away", "4")], playerStats: [stat("home", "4", 6), stat("home", "5", 4), stat("away", "4", 7)] };
    expect(computeStatsConsistencyWarnings(data, context)).toEqual([]);
  });

  it("total des points différent du score, ou valeur illisible : « à vérifier »", () => {
    const data = { players: [], playerStats: [stat("home", "4", 6), stat("home", "5", 3), stat("away", "4", null)] };
    const warnings = computeStatsConsistencyWarnings(data, context);
    expect(warnings.map((w) => [w.code, w.severity])).toEqual([
      ["PLAYER_POINTS_TOTAL_MISMATCH", "error"],
      ["PLAYER_POINTS_TOTAL_MISMATCH", "error"],
    ]);
    expect(warnings[0]!.message).toContain("9");
    expect(warnings[1]!.message).toContain("illisible");
  });

  it("maillot en double dans une équipe : « à vérifier »", () => {
    const data = { players: [player("away", "10"), player("away", "10"), player("home", "10")], playerStats: [] };
    expect(computeStatsConsistencyWarnings(data, context).map((w) => w.code)).toEqual(["DUPLICATE_JERSEY_NUMBER"]);
  });
});
