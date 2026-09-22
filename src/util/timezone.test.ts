import { describe, expect, it } from "vitest";
import { computePeriodRange, isValidTimeZone } from "./timezone.js";

describe("isValidTimeZone", () => {
  it("accepte un fuseau IANA valide", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejette un fuseau inventé", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Europe/Paris; DROP TABLE clubs;")).toBe(false);
  });
});

describe("computePeriodRange", () => {
  const THURSDAY = new Date("2026-09-24T10:00:00Z");

  it("upcoming : from = maintenant, to = illimité", () => {
    const range = computePeriodRange("upcoming", "Europe/Paris", THURSDAY);
    expect(range.from).toBe(THURSDAY.toISOString());
    expect(range.to).toBeNull();
  });

  it("past : to = maintenant, from = illimité", () => {
    const range = computePeriodRange("past", "Europe/Paris", THURSDAY);
    expect(range.from).toBeNull();
    expect(range.to).toBe(THURSDAY.toISOString());
  });

  it("weekend : samedi 00:00 -> lundi 00:00 dans le fuseau du club (CEST, UTC+2 en septembre)", () => {
    const range = computePeriodRange("weekend", "Europe/Paris", THURSDAY);
    expect(range.from).toBe("2026-09-25T22:00:00.000Z"); // samedi 00:00 Paris
    expect(range.to).toBe("2026-09-27T22:00:00.000Z"); // lundi 00:00 Paris
  });

  it("weekend : fenêtre différente selon le fuseau du club (§10 de la demande : la timezone métier vient du club)", () => {
    const parisRange = computePeriodRange("weekend", "Europe/Paris", THURSDAY);
    const nyRange = computePeriodRange("weekend", "America/New_York", THURSDAY);
    expect(parisRange.from).not.toBe(nyRange.from);
  });

  it("weekend : un instant déjà DANS le dimanche du week-end courant saute au week-end SUIVANT (même règle que l'ancien frontend)", () => {
    const sundayMorningParis = new Date("2026-09-27T06:00:00Z"); // dimanche matin en France
    const range = computePeriodRange("weekend", "Europe/Paris", sundayMorningParis);
    expect(range.from).toBe("2026-10-02T22:00:00.000Z"); // samedi suivant
  });

  it("weekend : traverse correctement le changement d'heure d'octobre (CEST -> CET) — jamais `start + 48h`", () => {
    // Le changement d'heure en France a lieu le dernier dimanche d'octobre
    // (25 octobre 2026). Un jeudi juste avant produit un week-end à cheval
    // sur le changement : samedi encore en UTC+2, lundi déjà en UTC+1 — la
    // fenêtre réelle ne fait donc PAS 48h tout rond en UTC.
    const thursdayBeforeDstEnd = new Date("2026-10-22T10:00:00Z");
    const range = computePeriodRange("weekend", "Europe/Paris", thursdayBeforeDstEnd);
    expect(range.from).toBe("2026-10-23T22:00:00.000Z"); // samedi 24 octobre 00:00 CEST (UTC+2)
    expect(range.to).toBe("2026-10-25T23:00:00.000Z"); // lundi 26 octobre 00:00 CET (UTC+1) — 49h réelles, pas 48h
  });
});
