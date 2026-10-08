import { describe, expect, it } from "vitest";
import { checkQuery, jaroWinkler, searchRoster, type RosterEntry } from "./name-search.js";

const roster: RosterEntry[] = [
  { id: "anis", firstName: "Anis", lastName: "Abed Meraim" },
  { id: "agnes", firstName: "Agnès", lastName: "Abadie" },
  { id: "lea", firstName: "Léa", lastName: "Fontaine" },
  { id: "jp", firstName: "Jean-Pierre", lastName: "Martin" },
  { id: "anais", firstName: "Anaïs", lastName: "Bernard" },
];

const ids = (q: string) => {
  const check = checkQuery(q);
  if (!check.ok) throw new Error(check.code);
  return searchRoster(check.words, roster).map((m) => m.id);
};

describe("checkQuery", () => {
  it("exige prénom ET nom (2 mots d'au moins 2 lettres)", () => {
    expect(checkQuery("anis")).toEqual({ ok: false, code: "QUERY_TOO_SHORT" });
    expect(checkQuery("a b")).toEqual({ ok: false, code: "QUERY_TOO_SHORT" });
    expect(checkQuery("x".repeat(81))).toEqual({ ok: false, code: "INVALID_QUERY" });
    expect(checkQuery("Anis Abed")).toEqual({ ok: true, words: ["anis", "abed"] });
  });
});

describe("searchRoster", () => {
  it("retrouve malgré les fautes de frappe et l'ordre (exemple du club)", () => {
    expect(ids("ansi abde meriuam")[0]).toBe("anis");
    expect(ids("meraim anis")[0]).toBe("anis");
    expect(ids("ABED-MERAIM Anis")[0]).toBe("anis");
  });

  it("accents, traits d'union et casse ignorés", () => {
    expect(ids("lea fontaine")).toEqual(["lea"]);
    expect(ids("jean pierre martin")).toEqual(["jp"]);
    expect(ids("martin jean-pierre")).toEqual(["jp"]);
  });

  it("un prénom seul ou un nom inventé ne propose rien", () => {
    expect(ids("anis dupont")).toEqual([]);
    expect(ids("lea lea")).toEqual([]);
    expect(ids("zz yy")).toEqual([]);
  });

  it("ne renvoie jamais le nom complet, seulement son initiale", () => {
    const check = checkQuery("lea fontaine");
    const [match] = check.ok ? searchRoster(check.words, roster) : [];
    expect(match).toMatchObject({ id: "lea", firstName: "Léa", lastInitial: "F" });
    expect(Object.keys(match!).sort()).toEqual(["firstName", "id", "lastInitial", "score"]);
  });

  it("au plus 5 propositions", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, firstName: "Lucas", lastName: "Martin" }));
    expect(searchRoster(["lucas", "martin"], many)).toHaveLength(5);
  });

  it("Jaro-Winkler : lettres inversées proches, mots différents éloignés", () => {
    expect(jaroWinkler("ansi", "anis")).toBeGreaterThan(0.9);
    expect(jaroWinkler("meriuam", "meraim")).toBeGreaterThan(0.9);
    expect(jaroWinkler("dupont", "meraim")).toBeLessThan(0.6);
  });
});
