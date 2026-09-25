import { describe, expect, it } from "vitest";
import { rejectedFieldsFor, resolveLicencieEditPermission } from "./profile-fields.js";

describe("resolveLicencieEditPermission", () => {
  it("club_admin peut tout modifier", () => {
    const { canEdit, allowedFields } = resolveLicencieEditPermission(true, false);
    expect(canEdit).toBe(true);
    expect(allowedFields).toEqual(expect.arrayContaining(["firstName", "lastName", "birthDate", "licenseNumber", "active", "photoUrl", "email", "phone"]));
  });

  it("le licencié lui-même ne peut modifier QUE le contact et la photo — jamais son identité", () => {
    const { canEdit, allowedFields } = resolveLicencieEditPermission(false, true);
    expect(canEdit).toBe(true);
    expect(allowedFields).toEqual(["photoUrl", "email", "phone"]);
    expect(allowedFields).not.toContain("firstName");
    expect(allowedFields).not.toContain("lastName");
    expect(allowedFields).not.toContain("licenseNumber");
    expect(allowedFields).not.toContain("active");
    expect(allowedFields).not.toContain("birthDate");
  });

  it("ni club_admin ni le licencié lui-même : aucune modification possible", () => {
    expect(resolveLicencieEditPermission(false, false)).toEqual({ canEdit: false, allowedFields: [] });
  });

  it("club_admin ET self en même temps (un admin éditant sa propre fiche) : reste le jeu de champs le plus large", () => {
    const { allowedFields } = resolveLicencieEditPermission(true, true);
    expect(allowedFields).toContain("licenseNumber");
  });
});

describe("rejectedFieldsFor", () => {
  it("aucun champ rejeté quand tous les champs soumis sont autorisés", () => {
    expect(rejectedFieldsFor({ photoUrl: "https://example.com/a.jpg", phone: "0600000000" }, ["photoUrl", "email", "phone"])).toEqual([]);
  });

  it("liste précisément le ou les champs hors population autorisée, jamais un rejet silencieux", () => {
    expect(rejectedFieldsFor({ photoUrl: "https://example.com/a.jpg", licenseNumber: "VT010167", active: false }, ["photoUrl", "email", "phone"])).toEqual([
      "licenseNumber",
      "active",
    ]);
  });

  it("payload vide -> aucun rejet", () => {
    expect(rejectedFieldsFor({}, ["photoUrl"])).toEqual([]);
  });
});
