import type { EMarquePlayer, EMarquePlayerStat, TeamSide } from "../types.js";
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
 * FAMILLE avec un joueur "feuillematch" — mais SEULEMENT quand ce
 * rapprochement est SANS AMBIGUÏTÉ (exactement un candidat), jamais une
 * supposition risquée entre plusieurs possibles.
 *
 * Constaté ENCORE ENSUITE en production (même rencontre n°1481, §
 * "Trente-cinquième déclenchement", docs/FBI.md) : le rapprochement par nom
 * ci-dessus ne se déclenchait QUE quand le maillot "feuillematch" était
 * `null` — pas quand "feuillematch" avait bien lu un maillot mais que
 * "resume" avait mal lu LE SIEN (ex : "11" lu "1", confusion connue sur un
 * chiffre répété, voir `parse-resume.ts`). Dans ce cas la comparaison
 * exacte de la passe 1 échouait des deux côtés (aucune ligne "resume" n'a
 * le maillot "11"), et la ligne "resume" au maillot erroné ("1") restait
 * non réclamée puis synthétisée en un DEUXIÈME participant fantôme (sans
 * licence) — les vraies statistiques de la joueuse s'attachaient à ce
 * fantôme, jamais à son participant licencié. Corrigé : la passe 2
 * s'applique désormais à tout joueur "feuillematch" non rapproché par la
 * passe 1, maillot lu ou non — mais ne réattribue JAMAIS un maillot déjà
 * lu par "feuillematch" (plus fiable que celui, potentiellement erroné, de
 * "resume") : seul un maillot `null` est comblé depuis "resume".
 *
 * Profite de ce rapprochement par nom pour ramener aussi le PRÉNOM COMPLET
 * de "resume" ("NOM, Prénom", jamais abrégé) par-dessus celui, abrégé à une
 * lettre, de "feuillematch" ("NOM P." — c'est le document lui-même qui
 * l'imprime ainsi, voir `splitUppercaseAbbreviatedName`) — demande du club
 * (§ "Trente-cinquième déclenchement") en vue d'une future fiche joueur
 * lisible. Le reste de l'identité (nom de famille, licence, capitanat)
 * reste TOUJOURS celui de "feuillematch", jamais écrasé par "resume".
 */
export function mergePlayersWithStats(
  players: EMarquePlayer[],
  statsRows: ResumeRowResult[],
): { players: EMarquePlayer[]; playerStats: EMarquePlayerStat[] } {
  const claimedStatKeys = new Set<string>();
  const matchedPlayerIndices = new Set<number>();
  // Statistiques résolues, réindexées sous l'IDENTITÉ FINALE du joueur
  // (jamais celle, potentiellement erronée, lue par "resume") — sans quoi
  // `persist-emarque-match.ts#insertPlayerStats` (qui recherche le
  // participant par `${teamSide}:${jerseyNumber}`) ne retrouverait plus la
  // ligne quand la passe 2 corrige un maillot "resume" faux : exactement le
  // bug du "Trente-deuxième déclenchement" réapparaissant sous une autre
  // forme si on avait laissé `playerStats` dérivé naïvement de `statsRows`.
  const resolvedStats: Array<{ teamSide: TeamSide; jerseyNumber: string | null; row: ResumeRowResult }> = [];

  // Passe 1 : rapprochement exact par maillot (fiable, prioritaire) — sur
  // TOUS les joueurs d'abord, pour que la passe 2 (approximative) ne
  // considère que les lignes "resume" restées sans propriétaire après ça.
  const exactMatchedPlayers = players.map((player, index) => {
    if (player.jerseyNumber === null) return player;
    const match = statsRows.find((row) => row.teamSide === player.teamSide && row.jerseyNumber === player.jerseyNumber);
    if (!match) return player;
    claimedStatKeys.add(statKey(match.teamSide, match.jerseyNumber));
    matchedPlayerIndices.add(index);
    resolvedStats.push({ teamSide: player.teamSide, jerseyNumber: player.jerseyNumber, row: match });
    return { ...player, isStarter: match.isStarter, firstName: match.firstName ?? player.firstName };
  });

  // Passe 2 : pour un joueur "feuillematch" non rapproché par la passe 1
  // (maillot manquant OU maillot lu mais sans ligne "resume" correspondante,
  // voir la note ci-dessus), tente un rapprochement par nom de famille avec
  // une ligne "resume" encore non réclamée, sur la même équipe.
  const updatedPlayers = exactMatchedPlayers.map((player, index) => {
    if (matchedPlayerIndices.has(index)) return player;

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
    // Ne comble le maillot depuis "resume" que s'il manquait : un maillot
    // déjà lu par "feuillematch" est toujours conservé tel quel, jamais
    // remplacé par celui, potentiellement erroné, de "resume".
    const resolvedJerseyNumber = player.jerseyNumber ?? match.jerseyNumber;
    resolvedStats.push({ teamSide: player.teamSide, jerseyNumber: resolvedJerseyNumber, row: match });
    return { ...player, jerseyNumber: resolvedJerseyNumber, isStarter: match.isStarter, firstName: match.firstName ?? player.firstName };
  });

  const synthesizedPlayers: EMarquePlayer[] = statsRows
    .filter((row) => !claimedStatKeys.has(statKey(row.teamSide, row.jerseyNumber)))
    .map((row) => {
      resolvedStats.push({ teamSide: row.teamSide, jerseyNumber: row.jerseyNumber, row });
      return {
        teamSide: row.teamSide,
        jerseyNumber: row.jerseyNumber,
        lastName: row.lastName,
        firstName: row.firstName,
        licenseNumber: null,
        isCaptain: false,
        isStarter: row.isStarter,
        confidence: null,
      };
    });

  const playerStats: EMarquePlayerStat[] = resolvedStats.map(({ teamSide, jerseyNumber, row }) => ({
    teamSide,
    jerseyNumber,
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
