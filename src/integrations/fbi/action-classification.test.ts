import { describe, expect, it } from "vitest";
import { classifyFbiAction, extractFbiActionName, isFbiRequestAllowed } from "./action-classification";

describe("extractFbiActionName", () => {
  it("extrait le nom d'action d'une URL .fbi", () => {
    expect(extractFbiActionName("https://extranet.ffbb.com/fbi/afficherLicenceStatistiqueAjax.fbi")).toBe("afficherLicenceStatistiqueAjax");
  });

  it("ignore les paramètres de requête", () => {
    expect(extractFbiActionName("/fbi/rechercherRencontre.fbi?id=123&saison=2025")).toBe("rechercherRencontre");
  });

  it("renvoie une chaîne vide pour un chemin vide", () => {
    expect(extractFbiActionName("")).toBe("");
  });
});

describe("classifyFbiAction", () => {
  it("classe l'exemple concret du brief (afficherLicenceStatistiqueAjax) en READ_ONLY", () => {
    expect(classifyFbiAction("afficherLicenceStatistiqueAjax.fbi")).toBe("READ_ONLY");
  });

  it("classe les verbes de lecture courants en READ_ONLY", () => {
    for (const action of ["rechercherRencontre.fbi", "listerLicencies.fbi", "exporterDerogations.fbi", "genererFeuilleMatch.fbi", "telechargerEmarque.fbi"]) {
      expect(classifyFbiAction(action)).toBe("READ_ONLY");
    }
  });

  it("classe les verbes d'écriture courants en WRITE", () => {
    for (const action of ["enregistrerLicencie.fbi", "validerRencontre.fbi", "supprimerDerogation.fbi", "creerEngagement.fbi", "envoyerDemande.fbi"]) {
      expect(classifyFbiAction(action)).toBe("WRITE");
    }
  });

  it("classe une action inconnue en UNKNOWN plutôt que de deviner", () => {
    expect(classifyFbiAction("traiterQuelqueChose.fbi")).toBe("UNKNOWN");
  });

  it("privilégie WRITE en cas d'ambiguïté (le doute profite à la prudence)", () => {
    // "annulerRecherche" pourrait sembler être une recherche, mais commence par un verbe d'écriture.
    expect(classifyFbiAction("annulerRecherche.fbi")).toBe("WRITE");
  });
});

describe("isFbiRequestAllowed", () => {
  it("autorise toujours GET/HEAD/OPTIONS, quelle que soit l'action", () => {
    expect(isFbiRequestAllowed("GET", "nimporteQuoi.fbi")).toBe(true);
    expect(isFbiRequestAllowed("head", "traiterQuelqueChose.fbi")).toBe(true);
  });

  it("autorise un POST classé READ_ONLY", () => {
    expect(isFbiRequestAllowed("POST", "afficherLicenceStatistiqueAjax.fbi")).toBe(true);
  });

  it("refuse un POST classé WRITE ou UNKNOWN", () => {
    expect(isFbiRequestAllowed("POST", "enregistrerLicencie.fbi")).toBe(false);
    expect(isFbiRequestAllowed("POST", "traiterQuelqueChose.fbi")).toBe(false);
  });
});
