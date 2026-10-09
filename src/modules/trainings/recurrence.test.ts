import { describe, expect, it } from "vitest";
import { generateOccurrences } from "./recurrence.js";

describe("generateOccurrences — séances d'un créneau hebdomadaire", () => {
  it("chaque mardi de la période, 19:00 heure de Paris toute l'année (passage à l'heure d'hiver le 25 octobre)", () => {
    const out = generateOccurrences({ weekday: 2, startTime: "19:00", endTime: "20:30", startsOn: "2026-10-05", endsOn: "2026-11-03" }, "Europe/Paris");
    expect(out.map((o) => o.seriesDate)).toEqual(["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03"]);
    expect(out[0]).toEqual({ seriesDate: "2026-10-06", startsAt: "2026-10-06T17:00:00.000Z", endsAt: "2026-10-06T18:30:00.000Z" });
    expect(out[3]!.startsAt).toBe("2026-10-27T18:00:00.000Z");
  });

  it("le jour de début compte s'il correspond ; aucune séance si la période ne contient pas ce jour", () => {
    expect(generateOccurrences({ weekday: 4, startTime: "18:00", endTime: "19:00", startsOn: "2026-10-08", endsOn: "2026-10-08" }, "Europe/Paris")).toHaveLength(1);
    expect(generateOccurrences({ weekday: 1, startTime: "18:00", endTime: "19:00", startsOn: "2026-10-06", endsOn: "2026-10-11" }, "Europe/Paris")).toEqual([]);
  });
});
