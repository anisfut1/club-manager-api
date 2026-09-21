import { describe, expect, it } from "vitest";
import { computeOverallConfidence, computeQualityWarnings } from "./compute-quality-warnings";
import type { EMarqueMatchData } from "../types";

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
