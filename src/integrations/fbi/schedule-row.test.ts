import { describe, expect, it } from "vitest";
import { normalizeScheduleRow } from "./schedule-row.js";

describe("normalizeScheduleRow", () => {
  it("extrait les champs connus par libellé d'en-tête (colonnes confirmées en production, voir docs/FBI.md)", () => {
    const raw = {
      Division: "BU11FN2",
      "N°": "12",
      "Equipe 1": "SPORT CLUB DE SETE BASKET - 1",
      "Equipe 2": "Exempt",
      "Date de rencontre": "26/09/2026",
      Heure: "15:00",
      Salle: "",
      EM: "",
      "Score 1": "",
      "Forfait 1": "",
    };

    expect(normalizeScheduleRow(raw)).toEqual({
      division: "BU11FN2",
      numero: "12",
      equipe1: "SPORT CLUB DE SETE BASKET - 1",
      equipe2: "Exempt",
      dateRencontre: "26/09/2026",
      heure: "15:00",
      salle: null,
      em: null,
      score1: null,
      forfait1: null,
      raw,
    });
  });

  it("renvoie null pour un champ connu absent du dictionnaire (colonne non trouvée sur cette page)", () => {
    const result = normalizeScheduleRow({ Division: "RM3" });
    expect(result.division).toBe("RM3");
    expect(result.numero).toBeNull();
    expect(result.salle).toBeNull();
  });

  it("conserve TOUTES les colonnes brutes dans raw, y compris non modélisées", () => {
    const raw = { Division: "RM3", "Colonne inattendue": "valeur" };
    expect(normalizeScheduleRow(raw).raw).toEqual(raw);
  });
});
