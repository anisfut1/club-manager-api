import { describe, expect, it } from "vitest";
import { locateTeamTables } from "./table-structure.js";

const HEADER_RANGE: readonly [number, number] = [0.024, 0.033];

describe("locateTeamTables", () => {
  it("distingue les deux tableaux (LOCAUX/VISITEURS) par le ratio en-tête/ligne, quel que soit l'effectif de chacun", () => {
    // Reproduit la structure réelle mesurée (rencontre 6 vs Agde, docs/EMARQUE.md) :
    // en-tête ~0.0274 (96/3508), lignes ~0.0165-0.0191 (58-67/3508).
    const lines = [
      0.173, // haut en-tête équipe A
      0.2, // fin en-tête A / haut ligne 0 (gap 0.027, en-tête)
      0.2166, // fin ligne 0 (gap 0.0166)
      0.2331, // fin ligne 1
      0.2521, // fin ligne 2 (12 joueurs simulés par la suite...)
      0.588, // haut en-tête équipe B, LOIN de A (effectif A ≠ effectif de calibrage) (gap 0.0274, en-tête)
      0.6154, // fin ligne 0 B
      0.6338, // fin ligne 1 B
    ];

    const tables = locateTeamTables(lines, HEADER_RANGE);

    expect(tables).toHaveLength(2);
    // Le dernier élément de l'équipe A est le début de l'en-tête B (borne de
    // fin, jamais un joueur en plus — voir le "portillon" côté appelant).
    expect(tables[0]!.rowBoundaries).toEqual([0.2, 0.2166, 0.2331, 0.2521, 0.588]);
    expect(tables[1]!.rowBoundaries).toEqual([0.6154, 0.6338]);
  });

  it("ne détecte rien si aucun écart ne correspond à un en-tête (document illisible ou structure inattendue)", () => {
    const lines = [0.2, 0.2166, 0.2331, 0.2521]; // que des écarts "ligne", jamais "en-tête"
    expect(locateTeamTables(lines, HEADER_RANGE)).toEqual([]);
  });

  it("un seul en-tête détecté produit un seul tableau (jamais une équipe B inventée)", () => {
    const lines = [0.173, 0.2, 0.2166, 0.2331];
    const tables = locateTeamTables(lines, HEADER_RANGE);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rowBoundaries).toEqual([0.2, 0.2166, 0.2331]);
  });
});
