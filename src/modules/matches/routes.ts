import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { MatchesQueryDtoSchema, type MatchListItemDto, type MatchDetailsDto } from "../../contracts/matches.js";
import type { DerogationStatusDto } from "../../contracts/derogations.js";
import { computePeriodRange } from "../../util/timezone.js";
import { sanitizeEmarqueError } from "../../integrations/emarque/sanitize-error.js";
import type { QualityWarningDto } from "../../contracts/emarque.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { getFbiCredentials } from "../../integrations/fbi/credentials-store.js";

export const matchesRouter = new Hono<AppEnv>();

matchesRouter.use("*", requireAuth);
matchesRouter.use("*", requireClubMembership);

const EMARQUE_STATUS_LABELS: Record<string, string> = {
  not_applicable: "not_applicable",
  pending: "pending",
  waiting_for_emarque: "waiting_for_emarque",
  discovered: "discovered",
  downloading: "downloading",
  downloaded: "downloaded",
  parsing: "parsing",
  imported: "imported",
  error: "error",
  needs_review: "needs_review",
};

/**
 * GET /v1/clubs/:clubId/matches — filtres et pagination (gap 7 de la
 * demande, voir `contracts/matches.ts#MatchesQueryDtoSchema`).
 *
 * `teamId` tenant-safe par construction (§20 de la demande) : la requête
 * filtre déjà sur `club_id = ce club`, donc un `teamId` d'un AUTRE club ne
 * peut jamais correspondre à une ligne `matches` de celui-ci — la réponse
 * est alors simplement une liste vide, jamais une fuite ni un statut
 * distinctif qui révélerait l'existence de l'équipe ailleurs.
 */
matchesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const query = MatchesQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequest(query.error.issues.map((issue) => issue.message).join(" "));
  }
  const { period, teamId, homeAway, status, limit, offset } = query.data;
  let { from, to } = query.data;

  if (period && (from || to)) {
    throw badRequest("period et from/to sont mutuellement exclusifs.");
  }
  if (period) {
    const range = computePeriodRange(period, club.timezone);
    from = range.from ?? undefined;
    to = range.to ?? undefined;
  }

  let builder = supabase
    .from("matches")
    .select(
      "id, numero, journee, match_datetime, is_home, opponent_name, opponent_logo_url, venue_raw_label, score_home, score_away, status, emarque_status, team_id",
      { count: "exact" },
    )
    .eq("club_id", club.id);

  if (teamId) builder = builder.eq("team_id", teamId);
  if (homeAway) builder = builder.eq("is_home", homeAway === "home");
  if (status) builder = builder.eq("status", status);
  if (from) builder = builder.gte("match_datetime", from);
  if (to) builder = builder.lt("match_datetime", to);

  const { data, error, count } = await builder
    .order("match_datetime", { ascending: period !== "past" })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Lecture des matchs échouée : ${error.message}`);

  const teamIds = [...new Set((data ?? []).map((m) => m.team_id).filter((id): id is string => Boolean(id)))];
  const { data: teams } = teamIds.length
    ? await supabase.from("teams").select("id, name").eq("club_id", club.id).in("id", teamIds)
    : { data: [] };
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, t.name]));

  const matches: MatchListItemDto[] = (data ?? []).map((m) => ({
    id: m.id,
    numero: m.numero,
    journee: m.journee,
    matchDatetime: m.match_datetime,
    isHome: m.is_home,
    teamName: m.team_id ? (teamNameById.get(m.team_id) ?? null) : null,
    opponentName: m.opponent_name,
    opponentLogoUrl: m.opponent_logo_url,
    venueLabel: m.venue_raw_label,
    scoreHome: m.score_home,
    scoreAway: m.score_away,
    status: m.status,
    emarqueStatus: EMARQUE_STATUS_LABELS[m.emarque_status] ?? m.emarque_status,
  }));

  return c.json({ matches, pagination: { limit, offset, total: count ?? matches.length } });
});

/** GET /v1/clubs/:clubId/matches/:matchId */
matchesRouter.get("/:matchId", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const { data: match } = await supabase
    .from("matches")
    .select(
      "id, numero, journee, match_datetime, is_home, opponent_name, opponent_logo_url, venue_raw_label, score_home, score_away, status, emarque_status, team_id",
    )
    .eq("id", matchId)
    .eq("club_id", club.id)
    .maybeSingle();

  if (!match) throw notFound("Match introuvable.");

  const { data: team } = match.team_id
    ? await supabase.from("teams").select("name").eq("id", match.team_id).eq("club_id", club.id).maybeSingle()
    : { data: null };

  const [{ data: participants }, { data: coaches }, { data: officials }, { data: tableOfficials }, { data: stats }, { data: documents }, { data: latestImport }] =
    await Promise.all([
      supabase
        .from("match_participants")
        .select("id, team_side, jersey_number, first_name, last_name, is_captain, is_starter, licencie_id")
        .eq("match_id", matchId)
        .eq("club_id", club.id),
      supabase.from("match_coaches").select("team_side, role, first_name, last_name, licencie_id").eq("match_id", matchId).eq("club_id", club.id),
      supabase.from("match_officials").select("role, first_name, last_name, licencie_id").eq("match_id", matchId).eq("club_id", club.id),
      supabase.from("match_table_officials").select("role, first_name, last_name, licencie_id").eq("match_id", matchId).eq("club_id", club.id),
      supabase
        .from("player_match_stats")
        .select(
          "participant_id, seconds_played, points, three_points_made, two_points_interior_made, two_points_exterior_made, free_throws_made, fouls_committed, match_participants(team_side, jersey_number, first_name, last_name, licencie_id)",
        )
        .eq("match_id", matchId)
        .eq("club_id", club.id),
      supabase.from("match_documents").select("id, source, downloaded_at").eq("match_id", matchId).eq("club_id", club.id).order("downloaded_at", { ascending: false }),
      supabase
        .from("emarque_imports")
        .select("quality_warnings, parser_version, discovered_at, imported_at, last_error")
        .eq("match_id", matchId)
        .eq("club_id", club.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const dto: MatchDetailsDto = {
    id: match.id,
    numero: match.numero,
    journee: match.journee,
    matchDatetime: match.match_datetime,
    isHome: match.is_home,
    teamName: team?.name ?? null,
    opponentName: match.opponent_name,
    opponentLogoUrl: match.opponent_logo_url,
    venueLabel: match.venue_raw_label,
    scoreHome: match.score_home,
    scoreAway: match.score_away,
    status: match.status,
    emarque: {
      status: EMARQUE_STATUS_LABELS[match.emarque_status] ?? match.emarque_status,
      source: documents && documents.length > 0 ? documents[0]!.source.toUpperCase() : null,
      lastRetrievedAt: documents?.[0]?.downloaded_at ?? null,
      qualityWarningCount: Array.isArray(latestImport?.quality_warnings) ? latestImport.quality_warnings.length : null,
      parserVersion: latestImport?.parser_version ?? null,
      discoveredAt: latestImport?.discovered_at ?? null,
      importedAt: latestImport?.imported_at ?? null,
      qualityWarnings: Array.isArray(latestImport?.quality_warnings) ? (latestImport.quality_warnings as QualityWarningDto[]) : [],
      lastError: sanitizeEmarqueError(latestImport?.last_error ?? null),
    },
    participants: (participants ?? []).map((p) => ({
      id: p.id,
      teamSide: p.team_side,
      jerseyNumber: p.jersey_number,
      firstName: p.first_name,
      lastName: p.last_name,
      isCaptain: p.is_captain,
      isStarter: p.is_starter,
      licencieId: p.licencie_id,
    })),
    coaches: (coaches ?? []).map((coach) => ({
      teamSide: coach.team_side,
      role: coach.role,
      firstName: coach.first_name,
      lastName: coach.last_name,
      licencieId: coach.licencie_id,
    })),
    officials: (officials ?? []).map((o) => ({ role: o.role, firstName: o.first_name, lastName: o.last_name, licencieId: o.licencie_id })),
    tableOfficials: (tableOfficials ?? []).map((o) => ({ role: o.role, firstName: o.first_name, lastName: o.last_name, licencieId: o.licencie_id })),
    stats: (stats ?? []).map((row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const participant = (row as any).match_participants;
      return {
        participantId: row.participant_id,
        teamSide: participant?.team_side ?? "home",
        jerseyNumber: participant?.jersey_number ?? null,
        firstName: participant?.first_name ?? null,
        lastName: participant?.last_name ?? null,
        licencieId: participant?.licencie_id ?? null,
        secondsPlayed: row.seconds_played,
        points: row.points,
        threePointsMade: row.three_points_made,
        twoPointsInteriorMade: row.two_points_interior_made,
        twoPointsExteriorMade: row.two_points_exterior_made,
        freeThrowsMade: row.free_throws_made,
        foulsCommitted: row.fouls_committed,
      };
    }),
  };

  return c.json(dto);
});

/**
 * GET /v1/clubs/:clubId/matches/:matchId/derogation — dernier état CONNU
 * de la dérogation de ce match (voir docs/FBI.md, demande du club : "faut
 * qu'on gere les derog depuis l'outil"). `derogation: null` quand aucune
 * vérification n'a encore été lancée, OU que la dernière vérification n'a
 * trouvé aucune dérogation pour ce match — les deux cas sont normaux,
 * jamais une erreur (la grande majorité des matchs n'ont aucune dérogation).
 */
matchesRouter.get("/:matchId/derogation", async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const { data } = await c
    .get("supabase")
    .from("fbi_derogation_checks")
    .select(
      "numero, etat, date_depot, date_derogation, date_rencontre, heure, domicile, visiteur, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, checked_at",
    )
    .eq("club_id", club.id)
    .eq("match_id", matchId)
    .maybeSingle();

  const derogation: DerogationStatusDto | null = data
    ? {
        numero: data.numero,
        etat: data.etat,
        dateDepot: data.date_depot,
        dateDerogation: data.date_derogation,
        dateRencontre: data.date_rencontre,
        heure: data.heure,
        domicile: data.domicile,
        visiteur: data.visiteur,
        demandeur: data.demandeur,
        motif: data.motif,
        dateRencontreDemandee: data.date_rencontre_demandee,
        heureDemandee: data.heure_demandee,
        adversaire: data.adversaire,
        dateReponse: data.date_reponse,
        acceptation: data.acceptation,
        motifRefus: data.motif_refus,
        checkedAt: data.checked_at,
      }
    : null;

  return c.json({ derogation });
});

/**
 * POST /v1/clubs/:clubId/matches/:matchId/derogation/check — empile un job
 * `check_derogation` (club_admin) pour ce match précis, consommé ensuite
 * par POST .../fbi/process-jobs (ou le cron) — même modèle que
 * `reconcile_schedule`, jamais synchrone ici (Playwright). LECTURE SEULE :
 * consulte l'état FBI de la dérogation, n'en soumet/modifie jamais une
 * (voir docs/FBI.md).
 */
matchesRouter.post("/:matchId/derogation/check", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const serviceSupabase = createServiceSupabaseClient();

  const { data: match } = await serviceSupabase.from("matches").select("id, numero").eq("id", matchId).eq("club_id", club.id).maybeSingle();
  if (!match) throw notFound("Match introuvable.");
  if (!match.numero) throw badRequest("Ce match n'a pas de numéro de rencontre connu, impossible de rechercher sa dérogation sur FBI.");

  const credentials = await getFbiCredentials(serviceSupabase, club.id);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant de vérifier une dérogation.", "FBI_NOT_CONFIGURED");

  const { error } = await serviceSupabase.from("fbi_jobs").insert({ club_id: club.id, match_id: matchId, type: "check_derogation" });

  if (error) {
    if (error.code === "23505") {
      throw conflict("Une vérification de dérogation est déjà en attente ou en cours pour ce match.", "DEROGATION_CHECK_ALREADY_QUEUED");
    }
    throw new Error(`Création du job de vérification de dérogation échouée : ${error.message}`);
  }

  return c.json({ queued: true as const });
});
