import { describe, expect, it } from "vitest";
import { detectVenueConflicts, type VenueConflictCandidate } from "./venue-conflicts.js";

function candidate(overrides: Partial<VenueConflictCandidate> = {}): VenueConflictCandidate {
  return {
    id: "match-1",
    numero: "1",
    opponentName: "Adversaire",
    matchDatetime: "2026-10-11T09:00:00.000Z", // dimanche 11h heure de Paris (CEST, UTC+2)
    venueId: null,
    venueRawLabel: "GYMNASE CLAVEL",
    ...overrides,
  };
}

describe("detectVenueConflicts", () => {
  it("ne détecte aucun conflit quand une seule rencontre occupe la salle à cet horaire", () => {
    expect(detectVenueConflicts([candidate()])).toEqual([]);
  });

  it("détecte deux rencontres au même horaire ET même salle (venueRawLabel) — le cas 'Clavel' cité par le club", () => {
    const matchA = candidate({ id: "match-a", numero: "1", opponentName: "U9" });
    const matchB = candidate({ id: "match-b", numero: "2", opponentName: "U11" });

    const conflicts = detectVenueConflicts([matchA, matchB]);

    expect(conflicts).toHaveLength(2);
    expect(conflicts).toContainEqual({ matchId: "match-a", conflictingMatchIds: ["match-b"], conflictingLabel: "n°2 vs U11" });
    expect(conflicts).toContainEqual({ matchId: "match-b", conflictingMatchIds: ["match-a"], conflictingLabel: "n°1 vs U9" });
  });

  it("ne détecte pas de conflit si même horaire mais salle différente", () => {
    const matchA = candidate({ id: "match-a", venueRawLabel: "GYMNASE CLAVEL" });
    const matchB = candidate({ id: "match-b", venueRawLabel: "GYMNASE MAURICE C" });

    expect(detectVenueConflicts([matchA, matchB])).toEqual([]);
  });

  it("ne détecte pas de conflit si même salle mais horaire différent", () => {
    const matchA = candidate({ id: "match-a", matchDatetime: "2026-10-11T09:00:00.000Z" });
    const matchB = candidate({ id: "match-b", matchDatetime: "2026-10-11T11:00:00.000Z" });

    expect(detectVenueConflicts([matchA, matchB])).toEqual([]);
  });

  it("normalise la casse/les espaces de venueRawLabel avant comparaison", () => {
    const matchA = candidate({ id: "match-a", venueRawLabel: "  gymnase clavel  " });
    const matchB = candidate({ id: "match-b", venueRawLabel: "GYMNASE CLAVEL" });

    expect(detectVenueConflicts([matchA, matchB])).toHaveLength(2);
  });

  it("préfère venueId (identité de salle résolue) à venueRawLabel quand les deux sont présents", () => {
    const matchA = candidate({ id: "match-a", venueId: "venue-1", venueRawLabel: "GYMNASE A (LIBELLÉ BRUT)" });
    const matchB = candidate({ id: "match-b", venueId: "venue-1", venueRawLabel: "GYMNASE A (AUTRE LIBELLÉ)" });

    expect(detectVenueConflicts([matchA, matchB])).toHaveLength(2);
  });

  it("ignore une rencontre sans salle connue (venueId et venueRawLabel tous deux absents)", () => {
    const matchA = candidate({ id: "match-a", venueId: null, venueRawLabel: null });
    const matchB = candidate({ id: "match-b", venueId: null, venueRawLabel: null });

    expect(detectVenueConflicts([matchA, matchB])).toEqual([]);
  });

  it("gère un conflit à trois rencontres simultanées (chacune référence les deux autres)", () => {
    const matchA = candidate({ id: "match-a", numero: "1" });
    const matchB = candidate({ id: "match-b", numero: "2" });
    const matchC = candidate({ id: "match-c", numero: "3" });

    const conflicts = detectVenueConflicts([matchA, matchB, matchC]);

    expect(conflicts).toHaveLength(3);
    const forA = conflicts.find((c) => c.matchId === "match-a");
    expect(forA?.conflictingMatchIds.sort()).toEqual(["match-b", "match-c"]);
  });
});
