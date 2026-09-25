import type { EMarquePlayer, EMarquePlayerStat } from "../types.js";
import type { ResumeRowResult } from "./parse-resume.js";

/**
 * Complète l'effectif (identité + licence, extrait de feuillematch) avec le
 * statut "titulaire" et les statistiques (extraits de resume), en les
 * rapprochant par numéro de maillot + équipe (les deux documents partagent
 * cette numérotation, contrairement au numéro de licence qui n'apparaît pas
 * dans "resume").
 *
 * Constaté en production (rencontre n°1481, § "Trente-deuxième
 * déclenchement", docs/FBI.md) : une ligne de statistiques SANS joueur
 * correspondant dans l'effectif (ex : numéro de maillot mal lu côté
 * "feuillematch", document à la calibration OCR moins fiable, voir
 * `feuillematch-layout.ts`) était conservée dans `playerStats` mais
 * `persist-emarque-match.ts#insertPlayerStats` l'ignore silencieusement
 * faute de `participant_id` à quoi la rattacher — le joueur disparaissait
 * ENTIÈREMENT de l'affichage malgré des statistiques parfaitement lues.
 * Corrigé : un joueur minimal est désormais synthétisé À PARTIR de la
 * ligne "resume" elle-même (jersey, nom, titulaire — déjà lus par
 * `parse-resume.ts`) quand aucun joueur "feuillematch" ne correspond,
 * pour que `insertParticipants` crée bien une ligne à laquelle rattacher
 * la statistique. Jamais de licence inventée (`licenseNumber: null`,
 * jamais de `licencie_id` lié) : seule l'identité de base vient de
 * "resume", cohérent avec le principe "jamais deviner" (ARCHITECTURE.md
 * §22/§26) — seule une VRAIE correspondance de numéro de licence relie un
 * participant à un licencié existant.
 */
export function mergePlayersWithStats(
  players: EMarquePlayer[],
  statsRows: ResumeRowResult[],
): { players: EMarquePlayer[]; playerStats: EMarquePlayerStat[] } {
  const updatedPlayers = players.map((player) => {
    const match = statsRows.find((row) => row.teamSide === player.teamSide && row.jerseyNumber === player.jerseyNumber);
    return match ? { ...player, isStarter: match.isStarter } : player;
  });

  const synthesizedPlayers: EMarquePlayer[] = statsRows
    .filter((row) => !players.some((player) => player.teamSide === row.teamSide && player.jerseyNumber === row.jerseyNumber))
    .map((row) => ({
      teamSide: row.teamSide,
      jerseyNumber: row.jerseyNumber,
      lastName: row.lastName,
      firstName: row.firstName,
      licenseNumber: null,
      isCaptain: false,
      isStarter: row.isStarter,
      confidence: null,
    }));

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

  return { players: [...updatedPlayers, ...synthesizedPlayers], playerStats };
}
