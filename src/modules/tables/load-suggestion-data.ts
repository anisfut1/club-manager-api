import type { DbClient } from "../../db/client.js";
import { computeDayRange } from "../../util/timezone.js";
import { computeMatchWindow } from "./match-window.js";
import { DEFAULT_MATCH_DURATION_MINUTES } from "./suggestion-policy.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { currentSeasonStart } from "../../season.js";
import type { ExistingAssignmentOccurrence, LicencieCandidateInput, TeamMatchOccurrence } from "./table-suggestion-service.js";

/**
 * Charge TOUT ce dont le moteur pur (`table-suggestion-service.ts`) a
 * besoin pour un match cible donné — seule partie du module qui touche
 * Supabase (§35 : le moteur lui-même reste 100% pur/testable sans DB).
 *
 * Périmètre "même jour calendaire" (§12 de la demande — les exemples
 * d'enchaînement à domicile sont toujours intra-journée) : les matchs et
 * affectations chargés ici sont bornés au jour du match cible, DANS LE
 * FUSEAU DU CLUB (`computeDayRange`). Un conflit avec un match d'un AUTRE
 * jour n'existe pas par construction (`intervalsOverlap` sur des fenêtres
 * de 120 min ne peut de toute façon jamais chevaucher un jour différent).
 */
export interface ClubDayContext {
  candidates: LicencieCandidateInput[];
  teamMatches: TeamMatchOccurrence[];
  existingTableAssignments: ExistingAssignmentOccurrence[];
  seasonAssignmentCountByLicencieId: Map<string, number>;
  todayAssignmentCountByLicencieId: Map<string, number>;
}

export async function loadClubDayContext(supabase: DbClient, clubId: string, targetMatchDatetime: Date, clubTimezone: string): Promise<ClubDayContext> {
  const dayRange = computeDayRange(targetMatchDatetime, clubTimezone);
  const seasonStart = currentSeasonStart();

  const [{ data: licencies }, { data: teams }, { data: dayMatches }] = await Promise.all([
    // Licenciés ACTIFS uniquement (§16 : un·e licencié·e ayant quitté le
    // club n'a pas à être suggéré·e) — contrairement à `GET .../licencies`
    // (liste admin, qui montre aussi les inactifs pour archivage).
    supabase.from("licencies").select("id, first_name, last_name, team_id").eq("club_id", clubId).eq("active", true),
    supabase.from("teams").select("id, name, sexe").eq("club_id", clubId),
    supabase
      .from("matches")
      .select("id, team_id, is_home, match_datetime, venue_raw_label, opponent_name")
      .eq("club_id", clubId)
      .gte("match_datetime", dayRange.from)
      .lt("match_datetime", dayRange.to),
  ]);

  const teamNameById = new Map((teams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));

  const candidates: LicencieCandidateInput[] = (licencies ?? []).map((l) => {
    const teamIds = l.team_id ? [l.team_id] : [];
    return {
      licencieId: l.id,
      firstName: l.first_name,
      lastName: l.last_name,
      teamIds,
      teamNames: teamNameById,
    };
  });

  const dayMatchesWithWindow = (dayMatches ?? [])
    .filter((m): m is typeof m & { match_datetime: string } => m.match_datetime !== null)
    .map((m) => ({ ...m, window: computeMatchWindow(new Date(m.match_datetime), DEFAULT_MATCH_DURATION_MINUTES) }));

  const teamMatches: TeamMatchOccurrence[] = dayMatchesWithWindow
    .filter((m): m is typeof m & { team_id: string } => m.team_id !== null)
    .map((m) => ({
      matchId: m.id,
      teamId: m.team_id,
      isHome: m.is_home === true,
      window: m.window,
      venueRawLabel: m.venue_raw_label,
      opponentName: m.opponent_name,
    }));

  const dayMatchIds = dayMatchesWithWindow.map((m) => m.id);
  const dayMatchWindowById = new Map(dayMatchesWithWindow.map((m) => [m.id, m.window]));

  const { data: dayAssignments } = dayMatchIds.length
    ? await supabase.from("table_assignments").select("match_id, role, licencie_id").eq("club_id", clubId).in("match_id", dayMatchIds)
    : { data: [] };

  const existingTableAssignments: ExistingAssignmentOccurrence[] = (dayAssignments ?? [])
    .map((a) => {
      const window = dayMatchWindowById.get(a.match_id);
      // Ne devrait jamais arriver (les affectations référencent toujours un
      // match déjà chargé ci-dessus, via la même fenêtre de jour) — filtré
      // par sécurité plutôt qu'un crash si l'invariant est un jour rompu.
      if (!window) return null;
      return { matchId: a.match_id, role: a.role, licencieId: a.licencie_id, window };
    })
    .filter((a): a is ExistingAssignmentOccurrence => a !== null);

  const todayAssignmentCountByLicencieId = new Map<string, number>();
  for (const a of dayAssignments ?? []) {
    todayAssignmentCountByLicencieId.set(a.licencie_id, (todayAssignmentCountByLicencieId.get(a.licencie_id) ?? 0) + 1);
  }

  // Équité "cette saison" (§20/§47/§48) : bornée à TOUS les matchs du club
  // depuis le début de saison (`currentSeasonStart()`, réutilisé tel quel
  // — voir src/season.ts), pas seulement ceux du jour cible.
  const { data: seasonMatches } = await supabase.from("matches").select("id").eq("club_id", clubId).gte("match_datetime", seasonStart.toISOString());
  const seasonMatchIds = (seasonMatches ?? []).map((m) => m.id);
  const { data: seasonAssignments } = seasonMatchIds.length
    ? await supabase.from("table_assignments").select("licencie_id").eq("club_id", clubId).in("match_id", seasonMatchIds)
    : { data: [] };

  const seasonAssignmentCountByLicencieId = new Map<string, number>();
  for (const a of seasonAssignments ?? []) {
    seasonAssignmentCountByLicencieId.set(a.licencie_id, (seasonAssignmentCountByLicencieId.get(a.licencie_id) ?? 0) + 1);
  }

  return { candidates, teamMatches, existingTableAssignments, seasonAssignmentCountByLicencieId, todayAssignmentCountByLicencieId };
}
