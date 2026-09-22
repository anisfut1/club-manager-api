import { describe, expect, it } from "vitest";
import { hasAnyRole, hasRole, isClubAdmin, ROLE_LABELS } from "./roles.js";
import type { ClubRole } from "../db/types.js";

describe("hasRole", () => {
  it("retourne true si le rôle est présent parmi plusieurs rôles cumulés", () => {
    const roles: ClubRole[] = ["coach", "parent"];
    expect(hasRole(roles, "coach")).toBe(true);
    expect(hasRole(roles, "parent")).toBe(true);
  });

  it("retourne false si le rôle est absent", () => {
    expect(hasRole(["joueur"], "club_admin")).toBe(false);
  });

  it("retourne false sur une liste de rôles vide", () => {
    expect(hasRole([], "coach")).toBe(false);
  });
});

describe("hasAnyRole", () => {
  it("retourne true si au moins un rôle autorisé est possédé", () => {
    expect(hasAnyRole(["coach"], ["club_admin", "coach"])).toBe(true);
  });

  it("retourne false si aucun rôle autorisé n'est possédé", () => {
    expect(hasAnyRole(["joueur"], ["club_admin", "correspondant_club"])).toBe(false);
  });
});

describe("isClubAdmin", () => {
  it("détecte le rôle club_admin même cumulé avec d'autres rôles", () => {
    expect(isClubAdmin(["coach", "club_admin"])).toBe(true);
  });

  it("retourne false sans le rôle club_admin", () => {
    expect(isClubAdmin(["coach", "parent"])).toBe(false);
  });
});

describe("ROLE_LABELS", () => {
  it("fournit un libellé pour chacun des 6 rôles de club définis", () => {
    const expectedRoles: ClubRole[] = ["club_admin", "correspondant_club", "responsable_tables", "coach", "joueur", "parent"];

    for (const role of expectedRoles) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
  });
});
