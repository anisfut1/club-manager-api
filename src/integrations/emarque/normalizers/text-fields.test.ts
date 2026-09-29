import { describe, expect, it } from "vitest";
import {
  extractIsolatedLicenseNumber,
  extractJerseyNumber,
  extractLicenseNumber,
  extractSingleInteger,
  extractTrailingIntegers,
  hasCheckMark,
  parseMinutesSecondsToSeconds,
  splitCommaSeparatedName,
  splitUppercaseAbbreviatedName,
} from "./text-fields.js";

describe("extractLicenseNumber", () => {
  it("extrait un numéro de licence propre", () => {
    expect(extractLicenseNumber("VT013405")).toBe("VT013405");
  });

  it("extrait un numéro de licence au milieu d'une ligne OCR bruitée", () => {
    expect(extractLicenseNumber("| CONDAMINAST,. ——— VT013405 | SPORT CLUB DE SETE B..")).toBe("VT013405");
  });

  it("gère un préfixe BC", () => {
    expect(extractLicenseNumber("VELLA CARRIER S. —— BC084293 | CLUB")).toBe("BC084293");
  });

  it("retourne null si aucun motif de licence n'est trouvé (ex: ligne vide/barrée)", () => {
    expect(extractLicenseNumber("—…—…—…—…—…—…—…—…—…")).toBeNull();
  });

  it("ne confond pas un simple nombre avec une licence (pas de préfixe lettre)", () => {
    expect(extractLicenseNumber("2813")).toBeNull();
  });
});

describe("extractIsolatedLicenseNumber", () => {
  it("extrait un numéro de licence propre", () => {
    expect(extractIsolatedLicenseNumber("VT013405")).toBe("VT013405");
  });

  it("tolère des espaces internes", () => {
    expect(extractIsolatedLicenseNumber("VT 013405")).toBe("VT013405");
  });

  it("retour du club, 2026-09-29 (0/40 licences lues sur les 4 premiers matchs de la saison 2026-2027) : tolère du bruit OCR non-alphanumérique de bordure de tableau, plus seulement les espaces", () => {
    expect(extractIsolatedLicenseNumber("VT013405.")).toBe("VT013405");
    expect(extractIsolatedLicenseNumber("|VT013405|")).toBe("VT013405");
    expect(extractIsolatedLicenseNumber("-VT013405-")).toBe("VT013405");
    expect(extractIsolatedLicenseNumber("VT_013405")).toBe("VT013405");
  });

  it("corrige la confusion O/0 par position (lettre en tête, chiffre ensuite)", () => {
    expect(extractIsolatedLicenseNumber("VTO10167")).toBe("VT010167");
    expect(extractIsolatedLicenseNumber("0H954244")).toBe("OH954244");
  });

  it("refuse toujours une longueur différente de 8 après nettoyage (jamais un décalage de colonne deviné)", () => {
    expect(extractIsolatedLicenseNumber("VT01340")).toBeNull();
    expect(extractIsolatedLicenseNumber("VT0134055")).toBeNull();
  });

  it("refuse une cellule vide ou barrée", () => {
    expect(extractIsolatedLicenseNumber("")).toBeNull();
    expect(extractIsolatedLicenseNumber("———")).toBeNull();
  });
});

describe("splitCommaSeparatedName", () => {
  it("sépare nom et prénom autour de la virgule", () => {
    expect(splitCommaSeparatedName("MARTIN, Alex")).toEqual({ lastName: "MARTIN", firstName: "Alex" });
  });

  it("gère l'absence de virgule (nom seul)", () => {
    expect(splitCommaSeparatedName("MARTIN")).toEqual({ lastName: "MARTIN", firstName: null });
  });

  it("gère une chaîne vide", () => {
    expect(splitCommaSeparatedName("")).toEqual({ lastName: null, firstName: null });
  });
});

