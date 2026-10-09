import type { DbClient } from "../../db/client.js";
import { loadActor } from "../derogation-requests/service.js";
import { isLicencieClubAdmin } from "../public-tables/routes.js";
import type { TrainingActor } from "./service.js";

/**
 * Droits « Vie d'équipe » (voir docs/TEAM_LIFE.md) :
 * - compte : `club_admin` → toutes les équipes ; rôle coach → son équipe
 *   (portée vide = toutes) ;
 * - lien personnel : admin désigné depuis /joueurs (ou compte club_admin
 *   rattaché) → toutes ; coach → les équipes cochées sur sa fiche
 *   (`coached_team_ids`), jamais les autres.
 */
export async function actorFromAccount(db: DbClient, membershipId: string, userId: string, isPlatformAdmin: boolean): Promise<TrainingActor> {
  const actor = await loadActor(db, membershipId, userId);
  const coach = actor.roles.filter((r) => r.role === "coach");
  return {
    isAdmin: isPlatformAdmin || actor.roles.some((r) => r.role === "club_admin"),
    coachTeamIds: coach.some((r) => r.scopeTeamId === null) ? "ALL" : new Set(coach.map((r) => r.scopeTeamId).filter((id): id is string => Boolean(id))),
    userId,
    licencieId: actor.licencieId,
  };
}

export async function actorFromLicencie(db: DbClient, clubId: string, licencieId: string): Promise<TrainingActor & { teamId: string | null; coachTeamList: string[] }> {
  const { data } = await db.from("licencies").select("team_id, public_admin, public_coach, coached_team_ids").eq("id", licencieId).eq("club_id", clubId).maybeSingle();
  const isAdmin = data?.public_admin === true || (await isLicencieClubAdmin(db, clubId, licencieId));
  const coachTeamList = data?.public_coach ? [...(data.coached_team_ids ?? [])] : [];
  return { isAdmin, coachTeamIds: new Set(coachTeamList), userId: null, licencieId, teamId: data?.team_id ?? null, coachTeamList };
}
