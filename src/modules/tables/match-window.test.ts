import { describe, expect, it } from "vitest";
import { computeMatchWindow, intervalsOverlap } from "./match-window.js";

describe("computeMatchWindow", () => {
  it("occupe 120 minutes par défaut (§5 de la demande : 15:00 -> 15:00-17:00)", () => {
    const window = computeMatchWindow(new Date("2026-10-03T15:00:00Z"));
    expect(window.start.toISOString()).toBe("2026-10-03T15:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-10-03T17:00:00.000Z");
  });

  it("16:00 -> 16:00-18:00 (deuxième exemple de la demande)", () => {
    const window = computeMatchWindow(new Date("2026-10-03T16:00:00Z"));
    expect(window.end.toISOString()).toBe("2026-10-03T18:00:00.000Z");
  });

  it("accepte une durée personnalisée sans jamais deviner 120 par défaut si explicitement fournie", () => {
    const window = computeMatchWindow(new Date("2026-10-03T15:00:00Z"), 90);
    expect(window.end.toISOString()).toBe("2026-10-03T16:30:00.000Z");
  });

  it("travelBufferMinutes (§15, point d'extension future, 0 en V1) étend la fenêtre des deux côtés", () => {
    const window = computeMatchWindow(new Date("2026-10-03T15:00:00Z"), 120, 30);
    expect(window.start.toISOString()).toBe("2026-10-03T14:30:00.000Z");
    expect(window.end.toISOString()).toBe("2026-10-03T17:30:00.000Z");
  });
});

describe("intervalsOverlap (§6 de la demande)", () => {
  it("15:00-17:00 et 17:00-19:00 ne se chevauchent PAS (créneaux qui se touchent, §54)", () => {
    expect(intervalsOverlap(new Date("2026-10-03T15:00:00Z"), new Date("2026-10-03T17:00:00Z"), new Date("2026-10-03T17:00:00Z"), new Date("2026-10-03T19:00:00Z"))).toBe(false);
  });

  it("15:00-17:00 et 16:00-18:00 se chevauchent (§55)", () => {
    expect(intervalsOverlap(new Date("2026-10-03T15:00:00Z"), new Date("2026-10-03T17:00:00Z"), new Date("2026-10-03T16:00:00Z"), new Date("2026-10-03T18:00:00Z"))).toBe(true);
  });

  it("un intervalle totalement inclus dans l'autre se chevauche", () => {
    expect(intervalsOverlap(new Date("2026-10-03T15:00:00Z"), new Date("2026-10-03T19:00:00Z"), new Date("2026-10-03T16:00:00Z"), new Date("2026-10-03T17:00:00Z"))).toBe(true);
  });

  it("deux intervalles totalement disjoints ne se chevauchent pas", () => {
    expect(intervalsOverlap(new Date("2026-10-03T09:00:00Z"), new Date("2026-10-03T11:00:00Z"), new Date("2026-10-03T15:00:00Z"), new Date("2026-10-03T17:00:00Z"))).toBe(false);
  });
});
