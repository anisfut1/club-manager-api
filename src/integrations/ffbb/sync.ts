import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/types.js";
import type { FfbbPublicProvider } from "./public-provider.js";
import type { NormalizedCompetition, NormalizedPool, NormalizedTeamEngagement } from "./types.js";
import { diffTrackedFields, mapNormalizedMatchToRow, shouldRequestEmarque } from "./mapping.js";
import { logError, logInfo } from "../../logger.js";

type Client = SupabaseClient<Database>;

export interface SyncFfbbResult {
  syncRunId: string;
  status: "success" | "partial" | "error";
  stats: {
    engagementsUpserted: number;
    competitionsUpserted: number;
    poolsUpserted: number;
    matchesCreated: number;
    matchesUpdated: number;
    matchesUnchanged: number;
    changesDetected: number;
    errors: number;
  };
}

async function upsertCompetitions(supabase: Client, competitions: NormalizedCompetition[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  for (const competition of competitions) {
    const { data, error } = await supabase
      .from("competitions")
      .upsert(
        {
          ffbb_competition_id: competition.ffbbId,
          name: competition.name,
          code: competition.code,
          sexe: competition.sexe,
          type_competition: competition.typeCompetition,
          category_code: competition.categoryCode,
          category_label: competition.categoryLabel,
          phase_code: competition.phaseCode,
          live_stat: competition.liveStat,
          emarque_v2: competition.emarqueV2,
          publication_internet: competition.publicationInternet,
          season: competition.season,
          parent_ffbb_competition_id: competition.parentCompetitionFfbbId,
          raw_ffbb_payload: competition.raw,
          ffbb_last_seen_at: new Date().toISOString(),
        },
        { onConflict: "ffbb_competition_id" },
      )
      .select("id, ffbb_competition_id")
      .single();

    if (error || !data) {
      throw new Error(`Upsert compétition ${competition.ffbbId} échoué : ${error?.message}`);
    }

    map.set(competition.ffbbId, data.id);
  }

  return map;
}

async function upsertPools(supabase: Client, pools: NormalizedPool[], competitionIdByFfbbId: Map<string, string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  for (const pool of pools) {
    const competitionId = competitionIdByFfbbId.get(pool.competitionFfbbId);
    if (!competitionId) continue;

    const { data, error } = await supabase
      .from("pools")
      .upsert(
        {
          ffbb_pool_id: pool.ffbbId,
          competition_id: competitionId,
          name: pool.name,
          raw_ffbb_payload: pool.raw,
          ffbb_last_seen_at: new Date().toISOString(),
        },
        { onConflict: "ffbb_pool_id" },
      )
      .select("id, ffbb_pool_id")
      .single();

    if (error || !data) {
      throw new Error(`Upsert poule ${pool.ffbbId} échoué : ${error?.message}`);
    }

    map.set(pool.ffbbId, data.id);
  }

  return map;
}

/**
 * Résout l'équipe interne correspondant à un engagement FFBB, en créant
 * l'équipe si nécessaire. Heuristique volontairement simple (nom dérivé de
 * la catégorie + numéro d'équipe) : à affiner plus tard depuis une UI
 * d'administration des équipes, pas de sur-ingénierie ici.
 */
async function resolveTeamForEngagement(
  supabase: Client,
  clubId: string,
  engagement: NormalizedTeamEngagement,
  competition: NormalizedCompetition | undefined,
): Promise<string> {
  const label = competition?.categoryLabel ?? competition?.name ?? "Équipe";
  const teamName = engagement.numeroEquipe ? `${label} ${engagement.numeroEquipe}`.trim() : (engagement.name ?? label);

  const { data: existing, error: selectError } = await supabase
    .from("teams")
    .select("id")
    .eq("club_id", clubId)
    .eq("name", teamName)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Recherche équipe "${teamName}" échouée : ${selectError.message}`);
  }

  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabase
    .from("teams")
    .insert({ club_id: clubId, name: teamName, category: competition?.categoryCode ?? null })
    .select("id")
    .single();

  if (insertError || !created) {
    throw new Error(`Création équipe "${teamName}" échouée : ${insertError?.message}`);
  }

  return created.id;
}

async function upsertEngagements(
  supabase: Client,
  clubId: string,
  engagements: NormalizedTeamEngagement[],
  competitionIdByFfbbId: Map<string, string>,
  poolIdByFfbbId: Map<string, string>,
  competitionsByFfbbId: Map<string, NormalizedCompetition>,
): Promise<Map<string, string>> {
  const teamIdByEngagementFfbbId = new Map<string, string>();

  for (const engagement of engagements) {
    const competitionId = competitionIdByFfbbId.get(engagement.competitionFfbbId) ?? null;
    const poolId = engagement.poolFfbbId ? (poolIdByFfbbId.get(engagement.poolFfbbId) ?? null) : null;
    const competition = competitionsByFfbbId.get(engagement.competitionFfbbId);

    const teamId = await resolveTeamForEngagement(supabase, clubId, engagement, competition);

    const { error } = await supabase.from("ffbb_team_engagements").upsert(
      {
        club_id: clubId,
        team_id: teamId,
        ffbb_engagement_id: engagement.ffbbId,
        competition_id: competitionId ?? "",
        pool_id: poolId,
        season: competition?.season ?? null,
        name: engagement.name,
        numero_equipe: engagement.numeroEquipe,
        raw_ffbb_payload: engagement.raw,
        ffbb_last_seen_at: new Date().toISOString(),
      },
      { onConflict: "club_id,ffbb_engagement_id" },
    );

    if (error) {
      throw new Error(`Upsert engagement ${engagement.ffbbId} échoué : ${error.message}`);
    }

    teamIdByEngagementFfbbId.set(engagement.ffbbId, teamId);
  }

  return teamIdByEngagementFfbbId;
}

async function upsertVenue(supabase: Client, ffbbVenueId: string | null, name: string | null, commune: string | null): Promise<string | null> {
  if (!ffbbVenueId) return null;

  const { data, error } = await supabase
    .from("venues")
    .upsert(
      { ffbb_venue_id: ffbbVenueId, name, commune, ffbb_last_seen_at: new Date().toISOString() },
      { onConflict: "ffbb_venue_id" },
    )
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Upsert salle ${ffbbVenueId} échoué : ${error?.message}`);
  }

  return data.id;
}

