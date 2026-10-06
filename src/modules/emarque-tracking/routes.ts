import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, notFound } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { currentSeasonStart } from "../../season.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import type { EmarqueTrackingDto, EmarqueTrackingMatchDto, EmarqueTrackingRelaunchDto, EmarqueTrackingState } from "../../contracts/emarque-tracking.js";

export const emarqueTrackingRouter = new Hono<AppEnv>();

emarqueTrackingRouter.use("*", requireAuth);
emarqueTrackingRouter.use("*", requireClubMembership);
emarqueTrackingRouter.use("*", requireClubRole("club_admin"));

const STATE_BY_EMARQUE_STATUS: Record<string, EmarqueTrackingState> = {
  imported: "published",
  needs_review: "needs_review",
  error: "error",
  not_available: "not_available",
  discovered: "processing",
  downloading: "processing",
  downloaded: "processing",
  parsing: "processing",
  pending: "waiting",
  waiting_for_emarque: "waiting",
  not_applicable: "waiting",
};

/**
 * Résultat du dernier essai, en clair — classification du message stocké
 * en base, jamais le message lui-même (peut contenir des détails internes,
 * voir `sanitizeEmarqueError`).
 */
export function describeLastCheck(lastError: string | null, jobStatus: string | null): string | null {
  if (jobStatus === "succeeded") return "Feuille récupérée sur FBI";
  if (!lastError) return null;
  if (/7 jours après le match/.test(lastError)) return "Aucune feuille sur FBI 7 jours après le match";
  if (/identifiant|LOGIN_FAILED|refusé/i.test(lastError)) return "Identifiants FBI refusés — à corriger dans Intégrations";
  if (/injoignable|ETIMEDOUT|échec réseau|Failed to fetch|délai d'exécution|Page de résultat introuvable/i.test(lastError)) return "FBI injoignable au dernier essai — nouvel essai au prochain créneau";
  if (/\[info, pas une erreur\]/.test(lastError)) return "Feuille pas encore publiée sur FBI";
  return "Erreur technique au dernier essai — nouvel essai au prochain créneau";
}

/** GET /v1/clubs/:clubId/emarque-tracking — un état clair par match joué de la saison (admin du club). */
emarqueTrackingRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");
  const service = createServiceSupabaseClient();

  const { data: matches, error: matchesError } = await supabase
    .from("matches")
    .select("id, numero, match_datetime, is_home, opponent_name, score_home, score_away, emarque_status, team_id")
    .eq("club_id", club.id)
    .eq("status", "played")
    .gte("match_datetime", currentSeasonStart().toISOString())
    .order("match_datetime", { ascending: false });
  if (matchesError) throw new Error(`Lecture des matchs échouée : ${matchesError.message}`);

  const matchIds = (matches ?? []).map((m) => m.id);
  if (matchIds.length === 0) return c.json({ matches: [] } satisfies EmarqueTrackingDto);

  const [{ data: teams }, { data: imports }, { data: jobs }, { data: participants }] = await Promise.all([
    supabase.from("teams").select("id, name, sexe").eq("club_id", club.id),
    supabase.from("emarque_imports").select("match_id, quality_warnings, imported_at, created_at").eq("club_id", club.id).in("match_id", matchIds),
    service.from("fbi_jobs").select("match_id, status, scheduled_at, claimed_at, finished_at, last_error, created_at").eq("club_id", club.id).eq("type", "discover_emarque").in("match_id", matchIds),
    supabase.from("match_participants").select("match_id, team_side, licencie_id").eq("club_id", club.id).in("match_id", matchIds),
  ]);

  const teamNameById = new Map((teams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));
  const latestBy = <T extends { match_id: string | null; created_at: string }>(rows: T[] | null) => {
    const byMatch = new Map<string, T>();
    for (const row of rows ?? []) {
      if (!row.match_id) continue;
      const current = byMatch.get(row.match_id);
      if (!current || current.created_at < row.created_at) byMatch.set(row.match_id, row);
    }
    return byMatch;
  };
  const importByMatch = latestBy(imports);
  const jobByMatch = latestBy(jobs);

  const dto: EmarqueTrackingMatchDto[] = (matches ?? []).map((match) => {
    const state = STATE_BY_EMARQUE_STATUS[match.emarque_status] ?? "waiting";
    const job = jobByMatch.get(match.id) ?? null;
    const latestImport = importByMatch.get(match.id) ?? null;
    const clubSide = match.is_home === true ? "home" : match.is_home === false ? "away" : null;
    const clubPlayers = (participants ?? []).filter((p) => p.match_id === match.id && p.team_side === clubSide);
    const warnings = Array.isArray(latestImport?.quality_warnings) ? (latestImport.quality_warnings as Array<{ severity?: string; message?: string }>) : [];

    return {
      matchId: match.id,
      numero: match.numero,
      matchDatetime: match.match_datetime,
      teamName: match.team_id ? (teamNameById.get(match.team_id) ?? null) : null,
      opponentName: match.opponent_name,
      isHome: match.is_home,
      scoreHome: match.score_home,
      scoreAway: match.score_away,
      state,
      nextCheckAt: job && job.status === "pending" ? job.scheduled_at : null,
      lastCheckAt: job?.claimed_at ?? null,
      lastCheckResult: job?.claimed_at ? describeLastCheck(job.last_error, job.status) : null,
      importedAt: latestImport?.imported_at ?? null,
      problems: state === "needs_review" ? warnings.filter((w) => w.severity === "error" && w.message).map((w) => w.message!) : [],
      clubPlayersLinked: clubPlayers.filter((p) => p.licencie_id).length,
      clubPlayersTotal: clubPlayers.length,
    };
  });

  return c.json({ matches: dto } satisfies EmarqueTrackingDto);
});

