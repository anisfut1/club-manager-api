import { describe, expect, it } from "vitest";
import { nextErrorBackoffSeconds, nextWaitingBackoffSeconds } from "./backoff.js";

describe("nextWaitingBackoffSeconds", () => {
  it("suit le calendrier 30min / 2h / 6h / 24h puis se stabilise à 24h (§27/§47 du brief FBI)", () => {
    expect(nextWaitingBackoffSeconds(0)).toBe(30 * 60);
    expect(nextWaitingBackoffSeconds(1)).toBe(2 * 60 * 60);
    expect(nextWaitingBackoffSeconds(2)).toBe(6 * 60 * 60);
    expect(nextWaitingBackoffSeconds(3)).toBe(24 * 60 * 60);
    expect(nextWaitingBackoffSeconds(50)).toBe(24 * 60 * 60);
  });
});

describe("nextErrorBackoffSeconds", () => {
  it("est plus court que le calendrier d'attente normale (une panne transitoire se corrige vite)", () => {
    expect(nextErrorBackoffSeconds(0)).toBeLessThan(nextWaitingBackoffSeconds(0));
    expect(nextErrorBackoffSeconds(10)).toBe(4 * 60 * 60);
  });
});
