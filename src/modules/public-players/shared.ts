import type { DbClient } from "../../db/client.js";
import { notFound } from "../../api-error.js";
import { currentSeasonStart } from "../../season.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import type { TableAssignmentRoleDto } from "../../contracts/tables.js";
import type { PublicPlayerMatchDto, PublicPlayerProfileDto } from "../../contracts/public-players.js";

/** Lectures e-Marque jamais publiées (même garde-fou que `GET /v1/public/clubs/:clubSlug/matches/:matchId`). */
const UNPUBLISHED_EMARQUE = new Set(["needs_review", "error"]);
const RECENT_MATCHES_LIMIT = 10;
const TABLE_ROLES: TableAssignmentRoleDto[] = ["SCORER", "TIMEKEEPER", "CLUB_DELEGATE", "REFEREE"];

export interface PlayedMatchInput {
  matchId: string;
  matchDatetime: string | null;
  teamName: string | null;
  opponentName: string | null;
  isHome: boolean;
  scoreHome: number | null;
  scoreAway: number | null;
  jerseyNumber: string | null;
  isCaptain: boolean;
  isStarter: boolean;
  stats: { points: number | null; threePointsMade: number | null; freeThrowsMade: number | null; secondsPlayed: number | null } | null;
}

/** Résultat de l'équipe du club, `null` sans les deux scores (jamais deviné). */
export function matchResult(isHome: boolean, scoreHome: number | null, scoreAway: number | null): PublicPlayerMatchDto["result"] {
  if (scoreHome === null || scoreAway === null) return null;
  const own = isHome ? scoreHome : scoreAway;
  const other = isHome ? scoreAway : scoreHome;
  return own > other ? "WIN" : own < other ? "LOSS" : "DRAW";
}

/** Bilan de saison + derniers matchs — pur, testé sans base. Moyenne sur les seuls matchs dont les stats ont été lues. */
export function summarizePlayedMatches(played: PlayedMatchInput[]): Pick<PublicPlayerProfileDto, "season" | "recentMatches"> {
  const sorted = [...played].sort((a, b) => (b.matchDatetime ?? "").localeCompare(a.matchDatetime ?? ""));
  const withStats = sorted.filter((m) => m.stats && m.stats.points !== null);
  const totalPoints = withStats.reduce((sum, m) => sum + (m.stats!.points ?? 0), 0);
  const best = withStats.reduce<PlayedMatchInput | null>((top, m) => (top === null || (m.stats!.points ?? 0) > (top.stats!.points ?? 0) ? m : top), null);
  const results = sorted.map((m) => matchResult(m.isHome, m.scoreHome, m.scoreAway));

  return {
    season: {
      matchesPlayed: sorted.length,
      matchesWithStats: withStats.length,
      totalPoints,
      pointsPerMatch: withStats.length > 0 ? Math.round((totalPoints / withStats.length) * 10) / 10 : null,
      bestPoints: best ? (best.stats!.points ?? null) : null,
      bestPointsMatchId: best ? best.matchId : null,
      threePointsMade: sorted.reduce((sum, m) => sum + (m.stats?.threePointsMade ?? 0), 0),
      freeThrowsMade: sorted.reduce((sum, m) => sum + (m.stats?.freeThrowsMade ?? 0), 0),
      secondsPlayed: sorted.reduce((sum, m) => sum + (m.stats?.secondsPlayed ?? 0), 0),
      wins: results.filter((r) => r === "WIN").length,
      losses: results.filter((r) => r === "LOSS").length,
    },
    recentMatches: sorted.slice(0, RECENT_MATCHES_LIMIT).map((m, i) => ({
      matchId: m.matchId,
      matchDatetime: m.matchDatetime,
      teamName: m.teamName,
      opponentName: m.opponentName,
      isHome: m.isHome,
      scoreHome: m.scoreHome,
      scoreAway: m.scoreAway,
      result: results[i] ?? null,
      jerseyNumber: m.jerseyNumber,
      isCaptain: m.isCaptain,
      isStarter: m.isStarter,
      points: m.stats?.points ?? null,
      threePointsMade: m.stats?.threePointsMade ?? null,
      freeThrowsMade: m.stats?.freeThrowsMade ?? null,
      secondsPlayed: m.stats?.secondsPlayed ?? null,
    })),
  };
}

/**
 * Fiche joueur publique d'un·e licencié·e de CE club (voir
 * `contracts/public-players.ts`). Toute requête filtre par `clubId` : c'est
 * ce code, pas la RLS (client service), qui isole les clubs.
 */
