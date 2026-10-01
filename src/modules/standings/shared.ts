import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import type { PoolStandingsDto } from "../../contracts/standings.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";

/** Forme stockée dans `pools.standings` (NormalizedStandingRow, voir integrations/ffbb/types.ts) — relue défensivement, jamais supposée. */
const StoredStandingRowSchema = z.object({
  engagementFfbbId: z.string().nullable().optional(),
  teamName: z.string(),
  logoUrl: z.string().nullable().optional(),
  position: z.number().nullable().optional(),
  points: z.number().nullable().optional(),
  played: z.number().nullable().optional(),
  won: z.number().nullable().optional(),
  lost: z.number().nullable().optional(),
  draws: z.number().nullable().optional(),
  forfeits: z.number().nullable().optional(),
  pointsFor: z.number().nullable().optional(),
  pointsAgainst: z.number().nullable().optional(),
  difference: z.number().nullable().optional(),
  outOfRanking: z.boolean().optional(),
});

/**
 * Classements des poules où CE club a un engagement FFBB. `pools` est un
 * référentiel global : le filtrage par club passe EXCLUSIVEMENT par
 * `ffbb_team_engagements.club_id` (jamais une poule d'un autre club).
 */
export async function loadClubStandings(supabase: DbClient, clubId: string): Promise<PoolStandingsDto[]> {
  const { data: engagements, error } = await supabase.from("ffbb_team_engagements").select("ffbb_engagement_id, team_id, pool_id").eq("club_id", clubId);
  if (error) throw new Error(`Lecture des engagements échouée : ${error.message}`);

  const poolIds = [...new Set((engagements ?? []).map((e) => e.pool_id).filter((id): id is string => id !== null))];
  if (poolIds.length === 0) return [];

  const clubEngagementIds = new Set((engagements ?? []).map((e) => e.ffbb_engagement_id));
  const teamIdByPoolId = new Map((engagements ?? []).filter((e) => e.pool_id).map((e) => [e.pool_id as string, e.team_id]));

  const { data: pools, error: poolsError } = await supabase.from("pools").select("id, name, competition_id, standings, standings_updated_at").in("id", poolIds);
  if (poolsError) throw new Error(`Lecture des poules échouée : ${poolsError.message}`);

  const competitionIds = [...new Set((pools ?? []).map((p) => p.competition_id))];
  const teamIds = [...new Set([...teamIdByPoolId.values()])];
  const [{ data: competitions }, { data: teams }] = await Promise.all([
    competitionIds.length ? supabase.from("competitions").select("id, name, category_label").in("id", competitionIds) : Promise.resolve({ data: [] as { id: string; name: string; category_label: string | null }[] }),
    teamIds.length ? supabase.from("teams").select("id, name, sexe").in("id", teamIds) : Promise.resolve({ data: [] as { id: string; name: string; sexe: "M" | "F" | null }[] }),
  ]);
  const competitionById = new Map((competitions ?? []).map((c) => [c.id, c]));
  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));

  const result: PoolStandingsDto[] = [];
  for (const pool of pools ?? []) {
    const parsed = z.array(StoredStandingRowSchema).safeParse(pool.standings);
    if (!parsed.success || parsed.data.length === 0) continue;

    const competition = competitionById.get(pool.competition_id);
    const teamId = teamIdByPoolId.get(pool.id) ?? null;
    const team = teamId ? teamById.get(teamId) : undefined;

    result.push({
      poolId: pool.id,
      poolName: pool.name,
      competitionName: competition?.name ?? null,
      categoryLabel: competition?.category_label ?? null,
      teamId,
      teamName: team ? formatTeamNameWithGender(team.name, team.sexe) : null,
      updatedAt: pool.standings_updated_at,
      rows: parsed.data.map((row) => ({
        position: row.position ?? null,
        teamName: row.teamName,
        logoUrl: row.logoUrl ?? null,
        points: row.points ?? null,
        played: row.played ?? null,
        won: row.won ?? null,
        lost: row.lost ?? null,
        draws: row.draws ?? null,
        forfeits: row.forfeits ?? null,
        pointsFor: row.pointsFor ?? null,
        pointsAgainst: row.pointsAgainst ?? null,
        difference: row.difference ?? null,
        outOfRanking: row.outOfRanking ?? false,
        isClub: row.engagementFfbbId ? clubEngagementIds.has(row.engagementFfbbId) : false,
      })),
    });
  }

  return result.sort((a, b) => (a.teamName ?? a.categoryLabel ?? "").localeCompare(b.teamName ?? b.categoryLabel ?? "", "fr") || a.poolName.localeCompare(b.poolName, "fr"));
}
