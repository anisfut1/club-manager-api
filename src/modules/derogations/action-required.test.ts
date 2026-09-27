import { describe, expect, it } from "vitest";
import { isDerogationActionRequired } from "./action-required.js";

describe("isDerogationActionRequired", () => {
  it("faux si l'état n'est pas En Cours (déjà tranchée, ou bruit 'A Créer')", () => {
    expect(isDerogationActionRequired({ etat: "Acceptée par l'organisme dirigeant", demandeur: "Domicile", isHome: false })).toBe(false);
    expect(isDerogationActionRequired({ etat: "A Créer", demandeur: "Domicile", isHome: false })).toBe(false);
    expect(isDerogationActionRequired({ etat: null, demandeur: "Domicile", isHome: false })).toBe(false);
  });

  it("faux quand le club est demandeur (Domicile) sur un match à domicile — il attend l'adversaire", () => {
    expect(isDerogationActionRequired({ etat: "En Cours", demandeur: "Domicile", isHome: true })).toBe(false);
  });

  it("vrai quand l'adversaire (Domicile) est demandeur sur un match où le club est visiteur — réponse attendue de nous", () => {
    expect(isDerogationActionRequired({ etat: "En Cours", demandeur: "Domicile", isHome: false })).toBe(true);
  });

  it("faux quand le club est demandeur (Visiteur) sur un match à l'extérieur — il attend l'adversaire", () => {
    expect(isDerogationActionRequired({ etat: "En Cours", demandeur: "Visiteur", isHome: false })).toBe(false);
  });

  it("vrai quand l'adversaire (Visiteur) est demandeur sur un match où le club est domicile — réponse attendue de nous", () => {
    expect(isDerogationActionRequired({ etat: "En Cours", demandeur: "Visiteur", isHome: true })).toBe(true);
  });

  it("faux si le côté du club (isHome) ou le demandeur est inconnu — jamais deviné pour une action réelle", () => {
    expect(isDerogationActionRequired({ etat: "En Cours", demandeur: "Domicile", isHome: null })).toBe(false);
    expect(isDerogationActionRequired({ etat: "En Cours", demandeur: null, isHome: true })).toBe(false);
  });
});
