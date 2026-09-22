/**
 * DTO normalisés produits par FFBBPublicProvider. Le reste de l'application
 * (service de synchronisation, UI) ne doit jamais dépendre du format brut
 * Directus — voir ARCHITECTURE.md §8.1 (couche d'abstraction FFBBProvider).
 */

export interface NormalizedOrganisme {
  ffbbId: string;
  code: string;
  name: string;
  /** Voir NormalizedMatch.opponentLogoUrl — même mécanisme (assets/{id}), pour le logo DU club lui-même. */
  logoUrl: string | null;
}

export interface NormalizedCompetition {
  ffbbId: string;
  name: string;
  code: string | null;
  sexe: string | null;
  typeCompetition: string | null;
  categoryCode: string | null;
  categoryLabel: string | null;
  phaseCode: string | null;
  liveStat: boolean;
  emarqueV2: boolean;
  publicationInternet: boolean;
  season: string | null;
  parentCompetitionFfbbId: string | null;
  raw: unknown;
}

export interface NormalizedPool {
  ffbbId: string;
  competitionFfbbId: string;
  name: string;
  raw: unknown;
}

export interface NormalizedTeamEngagement {
  ffbbId: string;
  name: string | null;
  numeroEquipe: string | null;
  competitionFfbbId: string;
  poolFfbbId: string | null;
  organismeFfbbId: string;
  raw: unknown;
}

export interface NormalizedVenue {
  ffbbId: string | null;
  name: string | null;
  /** Adresse complète (ffbbserver_salles.adresse) — l'API FFBB ne découpe pas rue/code postal/commune séparément. */
  address: string | null;
  raw: unknown;
}

export type NormalizedMatchStatus = "scheduled" | "played" | "postponed" | "cancelled" | "forfeit";

export interface NormalizedMatch {
  ffbbId: string;
  uniqueKey: string | null;
  gsId: string | null;
  numero: string | null;
  numeroJournee: string | null;
  competitionFfbbId: string | null;
  poolFfbbId: string | null;
  /** ffbb_engagement_id de NOTRE équipe (home ou away selon isHome). */
  ourEngagementFfbbId: string;
  isHome: boolean;
  opponentName: string | null;
  opponentOrganismeFfbbId: string | null;
  /**
   * URL construite (`{FFBB_API_BASE_URL}assets/{logo.id}`), jamais vérifiée
   * en direct si cet endpoint accepte les requêtes anonymes — voir
   * docs/FFBB.md. Renseignée par un appel séparé (`listOrganismeLogos`,
   * comme `listCompetitions`/`listPools`), jamais via la relation
   * `idOrganismeEquipe1/2` de la rencontre (pas d'expansion demandée là).
   */
  opponentLogoUrl: string | null;
  matchDateTime: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  status: NormalizedMatchStatus;
  venue: NormalizedVenue | null;
  raw: unknown;
}

/** Snapshot complet du club, obtenu en une passe de synchronisation. */
export interface FfbbClubSnapshot {
  organisme: NormalizedOrganisme;
  engagements: NormalizedTeamEngagement[];
  competitions: NormalizedCompetition[];
  pools: NormalizedPool[];
  matches: NormalizedMatch[];
}
