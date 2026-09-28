import { describe, expect, it } from "vitest";
import { parseCategoryCode, resolveTargetCategory, resolveTeamForLicencie, type TeamCandidate } from "./auto-assign-teams.js";

describe("parseCategoryCode", () => {
  it("reconnaît 'SE'/'Senior'/'Seniors' comme la même catégorie logique (deux graphies réelles observées)", () => {
    expect(parseCategoryCode("SE")).toEqual({ kind: "senior" });
    expect(parseCategoryCode("Seniors")).toEqual({ kind: "senior" });
    expect(parseCategoryCode("senior")).toEqual({ kind: "senior" });
  });

  it("reconnaît 'U<n>' quelle que soit la casse", () => {
    expect(parseCategoryCode("U11")).toEqual({ kind: "youth", age: 11 });
    expect(parseCategoryCode("u21")).toEqual({ kind: "youth", age: 21 });
  });

  it("renvoie null pour une valeur vide/inattendue — jamais une catégorie devinée", () => {
    expect(parseCategoryCode(null)).toBeNull();
    expect(parseCategoryCode("")).toBeNull();
    expect(parseCategoryCode("Vétérans")).toBeNull();
  });
});

// Catégories D'ÉQUIPE réellement observées pour SC Sète Basket (voir la
// discussion du 2026-09-28) : U11/U13/U15/U18/SE, jamais U4/U5/U7/U9/U10.
const CLUB_TEAM_CATEGORIES = [
  { kind: "youth" as const, age: 11 },
  { kind: "youth" as const, age: 13 },
  { kind: "youth" as const, age: 15 },
  { kind: "youth" as const, age: 18 },
  { kind: "senior" as const },
];

