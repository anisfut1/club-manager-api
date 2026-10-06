import { describe, expect, it } from "vitest";
import { emarqueCheckWindowStart, nextEmarqueCheckAt } from "./backoff.js";

const start = new Date("2026-10-03T15:00:00Z");
const after = (minutes: number) => new Date(start.getTime() + minutes * 60 * 1000);

describe("calendrier fixe de vérification e-Marque", () => {
  it("ouvre la fenêtre 2 h après le début du match, ou à la relance manuelle", () => {
    expect(emarqueCheckWindowStart("2026-10-03T13:00:00Z", null)).toEqual(start);
    expect(emarqueCheckWindowStart("2026-10-03T13:00:00Z", "2026-10-06T08:00:00Z")).toEqual(new Date("2026-10-06T08:00:00Z"));
    expect(emarqueCheckWindowStart(null, null)).toBeNull();
  });

  it("avant la fin du match : premier essai à la fin du match", () => {
    expect(nextEmarqueCheckAt(start, after(-30))).toEqual(start);
  });

  it("toutes les 15 min pendant 6 h", () => {
    expect(nextEmarqueCheckAt(start, after(0))).toEqual(after(15));
    expect(nextEmarqueCheckAt(start, after(16))).toEqual(after(30));
    expect(nextEmarqueCheckAt(start, after(5 * 60 + 50))).toEqual(after(6 * 60));
  });

  it("puis toutes les heures jusqu'à 48 h, puis toutes les 6 h jusqu'à 7 jours", () => {
    expect(nextEmarqueCheckAt(start, after(6 * 60))).toEqual(after(7 * 60));
    expect(nextEmarqueCheckAt(start, after(30 * 60 + 5))).toEqual(after(31 * 60));
    expect(nextEmarqueCheckAt(start, after(48 * 60))).toEqual(after(54 * 60));
    expect(nextEmarqueCheckAt(start, after(7 * 24 * 60 - 60))).toEqual(after(7 * 24 * 60));
  });

  it("au-delà de 7 jours : plus de vérification automatique", () => {
    expect(nextEmarqueCheckAt(start, after(7 * 24 * 60))).toBeNull();
    expect(nextEmarqueCheckAt(start, after(10 * 24 * 60))).toBeNull();
  });
});
