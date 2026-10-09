import { describe, expect, it } from "vitest";
import { derogationNotificationEvents, type DerogationSnapshot } from "./notification-events.js";

const base: DerogationSnapshot = {
  fbiRowKey: "d1",
  etat: "En Cours",
  previousEtat: undefined,
  demandeur: "Visiteur",
  isHome: true,
  domicile: "CLUB A",
  visiteur: "ADVERSAIRE",
  dateRencontre: "11/10/2026",
  heure: "15:00",
  dateRencontreDemandee: "12/10/2026",
  heureDemandee: "10:30",
  salleDemandee: null,
  motif: "Indisponibilité salle",
};

describe("derogationNotificationEvents — quoi signaler au coordinateur après une vérification FBI", () => {
  it("dérogation demandée par l'adversaire, en cours : à traiter (avec les créneaux et le motif)", () => {
    expect(derogationNotificationEvents([base])).toEqual([
      { kind: "incoming", refKey: "d1", line: "CLUB A – ADVERSAIRE — prévu 11/10/2026 à 15:00, demandé 12/10/2026 à 10:30, motif : Indisponibilité salle" },
    ]);
  });

  it("notre propre demande en cours, ou côté du club inconnu : rien à traiter", () => {
    expect(derogationNotificationEvents([{ ...base, demandeur: "Domicile" }])).toEqual([]);
    expect(derogationNotificationEvents([{ ...base, isHome: null }])).toEqual([]);
  });

  it("réponse reçue : seulement quand une dérogation connue « En Cours » change d'état, jamais au premier passage", () => {
    expect(derogationNotificationEvents([{ ...base, demandeur: "Domicile", etat: "Acceptée", previousEtat: "En Cours" }])).toEqual([
      { kind: "outcome", refKey: "d1:Acceptée", line: "CLUB A – ADVERSAIRE : Acceptée (créneau demandé 12/10/2026 à 10:30)" },
    ]);
    expect(derogationNotificationEvents([{ ...base, etat: "Acceptée", previousEtat: undefined }])).toEqual([]);
    expect(derogationNotificationEvents([{ ...base, etat: "Refusée", previousEtat: "Refusée" }])).toEqual([]);
  });
});
