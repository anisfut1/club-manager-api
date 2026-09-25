import type { EMarquePlayer, EMarquePlayerStat } from "../types.js";
import type { ResumeRowResult } from "./parse-resume.js";

function statKey(teamSide: string, jerseyNumber: string | null): string {
  return `${teamSide}:${jerseyNumber ?? ""}`;
}

/**
 * Normalise un nom pour une comparaison approximative (voir
 * `matchByLastName` ci-dessous) : jamais utilisé pour l'affichage ou la
 * persistance, uniquement pour décider si deux graphies désignent
 * probablement la même personne.
 */
function normalizeLastName(lastName: string | null): string | null {
  if (!lastName) return null;
  const normalized = lastName.trim().toUpperCase().replace(/\s+/g, " ");
  return normalized || null;
}

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
 * Corrigé une première fois en synthétisant un joueur minimal à partir de
 * la ligne "resume" quand aucun joueur "feuillematch" ne correspond par
 * maillot exact.
 *
 * Constaté ENSUITE en production (même rencontre, § "Trente-troisième
 * déclenchement", docs/FBI.md) : ce premier correctif créait un DOUBLON
 * quand "feuillematch" avait bien trouvé le joueur (nom, licence, statut
 * capitaine — des données que "resume" n'a jamais) mais avait échoué à en
 * lire SEULEMENT le numéro de maillot — la comparaison stricte par maillot
 * ne pouvait jamais les rapprocher, donc chacun des deux documents
 * produisait sa propre ligne pour la même personne. Corrigé : avant de
 * synthétiser un nouveau joueur, on tente un rapprochement par NOM DE
 * FAMILLE avec un joueur "feuillematch" dont le maillot est manquant — mais
 * SEULEMENT quand ce rapprochement est SANS AMBIGUÏTÉ (exactement un
 * candidat), jamais une supposition risquée entre plusieurs possibles.
 * L'identité (nom, prénom, licence, capitanat) reste TOUJOURS celle de
 * "feuillematch" dans ce cas — seuls le maillot et le statut titulaire,
 * que "feuillematch" n'avait pas, viennent de "resume".
 */
export function mergePlayersWithStats(
  players: EMarquePlayer[],
  statsRows: ResumeRowResult[],
): { players: EMarquePlayer[]; playerStats: EMarquePlayerStat[] } {
  const claimedStatKeys = new Set<string>();

  // Passe 1 : rapprochement exact par maillot (fiable, prioritaire) — sur
  // TOUS les joueurs d'abord, pour que la passe 2 (approximative) ne
  // considère que les lignes "resume" restées sans propriétaire après ça.
  const exactMatchedPlayers = players.map((player) => {
    if (player.jerseyNumber === null) return player;
    const match = statsRows.find((row) => row.teamSide === player.teamSide && row.jerseyNumber === player.jerseyNumber);
    if (!match) return player;
    claimedStatKeys.add(statKey(match.teamSide, match.jerseyNumber));
    return { ...player, isStarter: match.isStarter };
  });

  // Passe 2 : pour un joueur "feuillematch" dont le maillot n'a jamais pu
  // être lu, tente un rapprochement par nom de famille avec une ligne
  // "resume" encore non réclamée, sur la même équipe.
  const updatedPlayers = exactMatchedPlayers.map((player) => {
    if (player.jerseyNumber !== null) return player;

    const normalizedPlayerLastName = normalizeLastName(player.lastName);
    if (!normalizedPlayerLastName) return player;

    const candidates = statsRows.filter((row) => {
      if (row.teamSide !== player.teamSide || claimedStatKeys.has(statKey(row.teamSide, row.jerseyNumber))) return false;
      const normalizedRowLastName = normalizeLastName(row.lastName);
      if (!normalizedRowLastName) return false;
      return normalizedPlayerLastName.includes(normalizedRowLastName) || normalizedRowLastName.includes(normalizedPlayerLastName);
    });

    if (candidates.length !== 1) return player;

    const match = candidates[0]!;
    claimedStatKeys.add(statKey(match.teamSide, match.jerseyNumber));
    return { ...player, jerseyNumber: match.jerseyNumber, isStarter: match.isStarter };
  });

  const synthesizedPlayers: EMarquePlayer[] = statsRows
    .filter((row) => !claimedStatKeys.has(statKey(row.teamSide, row.jerseyNumber)))
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
