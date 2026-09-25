import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { PdfRasterOcrExtractor } from "../extractors/pdf-raster-ocr-extractor.js";
import { parseResume } from "./parse-resume.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(dirname, "..", "__fixtures__", "resume-1481.pdf");

/**
 * Test contre un VRAI document "résumé" de production (rencontre n°1481,
 * fourni directement par le club, § "Trente-et-unième déclenchement",
 * docs/FBI.md) — le premier test de ce module contre un vrai rendu +
 * OCR réel (Tesseract), jamais une fixture synthétique : c'est précisément
 * ce qui a permis de découvrir puis corriger le bug de décalage de ligne
 * (l'équipe LOCAUX perdait systématiquement son premier joueur) et le bug
 * de décalage de colonne (un chiffre mal lu n'importe où dans la ligne
 * corrompait toutes les statistiques de cette ligne).
 *
 * L'OCR n'est PAS déterministe à 100% sur un document réel — certaines
 * cellules restent `null` (jamais une valeur devinée, voir
 * `extractSingleInteger`) même après la seconde passe de repli. Ce test
 * vérifie donc :
 * 1. Qu'AUCUNE ligne joueur n'est perdue ou décalée (régression du "Trente-
 *    et-unième déclenchement" : GEORGES, premier joueur LOCAUX, disparaissait
 *    entièrement).
 * 2. Que les lignes intégralement lisibles sur cet échantillon (confirmées
 *    manuellement contre le PDF) sont exactement correctes.
 * 3. Que les champs correctement lus sur les lignes partiellement illisibles
 *    ne sont PAS corrompus par les champs voisins (jamais de décalage de
 *    colonne), même quand un ou deux champs de cette même ligne sont `null`.
 */