export async function loadPublicPlayerProfile(supabase: DbClient, clubId: string, licencieId: string, now: Date = new Date()): Promise<PublicPlayerProfileDto> {
  const { data: licencie } = await supabase
    .from("licencies")
    .select("id, first_name, last_name, photo_url, category_label, sexe, team_id, coached_team_ids")
    .eq("id", licencieId)
    .eq("club_id", clubId)
    .maybeSingle();
  if (!licencie) throw notFound("Joueur introuvable.");

  const seasonStartIso = currentSeasonStart(now).toISOString();
  const nowIso = now.toISOString();

  const [{ data: participantRows }, { data: assignmentRows }] = await Promise.all([
    supabase
      .from("match_participants")
      .select("id, match_id, jersey_number, is_captain, is_starter, matches(match_datetime, is_home, opponent_name, score_home, score_away, emarque_status, team_id)")
      .eq("club_id", clubId)
      .eq("licencie_id", licencieId),
    supabase.from("table_assignments").select("match_id, role").eq("club_id", clubId).eq("licencie_id", licencieId),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const participations = (participantRows ?? []).filter((row: any) => {
    const match = row.matches;
    return match && match.match_datetime && match.match_datetime >= seasonStartIso && !UNPUBLISHED_EMARQUE.has(match.emarque_status);
  });

  const participantIds = participations.map((row) => row.id);
  const { data: statsRows } = participantIds.length
    ? await supabase.from("player_match_stats").select("participant_id, seconds_played, points, three_points_made, free_throws_made").in("participant_id", participantIds)
    : { data: [] as never[] };
  const statsByParticipantId = new Map((statsRows ?? []).map((row) => [row.participant_id, row]));

  // Matchs des tables (date) — requête séparée plutôt qu'un embed.
  const assignmentMatchIds = [...new Set((assignmentRows ?? []).map((a) => a.match_id))];
  const { data: assignmentMatches } = assignmentMatchIds.length
    ? await supabase.from("matches").select("id, match_datetime").eq("club_id", clubId).in("id", assignmentMatchIds)
    : { data: [] as never[] };
  const assignmentMatchDate = new Map((assignmentMatches ?? []).map((m) => [m.id, m.match_datetime as string | null]));

  const { data: nextMatchRow } = licencie.team_id
    ? await supabase
        .from("matches")
        .select("id, match_datetime, is_home, opponent_name, team_id")
        .eq("club_id", clubId)
        .eq("team_id", licencie.team_id)
        .gte("match_datetime", nowIso)
        .order("match_datetime", { ascending: true })
        .limit(1)
        .maybeSingle()
    : { data: null };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playedTeamIds = participations.map((row: any) => row.matches.team_id as string | null).filter((id): id is string => Boolean(id));
  const coachedTeamIds: string[] = licencie.coached_team_ids ?? [];
  const allTeamIds = [...new Set([licencie.team_id, ...playedTeamIds, ...coachedTeamIds].filter((id): id is string => Boolean(id)))];
  const { data: teamRows } = allTeamIds.length ? await supabase.from("teams").select("id, name, sexe").eq("club_id", clubId).in("id", allTeamIds) : { data: [] as never[] };
  const teamName = new Map((teamRows ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));

  const played: PlayedMatchInput[] = participations.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = (row as any).matches;
    const stats = statsByParticipantId.get(row.id);
    return {
      matchId: row.match_id,
      matchDatetime: match.match_datetime,
      teamName: match.team_id ? (teamName.get(match.team_id) ?? null) : null,
      opponentName: match.opponent_name,
      isHome: match.is_home === true,
      scoreHome: match.score_home,
      scoreAway: match.score_away,
      jerseyNumber: row.jersey_number,
      isCaptain: row.is_captain === true,
      isStarter: row.is_starter === true,
      stats: stats ? { points: stats.points, threePointsMade: stats.three_points_made, freeThrowsMade: stats.free_throws_made, secondsPlayed: stats.seconds_played } : null,
    };
  });

  const teams: PublicPlayerProfileDto["teams"] = [];
  for (const id of [licencie.team_id, ...playedTeamIds]) {
    if (id && teamName.has(id) && !teams.some((t) => t.id === id)) teams.push({ id, name: teamName.get(id)!, relation: "PLAYER" });
  }
  for (const id of coachedTeamIds) {
    if (teamName.has(id) && !teams.some((t) => t.id === id && t.relation === "COACH")) teams.push({ id, name: teamName.get(id)!, relation: "COACH" });
  }

  const seasonAssignments = (assignmentRows ?? []).filter((a) => {
    const date = assignmentMatchDate.get(a.match_id);
    return date && date >= seasonStartIso;
  });
  const doneAssignments = seasonAssignments.filter((a) => assignmentMatchDate.get(a.match_id)! < nowIso);

  return {
    player: {
      id: licencie.id,
      firstName: licencie.first_name,
      lastName: licencie.last_name,
      photoUrl: licencie.photo_url,
      categoryLabel: licencie.category_label,
      sexe: licencie.sexe === "M" || licencie.sexe === "F" ? licencie.sexe : null,
    },
    teams,
    ...summarizePlayedMatches(played),
    tables: {
      done: doneAssignments.length,
      upcoming: seasonAssignments.length - doneAssignments.length,
      byRole: TABLE_ROLES.map((role) => ({ role, count: doneAssignments.filter((a) => a.role === role).length })).filter((r) => r.count > 0),
    },
    nextMatch: nextMatchRow
      ? {
          matchId: nextMatchRow.id,
          matchDatetime: nextMatchRow.match_datetime,
          teamName: nextMatchRow.team_id ? (teamName.get(nextMatchRow.team_id) ?? null) : null,
          opponentName: nextMatchRow.opponent_name,
          isHome: nextMatchRow.is_home === true,
        }
      : null,
  };
}
