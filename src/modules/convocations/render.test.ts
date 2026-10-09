import { describe, expect, it } from "vitest";
import { audienceFor, renderConvocationMessage } from "./render";

const base = {
  playerFirstName: "Lina",
  teamName: "U15 (F)",
  opponent: "Agde",
  matchStartsAt: "2026-10-10T16:00:00.000Z",
  timezone: "Europe/Paris",
  coachMessage: "Merci d'arriver à l'heure avec la tenue complète.",
};

describe("renderConvocationMessage", () => {
  it("parent, match à l'extérieur : enfant, équipe, adversaire, date, heure, rendez-vous ET lieu du match, message du coach", () => {
    const text = renderConvocationMessage({
      ...base,
      audience: "GUARDIAN",
      isHome: false,
      matchVenue: { name: "Gymnase Agde Basket", address: "12 rue du Sport, Agde" },
      meetingAt: "2026-10-10T14:15:00.000Z",
      meetingPoint: "Parking Maurice Clavel",
    });
    expect(text).toBe(
      [
        "Bonjour,",
        "",
        "Convocation pour Lina avec les U15 (F).",
        "",
        "Match :",
        "U15 (F) contre Agde",
        "Samedi 10 octobre à 18:00",
        "Match à l'extérieur",
        "",
        "Rendez-vous :",
        "16:15",
        "Parking Maurice Clavel",
        "",
        "Lieu du match :",
        "Gymnase Agde Basket",
        "12 rue du Sport, Agde",
        "",
        "Message du coach :",
        "« Merci d'arriver à l'heure avec la tenue complète. »",
        "",
        "Merci de confirmer la présence de Lina.",
      ].join("\n"),
    );
  });

  it("joueur majeur, à domicile : tutoiement neutre, lieu non répété quand c'est le lieu de rendez-vous", () => {
    const text = renderConvocationMessage({
      ...base,
      audience: "ADULT",
      playerFirstName: "Anis",
      teamName: "Seniors 1 (M)",
      opponent: "Frontignan",
      isHome: true,
      matchVenue: { name: "Maurice Clavel", address: "22 rue Maurice Clavel" },
      meetingAt: "2026-10-10T15:00:00.000Z",
      meetingPoint: "Maurice Clavel",
      coachMessage: null,
    });
    expect(text).toContain("Bonjour Anis,");
    expect(text).toContain("Rendez-vous :\n17:00\nMaurice Clavel");
    expect(text).not.toContain("Lieu du match");
    expect(text).not.toContain("Message du coach");
    expect(text).toContain("Merci de confirmer ta présence.");
    expect(text).not.toMatch(/convoqu[ée]/);
  });

  it("âge le jour du match : mineur ou inconnu → parent ; majeur → joueur", () => {
    expect(audienceFor("2011-05-01", base.matchStartsAt)).toBe("GUARDIAN");
    expect(audienceFor("2008-10-10", base.matchStartsAt)).toBe("ADULT");
    expect(audienceFor("2008-10-11", base.matchStartsAt)).toBe("GUARDIAN");
    expect(audienceFor(null, base.matchStartsAt)).toBe("GUARDIAN");
  });

  it("maillots : la ligne n'apparaît que pour la famille concernée", () => {
    const common = { ...base, audience: "GUARDIAN" as const, isHome: true, matchVenue: { name: "Maurice Clavel", address: null }, meetingAt: null, meetingPoint: "Maurice Clavel" };
    expect(renderConvocationMessage({ ...common, laundry: true })).toContain("Maillots :\nVous êtes en charge du lavage des maillots après le match.");
    expect(renderConvocationMessage(common)).not.toContain("Maillots");
  });
});
