/**
 * Détection de conflits horaire/lieu (demande du club, 2026-09-25) : "faut
 * voir si ya pas des matchs prévus à la même heure au même endroit, genre
 * 2 équipes qui jouent le dimanche à 11h à Clavel" — deux rencontres À
 * DOMICILE du club, même date/heure EXACTE, même salle : le club ne peut
 * matériellement pas faire jouer les deux en même temps au même endroit.
 *
 * Scope volontairement restreint aux rencontres À DOMICILE (`isHome`) :
 * seules celles-là occupent une salle DU CLUB — deux rencontres à
 * l'extérieur au même horaire ne sont jamais un problème pour le club lui-
 * même. Comparaison sur l'horaire EXACT (pas de tolérance devinée) et sur
 * `venueId` quand les deux rencontres en ont un (identité de salle la plus
 * fiable — résolue par la synchro FFBB), sinon sur `venueRawLabel` normalisé
 * (texte brut FFBB, toujours présent même sans résolution de salle).
 */

export interface VenueConflictCandidate {
  id: string;
  numero: string | null;
  opponentName: string | null;
  matchDatetime: string;
  venueId: string | null;
  venueRawLabel: string | null;
}

export interface VenueConflictResult {
  matchId: string;
  conflictingMatchIds: string[];
  conflictingLabel: string;
}

function venueKey(m: VenueConflictCandidate): string | null {
  if (m.venueId) return `id:${m.venueId}`;
  if (m.venueRawLabel && m.venueRawLabel.trim()) return `label:${m.venueRawLabel.trim().toUpperCase()}`;
  return null;
}

/**
 * Fonction PURE : `candidates` doit déjà être filtré par l'appelant (à
 * domicile, saison en cours, date/heure connue — voir modules/issues/routes.ts).
 * Renvoie une entrée PAR rencontre impliquée dans un conflit (une rencontre
 * peut apparaître dans plusieurs conflits si elle en chevauche plusieurs —
 * cas limite non exclu, mais chaque entrée reste correcte individuellement).
 */
export function detectVenueConflicts(candidates: VenueConflictCandidate[]): VenueConflictResult[] {
  const groups = new Map<string, VenueConflictCandidate[]>();

  for (const candidate of candidates) {
    const key = venueKey(candidate);
    if (!key) continue;

    const groupKey = `${candidate.matchDatetime}::${key}`;
    const bucket = groups.get(groupKey) ?? [];
    bucket.push(candidate);
    groups.set(groupKey, bucket);
  }

  const results: VenueConflictResult[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;

    for (const match of bucket) {
      const others = bucket.filter((other) => other.id !== match.id);
      results.push({
        matchId: match.id,
        conflictingMatchIds: others.map((other) => other.id),
        conflictingLabel: others.map((other) => `n°${other.numero ?? "?"} vs ${other.opponentName ?? "?"}`).join(", "),
      });
    }
  }

  return results;
}
