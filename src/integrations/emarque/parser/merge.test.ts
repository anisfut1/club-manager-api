import { describe, expect, it } from "vitest";
import type { EMarquePlayer } from "../types";
import type { ResumeRowResult } from "./parse-resume";
import { mergePlayersWithStats } from "./merge";

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

  it("inclut une ligne de statistiques même sans joueur correspondant dans l'effectif (maillot illisible côté feuillematch)", () => {
    const stats = [buildStatRow({ jerseyNumber: "77" })];

    const { players: merged, playerStats } = mergePlayersWithStats([], stats);

    expect(merged).toHaveLength(0);
    expect(playerStats).toHaveLength(1);
    expect(playerStats[0]?.jerseyNumber).toBe("77");
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
