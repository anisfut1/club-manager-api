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
    })),
  };
}
