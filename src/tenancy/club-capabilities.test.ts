import { describe, expect, it } from "vitest";
import { computeClubCapabilities } from "./club-capabilities";

describe("computeClubCapabilities", () => {
  it("un club sans FBI garde ffbb=true, fbi=false, emarque=false (FBI est facultatif)", () => {
    expect(computeClubCapabilities({ ffbbEnabled: true, fbiConfigured: false, fbiConnected: false })).toEqual({
      ffbb: true,
      fbi: false,
      emarque: false,
    });
  });

  it("un club FBI configuré mais jamais connecté avec succès n'a pas emarque actif", () => {
    expect(computeClubCapabilities({ ffbbEnabled: true, fbiConfigured: true, fbiConnected: false })).toEqual({
      ffbb: true,
      fbi: true,
      emarque: false,
    });
  });

  it("un club FBI configuré et connecté a emarque actif", () => {
    expect(computeClubCapabilities({ ffbbEnabled: true, fbiConfigured: true, fbiConnected: true })).toEqual({
      ffbb: true,
      fbi: true,
      emarque: true,
    });
  });

  it("un club FFBB désactivé garde ffbb=false indépendamment de FBI", () => {
    expect(computeClubCapabilities({ ffbbEnabled: false, fbiConfigured: true, fbiConnected: true })).toEqual({
      ffbb: false,
      fbi: true,
      emarque: true,
    });
  });
});
