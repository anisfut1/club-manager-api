import { forbidden, notFound } from "../../api-error.js";
import type { TeamOverviewDto } from "../../contracts/trainings.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { matchTeamLife } from "../convocations/service.js";
import { canManageTeam, coachesTeam, listOccurrences, type TrainingCtx } from "./service.js";

/**
 * Page Équipe (Lot 4) : prochain match, prochain entraînement, réponses
 * attendues (coach), effectif. Pas un CRM : le strict nécessaire. Accès :
 * espace club = tout membre ; espace public = joueurs de l'équipe et ceux
 * qui la gèrent (coach / admin) — jamais un annuaire ouvert.
 */
export async function teamOverview(ctx: TrainingCtx, teamId: string, opts: { memberTeamIds?: string[] } = {}): Promise<TeamOverviewDto> {
  const { data: team } = await ctx.db.from("teams").select("id, name, sexe").eq("club_id", ctx.clubId).eq("id", teamId).maybeSingle();
  if (!team) throw notFound("Équipe introuvable pour ce club.");
  const manage = canManageTeam(ctx.actor, teamId);
  if (opts.memberTeamIds && !manage && !opts.memberTeamIds.includes(teamId)) throw forbidden("Réservé aux joueurs de cette équipe et à ceux qui la gèrent.", "TEAM_MEMBER_REQUIRED");

  const now = new Date();
  const nowIso = now.toISOString();
  const [{ data: matchRows }, trainings, { data: people }] = await Promise.all([
    ctx.db.from("matches").select("id, match_datetime, is_home, opponent_name, venue_raw_label, status").eq("club_id", ctx.clubId).eq("team_id", teamId).gte("match_datetime", nowIso).order("match_datetime", { ascending: true }).limit(5),
    listOccurrences(ctx, { teamIds: [teamId], from: nowIso, to: new Date(now.getTime() + 30 * 86_400_000).toISOString() }),
    ctx.db.from("licencies").select("id, first_name, last_name, photo_url, public_coach, coached_team_ids").eq("club_id", ctx.clubId).eq("active", true).eq("team_id", teamId),
  ]);

  const next = ((matchRows ?? []) as { id: string; match_datetime: string | null; is_home: boolean | null; opponent_name: string | null; venue_raw_label: string | null; status: string }[]).find((m) => m.status === "scheduled");
  let nextMatch: TeamOverviewDto["nextMatch"] = null;
  if (next) {
    let convocation: NonNullable<TeamOverviewDto["nextMatch"]>["convocation"] = null;
    let availability: NonNullable<TeamOverviewDto["nextMatch"]>["availability"] = null;
    let venueName = next.venue_raw_label;
    if (manage) {
      const tl = await matchTeamLife(ctx, next.id);
      venueName = tl.match.venueName;
      const sent = tl.convocation && tl.convocation.revision > 0 ? tl.convocation : null;
      convocation = { sent: Boolean(sent), ...(sent ? sent.counts : { convoked: 0, confirmed: 0, declined: 0, pending: 0 }) };
      availability = { open: tl.availability.openedAt !== null, noResponse: tl.availability.counts.noResponse };
    }
    nextMatch = { id: next.id, startsAt: next.match_datetime, isHome: next.is_home, opponent: next.opponent_name, venueName, convocation, availability };
  }

  const roster = ((people ?? []) as { id: string; first_name: string; last_name: string; photo_url: string | null; public_coach: boolean; coached_team_ids: string[] | null }[]).sort(
    (a, b) => a.last_name.localeCompare(b.last_name, "fr") || a.first_name.localeCompare(b.first_name, "fr"),
  );
  const attendance = manage ? await recentAttendance(ctx, teamId) : null;
  let linked = new Set<string>();
  if (manage && roster.length) {
    const { data: tokens } = await ctx.db.from("licencie_public_tokens").select("licencie_id").eq("club_id", ctx.clubId).in("licencie_id", roster.map((l) => l.id)).is("revoked_at", null);
    linked = new Set(((tokens ?? []) as { licencie_id: string }[]).map((t) => t.licencie_id));
  }

  return {
    team: { id: team.id, name: formatTeamNameWithGender(team.name, team.sexe) },
    canManage: manage,
    nextMatch,
    nextTraining: trainings.find((t) => t.status === "scheduled") ?? null,
    roster: roster.map((l) => ({
      licencie: { id: l.id, firstName: l.first_name, lastName: l.last_name, photoUrl: l.photo_url ?? null },
      isCoach: coachesTeam(l, teamId),
      hasPersonalLink: manage ? linked.has(l.id) : null,
      attendance: attendance ? { sessions: attendance.sessions, absent: attendance.absent.get(l.id) ?? 0, late: attendance.late.get(l.id) ?? 0 } : null,
    })),
  };
}

/** Nombre de séances prises en compte pour l'assiduité (retour du club, 2026-10-10). */
export const ATTENDANCE_WINDOW = 8;

/**
 * Assiduité simple (coach / admin) : absences et retards sur les
 * ATTENDANCE_WINDOW dernières séances RELEVÉES (au moins un relevé : même
 * règle que « Présence non relevée » côté Entraînements). Une séance sans relevé n'est pas comptée : on ne
 * suppose pas que tout le monde était là si le coach n'a rien noté.
 */
async function recentAttendance(ctx: TrainingCtx, teamId: string): Promise<{ sessions: number; absent: Map<string, number>; late: Map<string, number> }> {
  const { data: past } = await ctx.db
    .from("training_occurrences")
    .select("id, starts_at")
    .eq("club_id", ctx.clubId)
    .eq("team_id", teamId)
    .eq("status", "scheduled")
    .lte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: false })
    .limit(40);
  const ids = ((past ?? []) as { id: string }[]).map((o) => o.id);
  const absent = new Map<string, number>();
  const late = new Map<string, number>();
  if (!ids.length) return { sessions: 0, absent, late };
  const { data: marks } = await ctx.db.from("training_attendance").select("occurrence_id, licencie_id, status").eq("club_id", ctx.clubId).in("occurrence_id", ids);
  const rows = (marks ?? []) as { occurrence_id: string; licencie_id: string; status: string }[];
  const recorded = new Set(rows.map((m) => m.occurrence_id));
  const kept = new Set(ids.filter((id) => recorded.has(id)).slice(0, ATTENDANCE_WINDOW));
  for (const m of rows) {
    if (!kept.has(m.occurrence_id)) continue;
    const bucket = m.status === "ABSENT" ? absent : m.status === "LATE" ? late : null;
    bucket?.set(m.licencie_id, (bucket.get(m.licencie_id) ?? 0) + 1);
  }
  return { sessions: kept.size, absent, late };
}
