import { describe, expect, it } from "vitest";
import type { EMarquePlayer } from "../types.js";
import type { ResumeRowResult } from "./parse-resume.js";
import { mergePlayersWithStats } from "./merge.js";

function buildPlayer(overrides: Partial<EMarquePlayer> = {}): EMarquePlayer {
  return {
    teamSide: "home",
    jerseyNumber: "6",
    lastName: "MARTIN",
    firstName: "Léo",
    licenseNumber: "OC123456",
    isCaptain: false,
    isStarter: null,
    confidence: 90,
    ...overrides,
  };
}

function buildStatRow(overrides: Partial<ResumeRowResult> = {}): ResumeRowResult {
  return {
    teamSide: "home",
    jerseyNumber: "6",
    lastName: null,
    firstName: null,
    isStarter: true,
    secondsPlayed: 1060,
    points: 12,
    shotsMade: 5,
    threePointsMade: 1,
    twoPointsInteriorMade: 1,
    twoPointsExteriorMade: 1,
    freeThrowsMade: 2,
    foulsCommitted: 1,
    ...overrides,
  };
}

describe("mergePlayersWithStats", () => {
  it("rapproche un joueur et sa ligne de statistiques par (équipe, maillot)", () => {
    const players = [buildPlayer()];
    const stats = [buildStatRow()];

    const { players: merged, playerStats } = mergePlayersWithStats(players, stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.isStarter).toBe(true);
    // L'identité (nom/licence) vient toujours de feuillematch, jamais de resume.
    expect(merged[0]?.lastName).toBe("MARTIN");
    expect(merged[0]?.licenseNumber).toBe("OC123456");

    expect(playerStats).toHaveLength(1);
    expect(playerStats[0]).toMatchObject({ teamSide: "home", jerseyNumber: "6", points: 12 });
  });

  it("ne rapproche jamais deux joueurs de côtés différents portant le même numéro de maillot", () => {
    const players = [buildPlayer({ teamSide: "home", jerseyNumber: "4" }), buildPlayer({ teamSide: "away", jerseyNumber: "4" })];
    const stats = [buildStatRow({ teamSide: "away", jerseyNumber: "4", points: 20 })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    const home = merged.find((p) => p.teamSide === "home");
    const away = merged.find((p) => p.teamSide === "away");
    expect(home?.isStarter).toBeNull();
    expect(away?.isStarter).toBe(true);
  });

  it("laisse isStarter à null quand aucune ligne de statistiques ne correspond au joueur", () => {
    const players = [buildPlayer({ jerseyNumber: "99" })];
    const stats = [buildStatRow({ jerseyNumber: "6" })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    expect(merged[0]?.isStarter).toBeNull();
  });

  it("synthétise un joueur minimal à partir de la ligne 'resume' quand l'effectif 'feuillematch' n'a pas ce maillot (régression production n°1481, § 'Trente-deuxième déclenchement', docs/FBI.md : sans ce joueur synthétisé, persist-emarque-match.ts#insertPlayerStats n'a aucun participant à quoi rattacher la statistique et l'ignore silencieusement — le joueur disparaît entièrement de l'affichage malgré des statistiques lues correctement)", () => {
    const stats = [buildStatRow({ jerseyNumber: "77", lastName: "NOUVEAU", firstName: "Joueur", isStarter: true })];

    const { players: merged, playerStats } = mergePlayersWithStats([], stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      teamSide: "home",
      jerseyNumber: "77",
      lastName: "NOUVEAU",
      firstName: "Joueur",
      isStarter: true,
      // Jamais de licence inventée : seule une vraie correspondance de
      // numéro de licence (jamais lue par "resume") relie un participant
      // à un licencié existant (ARCHITECTURE.md §22/§26).
      licenseNumber: null,
      isCaptain: false,
    });

    expect(playerStats).toHaveLength(1);
    expect(playerStats[0]?.jerseyNumber).toBe("77");
  });

  it("ne synthétise jamais de doublon quand le joueur existe déjà côté feuillematch", () => {
    const players = [buildPlayer({ jerseyNumber: "6" })];
    const stats = [buildStatRow({ jerseyNumber: "6" })];

    const { players: merged } = mergePlayersWithStats(players, stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.lastName).toBe("MARTIN");
  });

  it("rapproche par nom de famille (jamais de doublon) un joueur 'feuillematch' dont SEUL le maillot est illisible — régression production n°1481, § 'Trente-troisième déclenchement', docs/FBI.md : \"COUIX L. Ô\" (maillot illisible, mais licence VT640539 et capitanat lus correctement) et la ligne 'resume' \"COUIX\" (maillot 8 lisible, aucune licence) désignent la MÊME personne, produisaient pourtant deux lignes distinctes (donc \"#?\" affiché côté UI en plus d'une ligne correcte)", () => {
    const players = [buildPlayer({ jerseyNumber: null, lastName: "COUIX L. Ô", firstName: "LE", licenseNumber: "VT640539", isCaptain: true })];
    const stats = [buildStatRow({ jerseyNumber: "8", lastName: "COUIX", firstName: "Laetitia", isStarter: true })];

    const { players: merged, playerStats } = mergePlayersWithStats(players, stats);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      jerseyNumber: "8", // comblé depuis "resume", seule donnée que "feuillematch" n'avait pas lue
      isStarter: true, // idem
      // Le reste de l'identité reste celui de "feuillematch", jamais écrasé par "resume".
      lastName: "COUIX L. Ô",
      firstName: "LE",
      licenseNumber: "VT640539",
      isCaptain: true,
    });
    expect(playerStats).toHaveLength(1);
  });

  it("ne rapproche jamais par nom de famille en cas d'ambiguïté (plusieurs candidats possibles) — synthétise plutôt un doublon que de deviner", () => {
    const players = [buildPlayer({ jerseyNumber: null, lastName: "MARTIN X.", firstName: "?" })];
    const stats = [
      buildStatRow({ jerseyNumber: "6", lastName: "MARTIN", firstName: "Alex" }),
      buildStatRow({ jerseyNumber: "7", lastName: "MARTIN", firstName: "Sacha" }),
    ];

    const { players: merged } = mergePlayersWithStats(players, stats);

    const feuillematchPlayer = merged.find((p) => p.lastName === "MARTIN X.");
    expect(feuillematchPlayer?.jerseyNumber).toBeNull();
    // Les deux lignes "resume" restent synthétisées séparément, jamais fusionnées au hasard.
    expect(merged).toHaveLength(3);
  });

  it("ne transforme jamais une statistique absente en zéro (null != 0)", () => {
    const players = [buildPlayer()];
    const stats = [buildStatRow({ points: null, threePointsMade: null, secondsPlayed: null })];

    const { playerStats } = mergePlayersWithStats(players, stats);

    expect(playerStats[0]?.points).toBeNull();
    expect(playerStats[0]?.threePointsMade).toBeNull();
    expect(playerStats[0]?.secondsPlayed).toBeNull();
  });
});
