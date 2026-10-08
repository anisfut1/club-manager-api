import { describe, expect, it } from "vitest";
import { compareDerogationDateDepot, normalizeDerogationRow } from "./derogation-row.js";

describe("normalizeDerogationRow", () => {
  it("lit la date de dépôt sous l'intitulé RÉEL du tableau FBI, « Date de dépot » sans accent (relevé du 2026-10-08)", () => {
    expect(normalizeDerogationRow({ "Date de dépot": "11/09/2026 16:38", "N° Renc": "2" }).dateDepot).toBe("11/09/2026 16:38");
  });

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
      // `idDerogation` vient du lien de détail de la ligne DOM, jamais de ce
      // dictionnaire en-tête→cellule — voir `collectAllDerogationPages`.
      idDerogation: null,
      // Champs de détail (page afficherDerogation.fbi) : toujours null tant
      // qu'aucun passage par la page de détail, voir derogation-detail.ts.
      demandeur: null,
      motif: null,
      dateRencontreDemandee: null,
      heureDemandee: null,
      adversaire: null,
      dateReponse: null,
      acceptation: null,
      motifRefus: null,
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

describe("compareDerogationDateDepot (§ '82 vs 51', docs/FBI.md — une rencontre peut avoir plusieurs dérogations, garder la plus récente)", () => {
  it("une date plus récente est > une date plus ancienne", () => {
    expect(compareDerogationDateDepot("21/09/2026 09:10", "19/08/2026 17:42")).toBeGreaterThan(0);
    expect(compareDerogationDateDepot("19/08/2026 17:42", "21/09/2026 09:10")).toBeLessThan(0);
  });

  it("deux dates identiques comparent égal", () => {
    expect(compareDerogationDateDepot("19/08/2026 17:42", "19/08/2026 17:42")).toBe(0);
  });

  it("null/format illisible compte comme le plus ancien possible, jamais une erreur", () => {
    expect(compareDerogationDateDepot("19/08/2026 17:42", null)).toBeGreaterThan(0);
    expect(compareDerogationDateDepot(null, "19/08/2026 17:42")).toBeLessThan(0);
    expect(compareDerogationDateDepot(null, null)).toBe(0);
    expect(compareDerogationDateDepot("format illisible", "19/08/2026 17:42")).toBeLessThan(0);
  });
});