describe("splitUppercaseAbbreviatedName", () => {
  it("sépare NOM et initiale de prénom (dernier token)", () => {
    expect(splitUppercaseAbbreviatedName("MARTIN A.")).toEqual({ lastName: "MARTIN", firstName: "A." });
  });

  it("gère un nom de famille à plusieurs mots", () => {
    expect(splitUppercaseAbbreviatedName("VAN DER BERG P.")).toEqual({ lastName: "VAN DER BERG", firstName: "P." });
  });

  it("gère un seul token (pas de prénom identifiable)", () => {
    expect(splitUppercaseAbbreviatedName("MARTIN")).toEqual({ lastName: "MARTIN", firstName: null });
  });
});

describe("parseMinutesSecondsToSeconds", () => {
  it("convertit mm:ss en secondes", () => {
    expect(parseMinutesSecondsToSeconds("12:52")).toBe(772);
  });

  it("convertit 00:00", () => {
    expect(parseMinutesSecondsToSeconds("00:00")).toBe(0);
  });

  it("retourne null si le format est illisible (OCR garbled)", () => {
    expect(parseMinutesSecondsToSeconds("azs2z")).toBeNull();
  });

  it("retourne null si les secondes sont invalides (>= 60)", () => {
    expect(parseMinutesSecondsToSeconds("12:99")).toBeNull();
  });
});

describe("extractTrailingIntegers", () => {
  it("extrait les 7 derniers nombres d'une ligne de statistiques propre", () => {
    expect(extractTrailingIntegers("4 MARTIN, Alex X 12:52 7 3 0 3 0 1 4", 7)).toEqual([7, 3, 0, 3, 0, 1, 4]);
  });

  it("retourne null si moins de 7 nombres sont présents (préfère abandonner que décaler)", () => {
    expect(extractTrailingIntegers("4 MARTIN, Alex X 7 3 0", 7)).toBeNull();
  });

  it("ignore les nombres du jersey/temps de jeu grâce à la troncature finale", () => {
    // 4 (maillot) et 12/52 (temps) précèdent les 7 statistiques réelles.
    const result = extractTrailingIntegers("99 MARTIN, Alex X 45:10 15 6 1 5 0 2 4", 7);
    expect(result).toEqual([15, 6, 1, 5, 0, 2, 4]);
  });
});

describe("extractSingleInteger", () => {
  it("extrait un nombre isolé d'une cellule propre", () => {
    expect(extractSingleInteger("7")).toBe(7);
  });

  it("retourne null si aucun nombre n'est trouvé, jamais 0 par défaut", () => {
    expect(extractSingleInteger("")).toBeNull();
    expect(extractSingleInteger("(e)")).toBeNull();
  });

  it("corrige la confusion OCR isolée \"O\"/\"o\" -> \"0\" (§ 'Trente-et-unième déclenchement', docs/FBI.md : 14 occurrences sur 14 dans l'échantillon réel)", () => {
    expect(extractSingleInteger("O")).toBe(0);
    expect(extractSingleInteger("o")).toBe(0);
  });

  it("ne touche jamais un \"O\" qui fait partie d'un mot plus long (jamais une substitution dans du texte libre)", () => {
    expect(extractSingleInteger("OK")).toBeNull();
  });

  it("n'utilise jamais les derniers chiffres d'une ligne entière (contrairement à extractTrailingIntegers) : une seule cellule isolée n'a qu'une seule valeur", () => {
    expect(extractSingleInteger("7 3 0 3 0 1 4")).toBe(7);
  });
});

describe("extractJerseyNumber", () => {
  it("extrait un numéro à un chiffre", () => {
    expect(extractJerseyNumber("4 MARTIN A.")).toBe("4");
  });

  it("extrait un numéro à deux chiffres", () => {
    expect(extractJerseyNumber("72 MARTIN A.")).toBe("72");
  });
});

describe("hasCheckMark", () => {
  it("détecte un X", () => {
    expect(hasCheckMark("X")).toBe(true);
  });

  it("retourne false sur une cellule vide", () => {
    expect(hasCheckMark("")).toBe(false);
  });
});
