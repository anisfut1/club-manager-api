import { describe, expect, it } from "vitest";
import { parseFinalResultLine, parsePouleLabel, parseRencontreHeaderLine, toIsoLocalDateTime } from "./header-fields";

describe("parseRencontreHeaderLine", () => {
  it("analyse une ligne d'en-tête propre", () => {
    expect(parseRencontreHeaderLine("Rencontre N° 2813 Date 27/09/25 Heure 21:00 Lieu SETE")).toEqual({
      rencontreNumero: "2813",
      date: "27/09/25",
      heure: "21:00",
      lieu: "SETE",
    });
  });

  it("tolère un bruit OCR typique (espaces, ponctuation)", () => {
    const result = parseRencontreHeaderLine("| Rencontre N° 2813  Date  27/09/25  Heure  21:00  Lieu  SETE |");
    expect(result.rencontreNumero).toBe("2813");
    expect(result.date).toBe("27/09/25");
    expect(result.heure).toBe("21:00");
  });

  it("retourne null pour les champs absents plutôt que de deviner", () => {
    expect(parseRencontreHeaderLine("texte sans rapport")).toEqual({
      rencontreNumero: null,
      date: null,
      heure: null,
      lieu: null,
    });
  });
});

describe("parsePouleLabel", () => {
  it("extrait le libellé de poule", () => {
    expect(parsePouleLabel("Poule MED-B 1er arbitre MARTIN")).toBe("MED-B");
  });

  it("retourne null si absent", () => {
    expect(parsePouleLabel("texte totalement différent")).toBeNull();
  });
});

describe("toIsoLocalDateTime", () => {
  it("combine date et heure en ISO local", () => {
    expect(toIsoLocalDateTime("27/09/25", "21:00")).toBe("2025-09-27T21:00:00");
  });

  it("gère une année à 4 chiffres", () => {
    expect(toIsoLocalDateTime("27/09/2025", "21:00")).toBe("2025-09-27T21:00:00");
  });

  it("retombe sur minuit si l'heure est absente/illisible", () => {
    expect(toIsoLocalDateTime("27/09/25", null)).toBe("2025-09-27T00:00:00");
  });

  it("retourne null si la date est absente", () => {
    expect(toIsoLocalDateTime(null, "21:00")).toBeNull();
  });
});

describe("parseFinalResultLine", () => {
  it("extrait les deux scores finaux", () => {
    expect(parseFinalResultLine("RÉSULTAT FINAL : Équipe A 69 Équipe B 101 Équipe gagnante BC")).toEqual({
      scoreHome: 69,
      scoreAway: 101,
    });
  });

  it("retourne null pour les deux scores si le motif n'est pas reconnu", () => {
    expect(parseFinalResultLine("texte sans rapport")).toEqual({ scoreHome: null, scoreAway: null });
  });
});