describe("parseResume (document réel, rencontre n°1481)", () => {
  it(
    "lit les 8 joueurs LOCAUX dans le bon ordre, sans perdre le premier (régression du décalage de ligne)",
    async () => {
      const buf = fs.readFileSync(fixturePath);
      const extractor = new PdfRasterOcrExtractor(buf);

      try {
        const rows = await parseResume(extractor);
        const home = rows.filter((r) => r.teamSide === "home");

        expect(home.map((r) => r.jerseyNumber)).toEqual(["1", "4", "8", "12", "13", "18", "19", "26"]);

        // GEORGES (maillot 1) : disparaissait ENTIÈREMENT avant le
        // correctif (rowTop de l'équipe LOCAUX décalé d'une ligne complète,
        // plaçant la ligne 0 sur CONVERT à la place). Ligne intégralement
        // lisible sur cet échantillon — vérifiée exacte, champ par champ.
        expect(home[0]).toMatchObject({
          jerseyNumber: "1",
          lastName: "GEORGES",
          firstName: "Clemence",
          isStarter: true,
          secondsPlayed: 30 * 60 + 6,
          points: 12,
          shotsMade: 5,
          threePointsMade: 2,
          twoPointsInteriorMade: 3,
          twoPointsExteriorMade: 0,
          freeThrowsMade: 0,
          foulsCommitted: 2,
        });

        // DA CUNHA (maillot 26, dernière ligne LOCAUX) : intégralement
        // lisible également — vérifie que la lecture par colonne reste
        // correcte jusqu'à la fin du tableau, pas seulement sur la
        // première ligne.
        expect(home[7]).toMatchObject({
          jerseyNumber: "26",
          lastName: "DA CUNHA",
          firstName: "Aurore",
          isStarter: true,
          points: 15,
          shotsMade: 6,
          threePointsMade: 3,
          twoPointsInteriorMade: 2,
          twoPointsExteriorMade: 1,
          freeThrowsMade: 0,
          foulsCommitted: 2,
        });

        // OLIVIERI (maillot 12) : la ligne avec le plus de zéros du
        // document (0 partout sauf 1 faute) — vérifie spécifiquement que
        // "0" n'est jamais confondu avec "aucune valeur lue" (régression :
        // un "0" isolé était systématiquement lu comme la lettre "O" par
        // l'OCR, donc perdu, voir `extractSingleInteger`).
        expect(home[3]).toMatchObject({
          jerseyNumber: "12",
          points: 0,
          shotsMade: 0,
          threePointsMade: 0,
          twoPointsInteriorMade: 0,
          twoPointsExteriorMade: 0,
          freeThrowsMade: 0,
          foulsCommitted: 1,
        });
      } finally {
        await extractor.dispose();
      }
    },
    60_000,
  );

  it(
    "lit les VISITEURS sans jamais mélanger deux colonnes, même quand un champ isolé reste illisible",
    async () => {
      const buf = fs.readFileSync(fixturePath);
      const extractor = new PdfRasterOcrExtractor(buf);

      try {
        const rows = await parseResume(extractor);
        const away = rows.filter((r) => r.teamSide === "away");

        // COUIX (maillot 8) : ligne intégralement lisible côté visiteurs.
        const couix = away.find((r) => r.jerseyNumber === "8");
        expect(couix).toMatchObject({
          lastName: "COUIX",
          firstName: "Laetitia",
          isStarter: true,
          points: 8,
          shotsMade: 3,
          threePointsMade: 1,
          twoPointsInteriorMade: 0,
          twoPointsExteriorMade: 2,
          freeThrowsMade: 1,
          foulsCommitted: 0,
        });

        // N DIOGOYE (maillot 12) : dernière ligne visiteurs, intégralement
        // lisible — même vérification de bout de tableau que DA CUNHA
        // côté LOCAUX.
        const nDiogoye = away.find((r) => r.jerseyNumber === "12");
        expect(nDiogoye).toMatchObject({
          lastName: "N DIOGOYE",
          firstName: "Carla",
          points: 6,
          shotsMade: 2,
          threePointsMade: 0,
          twoPointsInteriorMade: 1,
          twoPointsExteriorMade: 1,
          freeThrowsMade: 2,
          foulsCommitted: 4,
        });

        // MESTRES (maillot 11) : signalée directement par le club ("2int
        // c'est 11 pas 1", § "Trente-sixième déclenchement", docs/FBI.md) —
        // un nombre à deux chiffres IDENTIQUES ("11") fusionné par l'OCR en
        // un seul chiffre isolé ("1"), constaté ici sur une STATISTIQUE
        // (`twoPointsInteriorMade`) et pas seulement sur un numéro de
        // maillot (voir "Trente-cinquième déclenchement"). Vérifié par
        // l'arithmétique du score : 28 points = 11×2 (2int) + 6 (LF), avec
        // 2ext=0 — cohérent uniquement avec 2int=11, jamais 2int=1.
        const mestres = away.find((r) => r.jerseyNumber === "11");
        expect(mestres).toMatchObject({
          lastName: "MESTRES",
          firstName: "Julie",
          isStarter: true,
          secondsPlayed: 34 * 60 + 56,
          points: 28,
          twoPointsInteriorMade: 11,
          twoPointsExteriorMade: 0,
          freeThrowsMade: 6,
          foulsCommitted: 3,
        });

        // Aucune ligne ne doit jamais porter les statistiques d'une AUTRE
        // ligne (le bug corrigé — voir le commentaire du fichier) : chaque
        // valeur non-null doit rester dans une plage plausible pour une
        // statistique de basket (jamais un numéro de maillot ou un
        // fragment de temps de jeu ayant fui dans une colonne de stat).
        for (const row of rows) {
          for (const value of [row.points, row.shotsMade, row.threePointsMade, row.twoPointsInteriorMade, row.twoPointsExteriorMade, row.freeThrowsMade, row.foulsCommitted]) {
            if (value !== null) expect(value).toBeGreaterThanOrEqual(0);
            if (value !== null) expect(value).toBeLessThanOrEqual(99);
          }
        }
      } finally {
        await extractor.dispose();
      }
    },
    60_000,
  );
});
