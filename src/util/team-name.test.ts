import { describe, expect, it } from "vitest";
import { formatTeamNameWithGender } from "./team-name.js";

describe("formatTeamNameWithGender", () => {
  it("ajoute le sexe quand le nom ne le porte pas déjà (cas réel : rencontre 9820, 'Seniors 1' est en fait l'équipe féminine)", () => {
    expect(formatTeamNameWithGender("Seniors 1", "F")).toBe("Seniors 1 (F)");
    expect(formatTeamNameWithGender("U11 1", "M")).toBe("U11 1 (M)");
  });

  it("ne double pas le suffixe déjà présent (nom issu du correctif de scission des équipes, migration 20260925100000)", () => {
    expect(formatTeamNameWithGender("Seniors 1 M", "M")).toBe("Seniors 1 M");
    expect(formatTeamNameWithGender("U11 1 F", "F")).toBe("U11 1 F");
  });

  it("jamais de suffixe deviné quand le sexe est inconnu (null)", () => {
    expect(formatTeamNameWithGender("Seniors 1", null)).toBe("Seniors 1");
  });

  it("un nom se terminant par une autre lettre isolée n'est jamais pris pour un suffixe de sexe", () => {
    expect(formatTeamNameWithGender("Equipe A", "M")).toBe("Equipe A (M)");
  });
});
