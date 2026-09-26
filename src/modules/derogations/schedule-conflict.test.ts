import { describe, expect, it } from "vitest";
import { findScheduleConflict, type OtherMatchSlot } from "./schedule-conflict.js";

function otherMatch(overrides: Partial<OtherMatchSlot> = {}): OtherMatchSlot {
  return {
    id: "match-15h",
    numero: "1",
    opponentName: "FO PISCENOIS - 2",
    // 2026-10-10T15:00 heure de Paris (CEST, UTC+2) -> 13:00 UTC.
    matchDatetime: "2026-10-10T13:00:00.000Z",
    teamName: "Seniors 2",
    ...overrides,
  };
}

describe("findScheduleConflict (§ demande du club : 'un créneau de match est de 2h')", () => {
  it("détecte un conflit quand la nouvelle heure demandée (16h) tombe dans le créneau 2h d'un match déjà à 15h", () => {
    const conflict = findScheduleConflict("10/10/2026", "16:00", "match-16h", [otherMatch()]);

    expect(conflict).toEqual({
      matchId: "match-15h",
      numero: "1",
      opponentName: "FO PISCENOIS - 2",
      matchDatetime: "2026-10-10T13:00:00.000Z",
      teamName: "Seniors 2",
    });
  });

  it("aucun conflit quand la nouvelle heure demandée (17h) est juste APRÈS la fin du créneau 2h (15h-17h)", () => {
    expect(findScheduleConflict("10/10/2026", "17:00", "match-16h", [otherMatch()])).toBeNull();
  });

  it("aucun conflit sur une autre date, même heure identique", () => {
    expect(findScheduleConflict("11/10/2026", "16:00", "match-16h", [otherMatch()])).toBeNull();
  });

  it("jamais un conflit avec le match de la dérogation elle-même (`excludeMatchId`)", () => {
    expect(findScheduleConflict("10/10/2026", "16:00", "match-15h", [otherMatch({ id: "match-15h" })])).toBeNull();
  });

  it("`null` si dateRencontreDemandee/heureDemandee absents ou imparsables (jamais une comparaison hasardeuse)", () => {
    expect(findScheduleConflict(null, "16:00", "match-16h", [otherMatch()])).toBeNull();
    expect(findScheduleConflict("10/10/2026", null, "match-16h", [otherMatch()])).toBeNull();
    expect(findScheduleConflict("2026-10-10", "16:00", "match-16h", [otherMatch()])).toBeNull();
    expect(findScheduleConflict("10/10/2026", "16h00", "match-16h", [otherMatch()])).toBeNull();
  });

  it("ignore un match sans date/heure exploitable (matchDatetime imparsable)", () => {
    expect(findScheduleConflict("10/10/2026", "16:00", "match-16h", [otherMatch({ matchDatetime: "invalide" })])).toBeNull();
  });

  it("renvoie le PREMIER match en conflit trouvé quand plusieurs matchs se chevauchent", () => {
    const first = otherMatch({ id: "match-a" });
    const second = otherMatch({ id: "match-b", numero: "2" });

    expect(findScheduleConflict("10/10/2026", "16:00", "match-16h", [first, second])?.matchId).toBe("match-a");
  });
});