describe("resolveTargetCategory", () => {
  it("catégorie jeune EXACTEMENT connue → elle-même", () => {
    expect(resolveTargetCategory({ kind: "youth", age: 11 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 11 });
    expect(resolveTargetCategory({ kind: "youth", age: 18 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 18 });
  });

  it("catégorie jeune manquante mais proche PAR LE HAUT (surclassement ≤ 2 ans) → l'équipe la plus proche", () => {
    expect(resolveTargetCategory({ kind: "youth", age: 9 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 11 }); // U9 → U11 (2 ans)
    expect(resolveTargetCategory({ kind: "youth", age: 10 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 11 }); // U10 → U11 (1 an)
    expect(resolveTargetCategory({ kind: "youth", age: 12 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 13 }); // U12 → U13
    expect(resolveTargetCategory({ kind: "youth", age: 14 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 15 }); // U14 → U15
    expect(resolveTargetCategory({ kind: "youth", age: 16 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 18 }); // U16 → U18 (2 ans)
    expect(resolveTargetCategory({ kind: "youth", age: 17 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "youth", age: 18 }); // U17 → U18
  });

  it("beaucoup trop jeune (surclassement > 2 ans) → null, jamais un rattachement trompeur (ex. U5/U7 dans une équipe U11)", () => {
    expect(resolveTargetCategory({ kind: "youth", age: 4 }, CLUB_TEAM_CATEGORIES)).toBeNull();
    expect(resolveTargetCategory({ kind: "youth", age: 5 }, CLUB_TEAM_CATEGORIES)).toBeNull();
    expect(resolveTargetCategory({ kind: "youth", age: 7 }, CLUB_TEAM_CATEGORIES)).toBeNull();
  });

  it("trop âgé pour toute équipe jeune existante (U19/U20/U21) → bascule Seniors si l'équipe existe", () => {
    expect(resolveTargetCategory({ kind: "youth", age: 19 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "senior" });
    expect(resolveTargetCategory({ kind: "youth", age: 21 }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "senior" });
  });

  it("Senior·e → équipe Seniors si elle existe, sinon null (jamais une équipe jeune substituée)", () => {
    expect(resolveTargetCategory({ kind: "senior" }, CLUB_TEAM_CATEGORIES)).toEqual({ kind: "senior" });
    expect(resolveTargetCategory({ kind: "senior" }, CLUB_TEAM_CATEGORIES.filter((c) => c.kind !== "senior"))).toBeNull();
  });

  it("aucune équipe Seniors et joueur trop âgé pour toute équipe jeune → null", () => {
    const noSenior = CLUB_TEAM_CATEGORIES.filter((c) => c.kind !== "senior");
    expect(resolveTargetCategory({ kind: "youth", age: 19 }, noSenior)).toBeNull();
  });
});

// Équipes RÉELLES du club (2026-09-28) — voir la discussion : "Seniors 1"
// (F, à cause du bug historique de nommage déjà corrigé côté affichage),
// "Seniors 1 M", "Seniors 2", "Seniors 3", "U11 1"/"U11 1 F"/"U11 2", etc.
const CLUB_TEAMS: TeamCandidate[] = [
  { id: "seniors-1-f", category: "SE", sexe: "F", numeroEquipe: "1", active: true },
  { id: "seniors-1-m", category: "SE", sexe: "M", numeroEquipe: "1", active: true },
  { id: "seniors-2-m", category: "SE", sexe: "M", numeroEquipe: "2", active: true },
  { id: "seniors-3-m", category: "SE", sexe: "M", numeroEquipe: "3", active: true },
  { id: "u11-1-m", category: "U11", sexe: "M", numeroEquipe: "1", active: true },
  { id: "u11-1-f", category: "U11", sexe: "F", numeroEquipe: "1", active: true },
  { id: "u11-2-m", category: "U11", sexe: "M", numeroEquipe: "2", active: true },
  { id: "u13-1-f", category: "U13", sexe: "F", numeroEquipe: "1", active: true },
  { id: "u13-1-m", category: "U13", sexe: "M", numeroEquipe: "1", active: true },
];

describe("resolveTeamForLicencie", () => {
  it("catégorie+sexe correspondant à UNE SEULE équipe → cette équipe", () => {
    expect(resolveTeamForLicencie("Seniors", "F", CLUB_TEAMS)).toBe("seniors-1-f");
    expect(resolveTeamForLicencie("U13", "F", CLUB_TEAMS)).toBe("u13-1-f");
  });

  it("plusieurs équipes pour la catégorie+sexe → la plus petite numeroEquipe (\"met tous dans 1 seule pour linstant\", demande du club)", () => {
    expect(resolveTeamForLicencie("Seniors", "M", CLUB_TEAMS)).toBe("seniors-1-m"); // pas seniors-2-m ni seniors-3-m
    expect(resolveTeamForLicencie("U11", "M", CLUB_TEAMS)).toBe("u11-1-m"); // pas u11-2-m
  });

  it("sexe inconnu (null) → ignore le sexe, choisit quand même une seule équipe déterministe", () => {
    const result = resolveTeamForLicencie("U11", null, CLUB_TEAMS);
    expect(["u11-1-m", "u11-1-f"]).toContain(result); // numeroEquipe=1 pour les deux, départagé par id — déterministe, jamais aléatoire
  });

  it("sexe demandé mais AUCUNE équipe de ce sexe pour la catégorie → repli sur les équipes de l'autre sexe (jamais laissé sans équipe si une existe)", () => {
    // U13 n'a qu'une équipe M et une équipe F distinctes — teste un sexe totalement absent d'une catégorie synthétique.
    const teamsWithoutFemaleU15: TeamCandidate[] = [{ id: "u15-1-m", category: "U15", sexe: "M", numeroEquipe: "1", active: true }];
    expect(resolveTeamForLicencie("U15", "F", teamsWithoutFemaleU15)).toBe("u15-1-m");
  });

  it("catégorie inconnue/vide → null", () => {
    expect(resolveTeamForLicencie(null, "M", CLUB_TEAMS)).toBeNull();
    expect(resolveTeamForLicencie("Vétérans", "M", CLUB_TEAMS)).toBeNull();
  });

  it("catégorie beaucoup trop jeune (U5) → null, jamais rattaché à l'équipe U11", () => {
    expect(resolveTeamForLicencie("U5", "M", CLUB_TEAMS)).toBeNull();
  });

  it("ignore les équipes INACTIVES (jamais rattaché à une équipe désactivée)", () => {
    const teamsWithInactive: TeamCandidate[] = [
      { id: "u11-1-inactive", category: "U11", sexe: "M", numeroEquipe: "1", active: false },
      { id: "u11-2-active", category: "U11", sexe: "M", numeroEquipe: "2", active: true },
    ];
    expect(resolveTeamForLicencie("U11", "M", teamsWithInactive)).toBe("u11-2-active");
  });
});
