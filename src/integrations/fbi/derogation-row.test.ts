import { describe, expect, it } from "vitest";
import { normalizeDerogationRow } from "./derogation-row.js";

describe("normalizeDerogationRow", () => {
  it("extrait les champs connus par libellé d'en-tête (colonnes confirmées par capture d'écran, voir docs/FBI.md)", () => {
    const raw = {
      "Date de dépôt": "",
      "N° Renc": "1",
      Division: "BU13FN23",
      Domicile: "SPORT CLUB DE SETE BASKET - 1",
      Visiteur: "CASTELNAU BASKET - 2",
      "Date rencontre": "26/09/2026",
      Heure: "15:30",
      "Date déro": "",
      "Etat de la dérogation": "A Créer",
    };

    expect(normalizeDerogationRow(raw)).toEqual({
      numero: "1",
      division: "BU13FN23",
      domicile: "SPORT CLUB DE SETE BASKET - 1",
      visiteur: "CASTELNAU BASKET - 2",
      dateRencontre: "26/09/2026",
      heure: "15:30",
      dateDepot: null,
      dateDerogation: null,
      etat: "A Créer",
      raw,
    });
  });

  it("renvoie null pour un champ connu absent du dictionnaire", () => {
    const result = normalizeDerogationRow({ "N° Renc": "5" });
    expect(result.numero).toBe("5");
    expect(result.etat).toBeNull();
  });

  it("conserve toutes les colonnes brutes dans raw", () => {
    const raw = { "N° Renc": "5", "Colonne inattendue": "x" };
    expect(normalizeDerogationRow(raw).raw).toEqual(raw);
  });
});
