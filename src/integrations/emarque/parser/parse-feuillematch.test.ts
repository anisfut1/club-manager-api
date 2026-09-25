import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { PdfRasterOcrExtractor } from "../extractors/pdf-raster-ocr-extractor.js";
import { parseFeuillematch } from "./parse-feuillematch.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(dirname, "..", "__fixtures__", "feuillematch-1481.pdf");

/**
 * Test contre un VRAI document "feuillematch" de production (rencontre
 * n°1481, fourni directement par le club, § "Trente-quatrième
 * déclenchement", docs/FBI.md) — même méthodologie que
 * `parse-resume.test.ts` : c'est précisément ce document réel qui a permis
 * de découvrir puis corriger deux bugs (colonnes de l'équipe VISITEURS
 * décalées par rapport à l'équipe LOCAUX — gabarit dessiné indépendamment
 * pour chaque équipe — et confusion OCR "O"/"0" dans les numéros de
 * licence, corrigée par position plutôt qu'une substitution aveugle).
 */
describe("parseFeuillematch (document réel, rencontre n°1481)", () => {
  it(
    "lit les 15 joueuses (8 LOCAUX + 7 VISITEURS) avec leur numéro de licence exact, jamais tronqué",
    async () => {
      const buf = fs.readFileSync(fixturePath);
      const extractor = new PdfRasterOcrExtractor(buf);

      try {
        const result = await parseFeuillematch(extractor);
        const home = result.players.filter((p) => p.teamSide === "home");
        const away = result.players.filter((p) => p.teamSide === "away");

        expect(home.map((p) => p.jerseyNumber)).toEqual(["1", "4", "8", "12", "13", "18", "19", "26"]);
        expect(away.map((p) => p.jerseyNumber)).toEqual(["4", "5", "6", "8", "9", "11", "12"]);

        // Les 15 numéros de licence réels (fournis directement par le club) —
        // AUCUN tronqué, AUCUNE confusion O/0 résiduelle. Régression du
        // "Trente-quatrième déclenchement" : les licences de l'équipe
        // VISITEURS perdaient systématiquement leurs deux premiers
        // caractères ("00970" au lieu de "VT000970") avant ce correctif.
        const licensesByJersey = Object.fromEntries(result.players.map((p) => [`${p.teamSide}:${p.jerseyNumber}`, p.licenseNumber]));
        expect(licensesByJersey).toEqual({
          "home:1": "VT010167",
          "home:4": "VT040638",
          "home:8": "BC100650",
          "home:12": "VT043095",
          "home:13": "OH954244", // "O" isolé en position 1 : jamais confondu avec "0" (correction positionnelle).
          "home:18": "VT850821",
          "home:19": "VT064501",
          "home:26": "VT920235",
          "away:4": "VT000970",
          "away:5": "VT071373",
          "away:6": "JH072207",
          "away:8": "VT840539",
          "away:9": "VT026860",
          "away:11": "JN870663",
          "away:12": "VT030013",
        });

        // Capitanat : lu depuis le document réel (DA CUNHA côté LOCAUX,
        // COUIX côté VISITEURS), jamais un booléen par défaut.
        expect(home.find((p) => p.jerseyNumber === "26")?.isCaptain).toBe(true);
        expect(away.find((p) => p.jerseyNumber === "8")?.isCaptain).toBe(true);
        expect(home.filter((p) => p.isCaptain)).toHaveLength(1);
        expect(away.filter((p) => p.isCaptain)).toHaveLength(1);
      } finally {
        await extractor.dispose();
      }
    },
    60_000,
  );

  it(
    "lit les entraîneurs (principal ET adjoint, jamais un seul par équipe) avec leur numéro de licence",
    async () => {
      const buf = fs.readFileSync(fixturePath);
      const extractor = new PdfRasterOcrExtractor(buf);

      try {
        const result = await parseFeuillematch(extractor);

        // Régression : l'ancienne version s'arrêtait à la PREMIÈRE ligne
        // entraîneur trouvée ("break"), donc l'entraîneur adjoint (ligne
        // suivante) n'était jamais atteint pour l'équipe LOCAUX qui en a
        // deux (principal + adjoint).
        const homeCoaches = result.coaches.filter((c) => c.teamSide === "home");
        expect(homeCoaches).toHaveLength(2);
        expect(homeCoaches.map((c) => c.role).sort()).toEqual(["adjoint", "principal"]);
        expect(homeCoaches.map((c) => c.licenseNumber).sort()).toEqual(["JH962758", "VT955805"]);

        const awayCoaches = result.coaches.filter((c) => c.teamSide === "away");
        expect(awayCoaches).toHaveLength(1);
        expect(awayCoaches[0]).toMatchObject({ role: "principal", licenseNumber: "VT832541", lastName: "BARBIER" });
      } finally {
        await extractor.dispose();
      }
    },
    60_000,
  );
});
