import { describe, expect, it } from "vitest";
import { extractDerogationDetailFields } from "./derogation-detail.js";

/**
 * Lignes reproduisant l'ordre de lecture visible sur la capture d'écran du
 * VRAI FBI (afficherDerogation.fbi, 2026-09-25) — "Rencontre du"/"Heure"
 * (valeurs initiales, en haut de page) puis "Demande de dérogation"
 * ("Date rencontre"/"Horaire" demandés, "Motif de la demande") puis
 * "Réponse de l'adversaire".
 */
const REAL_PAGE_LINES = [
  "Equipe domicile",
  "SPORT CLUB DE SETE BASKET - 1",
  "Equipe visiteur",
  "BASKET BALL LUNEL VIEL - 1",
  "N° club visiteur",
  "OCC0034065",
  "Salle",
  "GYMNASE MAURICE CLAVEL - SETE",
  "Rencontre inversée",
  "Rencontre du",
  "11/10/2026",
  "Date dérogation",
  "Heure",
  "10:00",
  "Demande de dérogation",
  "Demandeur",
  "Domicile",
  "Date de dépôt",
  "25/09/2026 16:15",
  "Modifier la date",
  "Modifier l'horaire",
  "Modifier la salle",
  "Inverser la rencontre",
  "Inverser seulement les équipes",
  "Date rencontre",
  "17/10/2026",
  "Horaire",
  "20:00",
  "Motif de la demande",
  "Vu avec Jérôme au téléphone",
  "Réponse de l'adversaire",
  "Adversaire",
  "BASKET BALL LUNEL VIEL",
  "Date de réponse",
  "Acceptation",
  "NC",
  "Motif de refus",
];

describe("extractDerogationDetailFields (voir docs/FBI.md, capture du 2026-09-25)", () => {
  it("extrait le motif, la date/heure demandées et la réponse adversaire depuis le texte de la page", () => {
    const result = extractDerogationDetailFields(REAL_PAGE_LINES);

    expect(result).toEqual({
      demandeur: "Domicile",
      motif: "Vu avec Jérôme au téléphone",
      dateRencontreDemandee: "17/10/2026",
      heureDemandee: "20:00",
      adversaire: "BASKET BALL LUNEL VIEL",
      dateReponse: null,
      acceptation: "NC",
      motifRefus: null,
    });
  });

  it("ne confond jamais 'Rencontre du'/'Heure' (valeurs initiales) avec 'Date rencontre'/'Horaire' (valeurs demandées)", () => {
    const result = extractDerogationDetailFields(REAL_PAGE_LINES);

    expect(result.dateRencontreDemandee).toBe("17/10/2026");
    expect(result.dateRencontreDemandee).not.toBe("11/10/2026");
    expect(result.heureDemandee).toBe("20:00");
    expect(result.heureDemandee).not.toBe("10:00");
  });

  it("renvoie tous les champs à null quand la page ne ressemble pas à une page de détail (aucun libellé connu)", () => {
    const result = extractDerogationDetailFields(["Résultat de la recherche", "Date de dépôt", "N° Renc"]);

    expect(result).toEqual({
      demandeur: null,
      motif: null,
      dateRencontreDemandee: null,
      heureDemandee: null,
      adversaire: null,
      dateReponse: null,
      acceptation: null,
      motifRefus: null,
    });
  });

  it("ignore les lignes vides entre un libellé et sa valeur", () => {
    const result = extractDerogationDetailFields(["Motif de la demande", "", "", "Salle non disponible", "Adversaire", "AS TEST"]);

    expect(result.motif).toBe("Salle non disponible");
    expect(result.adversaire).toBe("AS TEST");
  });
});
