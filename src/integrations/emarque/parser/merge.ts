import type { EMarquePlayer, EMarquePlayerStat } from "../types.js";
import type { ResumeRowResult } from "./parse-resume.js";

/** Nom réduit à ses lettres (sans accents, casse, espaces ni ponctuation) — uniquement pour comparer deux graphies, jamais affiché ni persisté. */
function letters(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

/**
 * Deux graphies du même nom de famille ? L'une contient l'autre une fois
 * réduites à leurs lettres : absorbe l'initiale collée par l'OCR de
 * "feuillematch" ("MEHENNIS." pour MEHENNI S., "JACQUETE." pour JACQUET E.)
 * et la troncature ("CHAUSSINAND MOHAMM..." pour CHAUSSINAND MOHAMMED).
 */
function sameLastName(a: string | null, b: string | null): boolean {
  const x = letters(a);
  const y = letters(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
}

/** Initiales de prénom compatibles — inconnue d'un côté = pas de contradiction. */
function sameFirstInitial(a: string | null, b: string | null): boolean {
  const x = letters(a)[0];
  const y = letters(b)[0];
  return !x || !y || x === y;
}

/**
 * Maillot retenu quand les deux documents en ont lu un différent. "resume"
 * (tableau simple, une donnée par cellule) se lit mieux que "feuillematch"
 * (retour du club, 2026-10-06, rencontre n°2645 : "feuillematch" a lu 1
 * pour 9, 2 pour 22, 5 pour 15, 10 pour 8) — SAUF quand le maillot de
 * "resume" est contenu dans celui de "feuillematch" : chiffre perdu côté
 * "resume" (rencontre n°1481 : "1" lu pour 11).
 */
function resolveJerseyNumber(fromSheet: string | null, fromResume: string | null): string | null {
  if (!fromSheet) return fromResume;
  if (!fromResume || fromSheet === fromResume) return fromSheet;
  return fromSheet.length > fromResume.length && fromSheet.includes(fromResume) ? fromSheet : fromResume;
}

/**
 * Complète l'effectif "feuillematch" (licence, capitanat) avec les lignes
 * "resume" (identité complète, titulaire, statistiques).
 *
 * Retour du club, 2026-10-06 (rencontre n°2645, Seniors 1 M) : le
 * rapprochement se faisait d'abord par numéro de maillot, avec le maillot
 * de "feuillematch" jugé prioritaire. Or l'OCR de "feuillematch" lit
 * parfois un mauvais maillot : les statistiques de SALEM Sanaa (10)
 * s'affichaient sous "Sanaa SCHNEIDER" (maillot lu 10 pour SCHNEIDER Theo,
 * en réalité 8), avec la licence du mauvais joueur.
 *
 * Désormais :
 * 1. rapprochement par NOM DE FAMILLE (+ initiale du prénom) d'abord, sans
 *    ambiguïté uniquement — une ligne et un joueur qui ne se désignent
 *    l'un l'autre que mutuellement ;
 * 2. puis par maillot, seulement si les noms ne se contredisent pas ;
 * 3. identité affichée = celle de "resume" (NOM, Prénom complets et
 *    propres) quand elle est lue, licence et capitanat = "feuillematch" ;
 * 4. maillot : voir `resolveJerseyNumber`.
 * Une ligne "resume" sans joueur correspondant devient un joueur à part
 * entière (sans licence — jamais inventée) ; un joueur "feuillematch" sans
 * ligne correspondante est conservé, sans statistiques.
 */
export function mergePlayersWithStats(
  players: EMarquePlayer[],
  statsRows: ResumeRowResult[],
): { players: EMarquePlayer[]; playerStats: EMarquePlayerStat[] } {
  const pairs = new Map<number, number>(); // index ligne "resume" -> index joueur "feuillematch"
  const pairedPlayers = new Set<number>();

  // 1. Par nom : candidats compatibles de chaque ligne, puis appariement
  //    mutuellement unique (un joueur revendiqué par deux lignes = ambigu).
  const candidatesByRow = statsRows.map((row) =>
    players
      .map((player, index) => ({ player, index }))
      .filter(({ player }) => player.teamSide === row.teamSide && sameLastName(player.lastName, row.lastName) && sameFirstInitial(player.firstName, row.firstName))
      .map(({ index }) => index),
  );
  const claimsByPlayer = new Map<number, number>();
  for (const candidates of candidatesByRow) for (const index of candidates) claimsByPlayer.set(index, (claimsByPlayer.get(index) ?? 0) + 1);

  statsRows.forEach((row, rowIndex) => {
    let candidates = candidatesByRow[rowIndex]!;
    if (candidates.length > 1) candidates = candidates.filter((index) => players[index]!.jerseyNumber === row.jerseyNumber);
    if (candidates.length !== 1) return;
    const playerIndex = candidates[0]!;
    if (pairedPlayers.has(playerIndex) || (claimsByPlayer.get(playerIndex) ?? 0) > 1) return;
    pairs.set(rowIndex, playerIndex);
    pairedPlayers.add(playerIndex);
  });

  // 2. Par maillot, pour le reste — jamais quand les deux noms sont lus et
  //    se contredisent.
  statsRows.forEach((row, rowIndex) => {
    if (pairs.has(rowIndex) || row.jerseyNumber === null) return;
    const playerIndex = players.findIndex(
      (player, index) =>
        !pairedPlayers.has(index) &&
        player.teamSide === row.teamSide &&
        player.jerseyNumber === row.jerseyNumber &&
        (!letters(player.lastName) || !letters(row.lastName) || sameLastName(player.lastName, row.lastName)),
    );
    if (playerIndex === -1) return;
    pairs.set(rowIndex, playerIndex);
    pairedPlayers.add(playerIndex);
  });

  const merged: EMarquePlayer[] = [];
  const playerStats: EMarquePlayerStat[] = [];

  statsRows.forEach((row, rowIndex) => {
    const playerIndex = pairs.get(rowIndex);
    const sheetPlayer = playerIndex === undefined ? null : players[playerIndex]!;
    const jerseyNumber = resolveJerseyNumber(sheetPlayer?.jerseyNumber ?? null, row.jerseyNumber);

    merged.push({
      teamSide: row.teamSide,
      jerseyNumber,
      lastName: row.lastName ?? sheetPlayer?.lastName ?? null,
      firstName: row.firstName ?? sheetPlayer?.firstName ?? null,
      licenseNumber: sheetPlayer?.licenseNumber ?? null,
      isCaptain: sheetPlayer?.isCaptain ?? false,
      isStarter: row.isStarter,
      confidence: sheetPlayer?.confidence ?? null,
    });
    playerStats.push({
      teamSide: row.teamSide,
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
    });
  });

  // Joueurs "feuillematch" sans ligne "resume" : conservés, sans maillot
  // s'il est déjà porté par un autre joueur de la même équipe (maillot mal
  // lu) — sans quoi les statistiques de l'autre pourraient s'y rattacher.
  const takenJerseys = new Set(merged.map((player) => `${player.teamSide}:${player.jerseyNumber ?? ""}`));
  players.forEach((player, index) => {
    if (pairedPlayers.has(index)) return;
    const key = `${player.teamSide}:${player.jerseyNumber ?? ""}`;
    const jerseyNumber = player.jerseyNumber !== null && takenJerseys.has(key) ? null : player.jerseyNumber;
    if (jerseyNumber !== null) takenJerseys.add(key);
    merged.push({ ...player, jerseyNumber });
  });

  return { players: merged, playerStats };
}
