/**
 * DTO normalisés produits par FFBBPublicProvider. Le reste de l'application
 * (service de synchronisation, UI) ne doit jamais dépendre du format brut
 * Directus — voir ARCHITECTURE.md §8.1 (couche d'abstraction FFBBProvider).
 */

export interface NormalizedOrganisme {
  ffbbId: string;
  code: string;
  name: string;
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
  commune: string | null;
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