export interface SyncFfbbClub {
  id: string;
  ffbbClubId: string;
}

/**
 * syncFfbb — service de synchronisation FFBB, désormais explicitement
 * paramétré par club (§18/§37 du brief SaaS) : plus aucun singleton "le
 * club". Idempotent (clé d'upsert = identifiants FFBB, scopée au club pour
 * `matches`/`ffbb_team_engagements`), ne supprime jamais un match, historise
 * chaque changement de champ suivi.
 *
 * Statut : PREPARED — la logique de mapping/diff est testée unitairement
 * (voir mapping.test.ts), mais cette orchestration n'a jamais été exécutée
 * contre un vrai projet Supabase ni la vraie API FFBB depuis cet
 * environnement (voir docs/FFBB_ECOSYSTEM_RESEARCH.md).
 */
export async function syncFfbb(supabase: Client, provider: FfbbPublicProvider, club: SyncFfbbClub): Promise<SyncFfbbResult> {
  const { data: syncRun, error: syncRunError } = await supabase
    .from("sync_runs")
    .insert({ club_id: club.id, provider: "ffbb", status: "running" })
    .select("id")
    .single();

  if (syncRunError || !syncRun) {
    throw new Error(`Impossible de créer le sync_run : ${syncRunError?.message}`);
  }

  const stats: SyncFfbbResult["stats"] = {
    engagementsUpserted: 0,
    competitionsUpserted: 0,
    poolsUpserted: 0,
    matchesCreated: 0,
    matchesUpdated: 0,
    matchesUnchanged: 0,
    changesDetected: 0,
    errors: 0,
  };

  try {
    const snapshot = await provider.fetchClubSnapshot(club.ffbbClubId);

    const competitionIdByFfbbId = await upsertCompetitions(supabase, snapshot.competitions);
    stats.competitionsUpserted = competitionIdByFfbbId.size;

    const poolIdByFfbbId = await upsertPools(supabase, snapshot.pools, competitionIdByFfbbId);
    stats.poolsUpserted = poolIdByFfbbId.size;

    const competitionsByFfbbId = new Map(snapshot.competitions.map((c) => [c.ffbbId, c]));
    const teamIdByEngagementFfbbId = await upsertEngagements(
      supabase,
      club.id,
      snapshot.engagements,
      competitionIdByFfbbId,
      poolIdByFfbbId,
      competitionsByFfbbId,
    );
    stats.engagementsUpserted = teamIdByEngagementFfbbId.size;

    for (const match of snapshot.matches) {
      try {
        const venueId = await upsertVenue(supabase, match.venue?.ffbbId ?? null, match.venue?.name ?? null, match.venue?.commune ?? null);

        const row = mapNormalizedMatchToRow(match, {
          clubId: club.id,
          teamId: teamIdByEngagementFfbbId.get(match.ourEngagementFfbbId) ?? null,
          competitionId: match.competitionFfbbId ? (competitionIdByFfbbId.get(match.competitionFfbbId) ?? null) : null,
          poolId: match.poolFfbbId ? (poolIdByFfbbId.get(match.poolFfbbId) ?? null) : null,
          venueId,
        });

        const { data: existing } = await supabase
          .from("matches")
          .select("*")
          .eq("club_id", club.id)
          .eq("ffbb_match_id", match.ffbbId)
          .maybeSingle();

        const diffs = diffTrackedFields(existing, row);
        const emarqueTransition = shouldRequestEmarque(existing?.status, row.status);

        const { data: upserted, error: upsertError } = await supabase
          .from("matches")
          .upsert(
            { ...row, emarque_status: emarqueTransition ? "pending" : (existing?.emarque_status ?? "not_applicable") },
            { onConflict: "club_id,ffbb_match_id" },
          )
          .select("id")
          .single();

        if (upsertError || !upserted) {
          throw new Error(upsertError?.message ?? "upsert sans erreur mais sans résultat");
        }

        if (!existing) {
          stats.matchesCreated += 1;
        } else if (diffs.length > 0) {
          stats.matchesUpdated += 1;
          stats.changesDetected += diffs.length;

          const { error: historyError } = await supabase.from("match_change_history").insert(
            diffs.map((diff) => ({
              club_id: club.id,
              match_id: upserted.id,
              sync_run_id: syncRun.id,
              field_name: diff.field,
              old_value: diff.oldValue,
              new_value: diff.newValue,
            })),
          );

          if (historyError) {
            logError("Écriture de l'historique de changement échouée", historyError, { clubId: club.id, matchId: upserted.id });
          }
        } else {
          stats.matchesUnchanged += 1;
        }
      } catch (error) {
        stats.errors += 1;
        logError("Synchronisation d'un match échouée", error, { clubId: club.id, ffbbMatchId: match.ffbbId });
      }
    }

    const finalStatus = stats.errors === 0 ? "success" : "partial";

    await supabase
      .from("sync_runs")
      .update({ status: finalStatus, finished_at: new Date().toISOString(), stats })
      .eq("id", syncRun.id);

    logInfo("Synchronisation FFBB terminée", { clubId: club.id, syncRunId: syncRun.id, status: finalStatus, stats });

    return { syncRunId: syncRun.id, status: finalStatus, stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await supabase
      .from("sync_runs")
      .update({ status: "error", finished_at: new Date().toISOString(), stats, error_log: message })
      .eq("id", syncRun.id);

    logError("Synchronisation FFBB en erreur", error, { clubId: club.id });

    return { syncRunId: syncRun.id, status: "error", stats };
  }
}
