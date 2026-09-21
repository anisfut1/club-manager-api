/**
 * EMarqueMatchData — structure produite par le parser e-Marque (voir
 * ARCHITECTURE.md §17). Toujours nullable quand une information n'a pas pu
 * être extraite avec confiance : null != 0 (§22), on ne devine jamais une
 * statistique absente.
 */

export type TeamSide = "home" | "away";
export type CoachRole = "principal" | "adjoint";
export type RefereeRole = "referee_1" | "referee_2" | "referee_3";
export type TableOfficialRole =
  | "scorer"
  | "assistant_scorer"
  | "timekeeper"
  | "shot_clock_operator"
  | "commissioner"
  | "other";

export interface EMarqueScoreByPeriod {
  period: number;
  home: number | null;
  away: number | null;
}

export interface EMarqueMatchInfo {
  rencontreNumero: string | null;
  competitionLabel: string | null;
  pouleLabel: string | null;
  date: string | null;
  heure: string | null;
  lieu: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeClubCode: string | null;
  awayClubCode: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  scoreByPeriod: EMarqueScoreByPeriod[];
}

export interface EMarquePlayer {
  teamSide: TeamSide;
  jerseyNumber: string | null;
  lastName: string | null;
  firstName: string | null;
  licenseNumber: string | null;
  isCaptain: boolean;
  isStarter: boolean | null;
  confidence: number | null;
}

export interface EMarqueCoach {
  teamSide: TeamSide;
  role: CoachRole;
  lastName: string | null;
  firstName: string | null;
  licenseNumber: string | null;
}

export interface EMarqueOfficial {
  role: RefereeRole;
  lastName: string | null;
  firstName: string | null;
  licenseNumber: string | null;
}

export interface EMarqueTableOfficial {
  role: TableOfficialRole;
  lastName: string | null;
  firstName: string | null;
  licenseNumber: string | null;
  confidence: number | null;
}

export interface EMarquePlayerStat {
  teamSide: TeamSide;
  jerseyNumber: string | null;
  lastName: string | null;
  firstName: string | null;
  secondsPlayed: number | null;
  points: number | null;
  shotsMade: number | null;
  threePointsMade: number | null;
  twoPointsInteriorMade: number | null;
  twoPointsExteriorMade: number | null;
  freeThrowsMade: number | null;
  foulsCommitted: number | null;
}

export type QualityWarningCode =
  | "MATCH_NUMBER_MISMATCH"
  | "SCORE_MISMATCH"
  | "LOW_EXTRACTION_CONFIDENCE"
  | "PLAYER_LICENSE_MISSING"
  | "OTM_LICENSE_MISSING"
  | "MINUTES_TOTAL_INCONSISTENT"
  | "SHOT_CHART_PARSE_FAILED"
  | "DOCUMENT_MISSING";

export interface EMarqueQualityWarning {
  code: QualityWarningCode;
  message: string;
  severity: "info" | "warning" | "error";
}

export interface EMarqueMatchData {
  match: EMarqueMatchInfo;
  players: EMarquePlayer[];
  coaches: EMarqueCoach[];
  officials: EMarqueOfficial[];
  tableOfficials: EMarqueTableOfficial[];
  playerStats: EMarquePlayerStat[];
  /** positiontir.pdf : expérimental, non parsé en V1 (voir ARCHITECTURE.md §23). */
  shotData: { experimental: true; documentPresent: boolean };
  quality: {
    warnings: EMarqueQualityWarning[];
    overallConfidence: number | null;
  };
}
