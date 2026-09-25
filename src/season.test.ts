import { describe, expect, it } from "vitest";
import { currentSeasonStart } from "./season.js";

describe("currentSeasonStart", () => {
  it("renvoie le 1er août de la même année en pleine saison (ex: septembre)", () => {
    expect(currentSeasonStart(new Date(2026, 8, 25))).toEqual(new Date(2026, 7, 1));
  });

  it("renvoie le 1er août de l'année PRÉCÉDENTE avant août (ex: mai, fin de saison)", () => {
    expect(currentSeasonStart(new Date(2026, 4, 18))).toEqual(new Date(2025, 7, 1));
  });

  it("bascule pile le 1er août", () => {
    expect(currentSeasonStart(new Date(2026, 7, 1))).toEqual(new Date(2026, 7, 1));
  });
});