/**
 * POST /v1/clubs/:clubId/emarque-tracking/:matchId/relaunch — relance
 * manuelle : relecture de la feuille conservée si elle existe encore (30
 * jours), sinon essai FBI au prochain passage du planificateur puis
 * nouvelle fenêtre de 7 jours au calendrier fixe (`fbi_jobs.window_start`).
 */
emarqueTrackingRouter.post("/:matchId/relaunch", async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");
  const service = createServiceSupabaseClient();

  const { data: match } = await c.get("supabase").from("matches").select("id, status").eq("club_id", club.id).eq("id", matchId).maybeSingle();
  if (!match) throw notFound("Match introuvable pour ce club.");
  if (match.status !== "played") throw badRequest("Seul un match joué a une feuille e-Marque à récupérer.");

  const now = new Date().toISOString();

  // Feuille encore conservée (30 jours) : relecture directe, sans FBI.
  const { data: storedDoc } = await service
    .from("match_documents")
    .select("id")
    .eq("club_id", club.id)
    .eq("match_id", matchId)
    .eq("type", "emarque_zip")
    .is("purged_at", null)
    .order("downloaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (storedDoc) {
    await service.from("match_documents").update({ status: "downloaded", updated_at: now }).eq("id", storedDoc.id);
    await service.from("matches").update({ emarque_status: "downloaded" }).eq("id", matchId);
    return c.json({ matchId, nextCheckAt: now } satisfies EmarqueTrackingRelaunchDto, 202);
  }

  const { data: pending } = await service
    .from("fbi_jobs")
    .select("id")
    .eq("club_id", club.id)
    .eq("match_id", matchId)
    .eq("type", "discover_emarque")
    .eq("status", "pending")
    .maybeSingle();

  if (pending) {
    const { error } = await service.from("fbi_jobs").update({ scheduled_at: now, window_start: now }).eq("id", pending.id);
    if (error) throw new Error(`Relance du job e-Marque échouée : ${error.message}`);
  } else {
    const { error } = await service.from("fbi_jobs").insert({ club_id: club.id, match_id: matchId, type: "discover_emarque", scheduled_at: now, window_start: now });
    // Un essai déjà en cours (claimed/running) : rien à faire, il aboutira de lui-même.
    if (error && error.code !== "23505") throw new Error(`Relance du job e-Marque échouée : ${error.message}`);
  }

  await service.from("matches").update({ emarque_status: "waiting_for_emarque" }).eq("id", matchId);

  return c.json({ matchId, nextCheckAt: now } satisfies EmarqueTrackingRelaunchDto, 202);
});
