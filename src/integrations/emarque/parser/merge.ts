import type { EMarquePlayer, EMarquePlayerStat } from "../types";
import type { ResumeRowResult } from "./parse-resume";

/**
 * Complète l'effectif (identité + licence, extrait de feuillematch) avec le
 * statut "titulaire" et les statistiques (extraits de resume), en les
 * rapprochant par numéro de maillot + équipe (les deux documents partagent
 * cette numérotation, contrairement au numéro de licence qui n'apparaît pas
 * dans "resume").
 */
export function mergePlayersWithStats(
  players: EMarquePlayer[],
  statsRows: ResumeRowResult[],
): { players: EMarquePlayer[]; playerStats: EMarquePlayerStat[] } {
  const updatedPlayers = players.map((player) => {
    const match = statsRows.find((row) => row.teamSide === player.teamSide && row.jerseyNumber === player.jerseyNumber);
    return match ? { ...player, isStarter: match.isStarter } : player;
  });

  const playerStats: EMarquePlayerStat[] = statsRows.map((row) => ({
    teamSide: row.teamSide,
    jerseyNumber: row.jerseyNumber,
    lastName: row.lastName,
    firstName: row.firstName,
    secondsPlayed: row.secondsPlayed,
    points: row.points,
    shotsMade: row.shotsMade,
    threePointsMade: row.threePointsMade,
    twoPointsInteriorMade: row.twoPointsInteriorMade,
    twoPointsExteriorMade: row.twoPointsExteriorMade,
    freeThrowsMade: row.freeThrowsMade,
    foulsCommitted: row.foulsCommitted,
  }));

  return { players: updatedPlayers, playerStats };
}
