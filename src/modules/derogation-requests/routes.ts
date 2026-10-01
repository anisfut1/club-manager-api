import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../api-error.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import {
  CreateDerogationRequestDtoSchema,
  DerogationActionDtoSchema,
  DerogationAvailabilityQueryDtoSchema,
  DerogationRequestListQueryDtoSchema,
  DerogationSlotCheckQueryDtoSchema,
  PostDerogationMessageDtoSchema,
  ProposeDerogationSlotDtoSchema,
} from "../../contracts/derogation-requests.js";
import { DEFAULT_MATCH_DURATION_MINUTES, DEFAULT_SLOT_STEP_MINUTES } from "../../scheduling/match-slot.js";
import { localTimeKey, parseLocalDate, zonedWallTimeToUtc } from "../../util/timezone.js";
import { computeAvailability, validateRequestedSlot, type CandidateSlot, type SlotConflict, type SlotWarning } from "./availability.js";
import { canCreateForTeam, canManageRequests, canPerformAction, canPropose, canReadRequest, coachedTeams, nextStatus, roleLabelFor, type Actor } from "./policy.js";
import {
  REQUEST_COLUMNS,
  buildDetail,
  buildSummaries,
  coordinatorsConfigured,
  loadActor,
  loadClubVenues,
  loadMatch,
  loadMatchLabels,
  loadPendingProposals,
  loadPlanningRules,
  loadRequest,
  loadScheduledMatches,
  matchRef,
  requestRef,
  resolveRequesterName,
  venueRefs,
  type ClubVenueRow,
  type MatchRow,
  type RequestRow,
} from "./service.js";

/**
 * DEMANDES DE DÉROGATION INTERNES (coach → coordinateur), retour du club
 * 2026-10-01. Le logiciel ORGANISE, VÉRIFIE et FACILITE LA COMMUNICATION ;
 * le coordinateur DÉCIDE et effectue la dérogation officielle. Aucune route
 * de ce module n'écrit sur FFBB/FBI ni ne modifie `matches` (voir les tests
 * "aucune écriture externe").
 */

const NO_COORDINATOR_MESSAGE = "Aucun coordinateur n'est actuellement configuré pour recevoir les demandes de dérogation.";

const service = (): DbClient => createServiceSupabaseClient();

function formatSlot(startAt: Date, timezone: string, venueName: string | null): string {
  const day = startAt.toLocaleDateString("fr-FR", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" });
  return `${day} à ${localTimeKey(startAt, timezone)}${venueName ? ` — ${venueName}` : ""}`;
}

function conflictDto(conflict: SlotConflict, venues: readonly ClubVenueRow[]) {
  return {
    type: conflict.type,
    matchId: conflict.match.id,
    teamName: conflict.match.teamName,
    opponentName: conflict.match.opponentName,
    startAt: conflict.window.start.toISOString(),
    endAt: conflict.window.end.toISOString(),
    venueName: conflict.match.clubVenueId ? (venues.find((v) => v.id === conflict.match.clubVenueId)?.name ?? null) : null,
  };
}

function warningDto(warning: SlotWarning) {
  const start = warning.proposal.startAt;
  return {
    type: warning.type,
    requestId: warning.proposal.requestId,
    teamName: warning.proposal.teamName,
    opponentName: warning.proposal.opponentName,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + DEFAULT_MATCH_DURATION_MINUTES * 60_000).toISOString(),
  };
}

function candidateDto(slot: CandidateSlot, venues: readonly ClubVenueRow[]) {
  return {
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    localStart: slot.localStart,
    localEnd: slot.localEnd,
    available: slot.available,
    conflicts: slot.conflicts.map((c) => conflictDto(c, venues)),
    warnings: slot.warnings.map(warningDto),
  };
}

function isUpcoming(match: MatchRow, now: Date): boolean {
  if (!match.match_datetime || ["cancelled", "played", "forfeit"].includes(match.status)) return false;
  return new Date(match.match_datetime) > now;
}

interface SlotCheckParams {
  db: DbClient;
  clubId: string;
  timezone: string;
  match: MatchRow;
  startAt: Date;
  venueId: string | null;
  venues: readonly ClubVenueRow[];
  now: Date;
}

/** Validation AUTORITAIRE (création, nouvelle proposition, vérification d'heure personnalisée) — toujours recalculée ici. */
async function checkSlot(params: SlotCheckParams) {
  const isHome = params.match.is_home === true;
  if (params.venueId && !params.venues.some((v) => v.id === params.venueId)) throw badRequest("Gymnase inconnu pour ce club.", "UNKNOWN_VENUE");
  if (!isHome && params.venueId) throw badRequest("Match à l'extérieur : aucun gymnase du club à choisir.", "AWAY_MATCH_NO_VENUE");

  const dayStart = new Date(params.startAt.getTime() - 24 * 3_600_000);
  const dayEnd = new Date(params.startAt.getTime() + 24 * 3_600_000);
  const [rules, matches, pending] = await Promise.all([
    loadPlanningRules(params.db, params.clubId),
    loadScheduledMatches(params.db, params.clubId, dayStart, dayEnd, params.venues),
    loadPendingProposals(params.db, params.clubId, dayStart, dayEnd),
  ]);

  return validateRequestedSlot({
    startAt: params.startAt,
    clubVenueId: isHome ? params.venueId : null,
    isHome,
    targetMatchId: params.match.id,
    targetTeamId: params.match.team_id,
    matches,
    pending,
    timezone: params.timezone,
    rules,
    now: params.now,
    venueNames: new Map(params.venues.map((v) => [v.id, v.name])),
  });
}

function throwIfInvalid(result: Awaited<ReturnType<typeof checkSlot>>, venues: readonly ClubVenueRow[]): asserts result is Extract<Awaited<ReturnType<typeof checkSlot>>, { ok: true }> {
  if (result.ok) return;
  if (result.code === "DEROGATION_SLOT_CONFLICT") throw conflict(result.message, result.code, { conflicts: result.conflicts.map((c) => conflictDto(c, venues)) });
  throw badRequest(result.message, result.code);
}

async function insertMessage(db: DbClient, row: { club_id: string; request_id: string; author_user_id: string | null; author_membership_id: string | null; author_display_name: string; author_role_label: string | null; body: string; message_type: "USER" | "SYSTEM"; event?: string | null }) {
  const { error } = await db.from("derogation_messages").insert({ ...row, event: row.event ?? null });
  if (error) throw new Error(`Écriture du message échouée : ${error.message}`);
}

async function touch(db: DbClient, requestId: string, patch: Partial<Pick<RequestRow, "status" | "requested_start_at" | "requested_club_venue_id" | "is_custom_weekday">> = {}) {
  const now = new Date().toISOString();
  const { error } = await db.from("derogation_requests").update({ ...patch, updated_at: now, last_message_at: now }).eq("id", requestId);
  if (error) throw new Error(`Mise à jour de la demande échouée : ${error.message}`);
}

interface Ctx {
  db: DbClient;
  actor: Actor;
  clubId: string;
  timezone: string;
  membershipId: string;
}

async function context(c: { get: (k: "club" | "user") => unknown }): Promise<Ctx> {
  const club = c.get("club") as { club: { id: string; timezone: string }; membershipId: string };
  const user = c.get("user") as { id: string };
  const db = service();
  const actor = await loadActor(db, club.membershipId, user.id);
  return { db, actor, clubId: club.club.id, timezone: club.club.timezone, membershipId: club.membershipId };
}

async function readableRequestOrThrow(ctx: Ctx, requestId: string): Promise<RequestRow> {
  const row = await loadRequest(ctx.db, ctx.clubId, requestId);
  // 404 (jamais 403) : ne révèle pas l'existence d'une demande hors de ses permissions.
  if (!row || !canReadRequest(ctx.actor, requestRef(row))) throw notFound("Demande de dérogation introuvable.");
  return row;
}

// ---------------------------------------------------------------------------
// /v1/clubs/:clubId/derogation-requests
// ---------------------------------------------------------------------------
export const derogationRequestsRouter = new Hono<AppEnv>();
derogationRequestsRouter.use("*", requireAuth);
derogationRequestsRouter.use("*", requireClubMembership);

/** GET .../context — identité du demandeur, coordinateur configuré, gymnases, matchs éligibles. */
derogationRequestsRouter.get("/context", async (c) => {
  const ctx = await context(c);
  const now = new Date();
  const [requester, hasCoordinator, venues] = await Promise.all([
    resolveRequesterName(ctx.db, ctx.membershipId, ctx.actor.userId, c.get("user").email ?? null),
    coordinatorsConfigured(ctx.db, ctx.clubId),
    loadClubVenues(ctx.db, ctx.clubId),
  ]);

  const teams = coachedTeams(ctx.actor);
  const canCreateAny = canManageRequests(ctx.actor) ? true : teams === "ALL" || teams.size > 0;
  let eligible: (ReturnType<typeof matchRef> & { activeRequestId: string | null })[] = [];
  if (canCreateAny) {
    const { data } = await ctx.db
      .from("matches")
      .select("id, club_id, numero, team_id, is_home, match_datetime, opponent_name, venue_id, venue_raw_label, status, competition_id")
      .eq("club_id", ctx.clubId)
      .gte("match_datetime", now.toISOString())
      .order("match_datetime")
      .limit(300);
    const rows = ((data ?? []) as MatchRow[]).filter((m) => isUpcoming(m, now) && canCreateForTeam(ctx.actor, m.team_id));
    const labels = await loadMatchLabels(ctx.db, rows);
    const { data: active } = rows.length
      ? await ctx.db.from("derogation_requests").select("id, match_id, status").eq("club_id", ctx.clubId).in("match_id", rows.map((m) => m.id)).in("status", ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"])
      : { data: [] };
    const activeByMatch = new Map((active ?? []).map((r) => [r.match_id, r.id]));
    eligible = rows.map((m) => ({ ...matchRef(m, labels), activeRequestId: activeByMatch.get(m.id) ?? null }));
  }

  return c.json({
    requesterDisplayName: requester.name,
    requesterNameSource: requester.source,
    coordinatorsConfigured: hasCoordinator,
    canCreate: eligible.length > 0 || canCreateAny,
    canManage: canManageRequests(ctx.actor),
    timezone: ctx.timezone,
    venues: venueRefs(venues),
    eligibleMatches: eligible,
  });
});

/** GET ... — inbox coordinateur (toutes) / demandes du coach (ses équipes + les siennes). */
derogationRequestsRouter.get("/", async (c) => {
  const query = DerogationRequestListQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));
  const ctx = await context(c);

  let builder = ctx.db.from("derogation_requests").select(REQUEST_COLUMNS).eq("club_id", ctx.clubId);
  if (query.data.status) builder = builder.eq("status", query.data.status);
  if (query.data.teamId) builder = builder.eq("team_id", query.data.teamId);
  if (query.data.matchId) builder = builder.eq("match_id", query.data.matchId);
  if (query.data.createdByMe === "true") builder = builder.eq("created_by_user_id", ctx.actor.userId);
  const { data, error } = await builder.order("last_message_at", { ascending: false });
  if (error) throw new Error(`Lecture des demandes échouée : ${error.message}`);

  const manager = canManageRequests(ctx.actor);
  const visible = ((data ?? []) as RequestRow[])
    .filter((row) => canReadRequest(ctx.actor, requestRef(row)))
    // Inbox coordinateur : d'abord ce qui attend son attention, puis la dernière activité.
    .sort((a, b) => (manager ? Number(b.status === "REQUESTED") - Number(a.status === "REQUESTED") : 0) || b.last_message_at.localeCompare(a.last_message_at));

  const limit = query.data.limit ?? 50;
  const offset = query.data.offset ?? 0;
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const requests = await buildSummaries(ctx.db, visible.slice(offset, offset + limit), ctx.actor, venues);
  return c.json({ requests, pagination: { limit, offset, total: visible.length } });
});

/** GET .../:requestId — demande + match + propositions + conversation + permissions. */
derogationRequestsRouter.get("/:requestId", async (c) => {
  const ctx = await context(c);
  const row = await readableRequestOrThrow(ctx, c.req.param("requestId"));
  return c.json(await buildDetail(ctx.db, row, ctx.actor, await loadClubVenues(ctx.db, ctx.clubId)));
});

/** POST ... — création. Demandeur, nom affiché et club déduits de l'authentification, jamais du corps. */
derogationRequestsRouter.post("/", async (c) => {
  const body = CreateDerogationRequestDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const ctx = await context(c);
  const now = new Date();

  const match = await loadMatch(ctx.db, ctx.clubId, body.data.matchId);
  if (!match) throw notFound("Match introuvable.");
  if (!canCreateForTeam(ctx.actor, match.team_id)) throw forbidden("Tu ne peux demander une dérogation que pour les matchs des équipes que tu encadres.", "DEROGATION_FORBIDDEN");
  if (!isUpcoming(match, now)) throw conflict("Une demande de dérogation ne concerne qu'un match à venir.", "MATCH_NOT_UPCOMING");
  if (!(await coordinatorsConfigured(ctx.db, ctx.clubId))) throw conflict(NO_COORDINATOR_MESSAGE, "NO_COORDINATOR");

  const { data: existing } = await ctx.db.from("derogation_requests").select("id").eq("match_id", match.id).in("status", ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"]).maybeSingle();
  if (existing) throw conflict("Une demande de dérogation est déjà en cours pour ce match.", "DEROGATION_REQUEST_ALREADY_ACTIVE", { requestId: existing.id });

  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const startAt = new Date(body.data.requestedStartAt);
  const venueId = body.data.requestedVenueId ?? null;
  const validation = await checkSlot({ db: ctx.db, clubId: ctx.clubId, timezone: ctx.timezone, match, startAt, venueId, venues, now });
  throwIfInvalid(validation, venues);

  const requester = await resolveRequesterName(ctx.db, ctx.membershipId, ctx.actor.userId, c.get("user").email ?? null);
  // Nom saisi accepté seulement quand aucun nom exploitable n'est connu (jamais pour usurper un prénom connu).
  const displayName = requester.source === "EMAIL" && body.data.requesterDisplayName ? body.data.requesterDisplayName : requester.name;

  const { data: created, error } = await ctx.db
    .from("derogation_requests")
    .insert({
      club_id: ctx.clubId,
      match_id: match.id,
      team_id: match.team_id,
      created_by_user_id: ctx.actor.userId,
      requester_membership_id: ctx.membershipId,
      requester_display_name: displayName,
      original_scheduled_at: match.match_datetime,
      original_venue_id: match.venue_id,
      requested_start_at: startAt.toISOString(),
      requested_club_venue_id: venueId,
      is_custom_weekday: validation.isCustomWeekday,
      status: "REQUESTED",
    })
    .select(REQUEST_COLUMNS)
    .single();
  if (error || !created) {
    // Double clic / course entre deux coachs : l'index unique partiel garantit une seule demande active.
    if (error?.code === "23505") throw conflict("Une demande de dérogation est déjà en cours pour ce match.", "DEROGATION_REQUEST_ALREADY_ACTIVE");
    throw new Error(`Création de la demande échouée : ${error?.message}`);
  }
  const row = created as RequestRow;

  const venueName = venueId ? (venues.find((v) => v.id === venueId)?.name ?? null) : null;
  await ctx.db.from("derogation_proposals").insert({ club_id: ctx.clubId, request_id: row.id, proposed_by_user_id: ctx.actor.userId, proposed_by_display_name: displayName, requested_start_at: row.requested_start_at, requested_club_venue_id: venueId, is_custom_weekday: validation.isCustomWeekday });
  const roleLabel = roleLabelFor(ctx.actor, requestRef(row));
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, author_user_id: ctx.actor.userId, author_membership_id: ctx.membershipId, author_display_name: displayName, author_role_label: roleLabel, body: `${displayName} a envoyé la demande : ${formatSlot(startAt, ctx.timezone, venueName)}.`, message_type: "SYSTEM", event: "REQUEST_CREATED" });
  if (body.data.comment) {
    await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, author_user_id: ctx.actor.userId, author_membership_id: ctx.membershipId, author_display_name: displayName, author_role_label: roleLabel, body: body.data.comment, message_type: "USER" });
  }

  return c.json(await buildDetail(ctx.db, row, ctx.actor, venues), 201);
});

/** POST .../:requestId/messages — réponse dans la conversation. */
derogationRequestsRouter.post("/:requestId/messages", async (c) => {
  const body = PostDerogationMessageDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const ctx = await context(c);
  const row = await readableRequestOrThrow(ctx, c.req.param("requestId"));
  if (row.status === "CANCELLED") throw conflict("Cette demande a été annulée.", "DEROGATION_REQUEST_CANCELLED");

  const author = await resolveRequesterName(ctx.db, ctx.membershipId, ctx.actor.userId, c.get("user").email ?? null);
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, author_user_id: ctx.actor.userId, author_membership_id: ctx.membershipId, author_display_name: author.name, author_role_label: roleLabelFor(ctx.actor, requestRef(row)), body: body.data.message, message_type: "USER" });
  await touch(ctx.db, row.id);

  const fresh = (await loadRequest(ctx.db, ctx.clubId, row.id)) as RequestRow;
  return c.json(await buildDetail(ctx.db, fresh, ctx.actor, await loadClubVenues(ctx.db, ctx.clubId)));
});

const ACTION_EVENTS: Record<string, { event: string; text: (name: string) => string }> = {
  TAKE_IN_CHARGE: { event: "TAKEN_IN_CHARGE", text: (name) => `${name} a pris en charge la demande.` },
  REQUEST_CHANGE: { event: "CHANGE_REQUESTED", text: (name) => `${name} indique que cette demande n'est pas possible — un autre créneau est demandé.` },
  COMPLETE: { event: "COMPLETED", text: (name) => `${name} a marqué la dérogation comme traitée (traitement indiqué comme terminé par le coordinateur).` },
  CANCEL: { event: "CANCELLED", text: (name) => `${name} a annulé la demande.` },
};

/** POST .../:requestId/actions — machine d'état (Je m'en occupe / Pas possible / Traitée / Annuler). */
derogationRequestsRouter.post("/:requestId/actions", async (c) => {
  const body = DerogationActionDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const ctx = await context(c);
  const row = await readableRequestOrThrow(ctx, c.req.param("requestId"));
  const { action } = body.data;

  if (!canPerformAction(ctx.actor, requestRef(row), action)) throw forbidden("Cette action est réservée au coordinateur.", "DEROGATION_FORBIDDEN");
  const to = nextStatus(action, row.status);
  if (!to) throw conflict(`Action impossible depuis le statut actuel (${row.status}).`, "INVALID_TRANSITION");
  if (action === "REQUEST_CHANGE" && !body.data.message) throw unprocessable("Explique pourquoi ce n'est pas possible : le coach verra immédiatement la raison.", "MESSAGE_REQUIRED");

  // Garde optimiste : la transition ne s'applique que si le statut n'a pas changé entre-temps.
  const now = new Date().toISOString();
  const { data: updated, error } = await ctx.db.from("derogation_requests").update({ status: to, updated_at: now, last_message_at: now }).eq("id", row.id).eq("status", row.status).select("id").maybeSingle();
  if (error) throw new Error(`Changement de statut échoué : ${error.message}`);
  if (!updated) throw conflict("La demande a été modifiée entre-temps, recharge la page.", "INVALID_TRANSITION");

  const author = await resolveRequesterName(ctx.db, ctx.membershipId, ctx.actor.userId, c.get("user").email ?? null);
  const roleLabel = roleLabelFor(ctx.actor, requestRef(row));
  const meta = ACTION_EVENTS[action]!;
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, author_user_id: ctx.actor.userId, author_membership_id: ctx.membershipId, author_display_name: author.name, author_role_label: roleLabel, body: meta.text(author.name), message_type: "SYSTEM", event: meta.event });
  if (body.data.message) {
    await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, author_user_id: ctx.actor.userId, author_membership_id: ctx.membershipId, author_display_name: author.name, author_role_label: roleLabel, body: body.data.message, message_type: "USER" });
  }

  const fresh = (await loadRequest(ctx.db, ctx.clubId, row.id)) as RequestRow;
  return c.json(await buildDetail(ctx.db, fresh, ctx.actor, await loadClubVenues(ctx.db, ctx.clubId)));
});

/** POST .../:requestId/proposals — reproposer un créneau (historique conservé, retour en « Demande envoyée »). */
derogationRequestsRouter.post("/:requestId/proposals", async (c) => {
  const body = ProposeDerogationSlotDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const ctx = await context(c);
  const row = await readableRequestOrThrow(ctx, c.req.param("requestId"));
  if (!canPropose(ctx.actor, requestRef(row))) throw conflict("Un nouveau créneau ne peut être proposé que tant que la demande n'est pas prise en charge.", "INVALID_TRANSITION");

  const now = new Date();
  const match = await loadMatch(ctx.db, ctx.clubId, row.match_id);
  if (!match || !isUpcoming(match, now)) throw conflict("Le match n'est plus à venir.", "MATCH_NOT_UPCOMING");
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const startAt = new Date(body.data.requestedStartAt);
  const venueId = body.data.requestedVenueId ?? null;
  const validation = await checkSlot({ db: ctx.db, clubId: ctx.clubId, timezone: ctx.timezone, match, startAt, venueId, venues, now });
  throwIfInvalid(validation, venues);

  const author = await resolveRequesterName(ctx.db, ctx.membershipId, ctx.actor.userId, c.get("user").email ?? null);
  await ctx.db.from("derogation_proposals").insert({ club_id: ctx.clubId, request_id: row.id, proposed_by_user_id: ctx.actor.userId, proposed_by_display_name: author.name, requested_start_at: startAt.toISOString(), requested_club_venue_id: venueId, is_custom_weekday: validation.isCustomWeekday });
  await touch(ctx.db, row.id, { status: "REQUESTED", requested_start_at: startAt.toISOString(), requested_club_venue_id: venueId, is_custom_weekday: validation.isCustomWeekday });

  const roleLabel = roleLabelFor(ctx.actor, requestRef(row));
  const venueName = venueId ? (venues.find((v) => v.id === venueId)?.name ?? null) : null;
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, author_user_id: ctx.actor.userId, author_membership_id: ctx.membershipId, author_display_name: author.name, author_role_label: roleLabel, body: `${author.name} a proposé un nouveau créneau : ${formatSlot(startAt, ctx.timezone, venueName)}.`, message_type: "SYSTEM", event: "SLOT_PROPOSED" });
  if (body.data.message) {
    await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, author_user_id: ctx.actor.userId, author_membership_id: ctx.membershipId, author_display_name: author.name, author_role_label: roleLabel, body: body.data.message, message_type: "USER" });
  }

  const fresh = (await loadRequest(ctx.db, ctx.clubId, row.id)) as RequestRow;
  return c.json(await buildDetail(ctx.db, fresh, ctx.actor, venues));
});

// ---------------------------------------------------------------------------
// /v1/clubs/:clubId/matches/:matchId/derogation-availability (+ slot-check)
// ---------------------------------------------------------------------------
// Middlewares PAR ROUTE (jamais `use("*")`) : ce routeur partage le préfixe
// `/matches/:matchId` avec les Tables de marque (`matchTablesRouter`), dont
// les middlewares de rôle ne doivent pas s'appliquer ici — et inversement.
// Monté AVANT `matchTablesRouter` (src/api/v1/index.ts).
export const derogationAvailabilityRouter = new Hono<AppEnv>();

async function matchForPlanning(ctx: Ctx, matchId: string): Promise<MatchRow> {
  const match = await loadMatch(ctx.db, ctx.clubId, matchId);
  if (!match) throw notFound("Match introuvable.");
  if (!canCreateForTeam(ctx.actor, match.team_id) && !canManageRequests(ctx.actor)) throw forbidden("Tu ne peux consulter cette disponibilité que pour les équipes que tu encadres.", "DEROGATION_FORBIDDEN");
  return match;
}

/** GET ...?date=YYYY-MM-DD — occupation des gymnases et créneaux candidats (match cible exclu). */
derogationAvailabilityRouter.get("/derogation-availability", requireAuth, requireClubMembership, async (c) => {
  const query = DerogationAvailabilityQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));
  const date = parseLocalDate(query.data.date);
  if (!date) throw badRequest("Date invalide.");
  const ctx = await context(c);
  const match = await matchForPlanning(ctx, c.req.param("matchId") as string);

  const dayStart = zonedWallTimeToUtc(date.year, date.month, date.day, 0, 0, 0, ctx.timezone);
  const dayEnd = new Date(dayStart.getTime() + 26 * 3_600_000);
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const [rules, matches, pending] = await Promise.all([
    loadPlanningRules(ctx.db, ctx.clubId),
    loadScheduledMatches(ctx.db, ctx.clubId, dayStart, dayEnd, venues),
    loadPendingProposals(ctx.db, ctx.clubId, dayStart, dayEnd),
  ]);

  const isHome = match.is_home === true;
  const result = computeAvailability({ date: query.data.date, timezone: ctx.timezone, rules, isHome, venues: venueRefs(venues), matches, pending, targetMatchId: match.id, targetTeamId: match.team_id, now: new Date() });

  return c.json({
    matchType: isHome ? "HOME" : "AWAY",
    date: query.data.date,
    timezone: ctx.timezone,
    rules: { durationMinutes: result.durationMinutes, slotStepMinutes: DEFAULT_SLOT_STEP_MINUTES, earliestStart: result.rule?.earliestStart ?? null, latestStart: result.rule?.latestStart ?? null, gridStart: result.grid.earliestStart, gridEnd: result.grid.latestStart },
    venues: result.venues.map((v) => ({
      venue: v.venue,
      existingMatches: v.existingMatches.map((e) => ({ matchId: e.match.id, teamName: e.match.teamName, opponentName: e.match.opponentName, startAt: e.start.toISOString(), endAt: e.end.toISOString(), localStart: localTimeKey(e.start, ctx.timezone), localEnd: localTimeKey(e.end, ctx.timezone) })),
      pendingRequests: v.pendingRequests.map((p) => ({ requestId: p.proposal.requestId, teamName: p.proposal.teamName, opponentName: p.proposal.opponentName, startAt: p.start.toISOString(), endAt: p.end.toISOString(), localStart: localTimeKey(p.start, ctx.timezone), localEnd: localTimeKey(p.end, ctx.timezone) })),
      candidateStartTimes: v.candidates.map((slot) => candidateDto(slot, venues)),
    })),
    awayCandidateStartTimes: result.awayCandidates.map((slot) => candidateDto(slot, venues)),
  });
});

/** GET ...?startAt=&venueId= — vérification serveur d'une heure personnalisée (jamais un calcul front seul). */
derogationAvailabilityRouter.get("/derogation-slot-check", requireAuth, requireClubMembership, async (c) => {
  const query = DerogationSlotCheckQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));
  const ctx = await context(c);
  const match = await matchForPlanning(ctx, c.req.param("matchId") as string);
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const startAt = new Date(query.data.startAt);
  const result = await checkSlot({ db: ctx.db, clubId: ctx.clubId, timezone: ctx.timezone, match, startAt, venueId: query.data.venueId ?? null, venues, now: new Date() });
  const endAt = new Date(startAt.getTime() + DEFAULT_MATCH_DURATION_MINUTES * 60_000);

  return c.json({
    ok: result.ok,
    code: result.ok ? null : result.code,
    message: result.ok ? null : result.message,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    conflicts: !result.ok && result.code === "DEROGATION_SLOT_CONFLICT" ? result.conflicts.map((cf) => conflictDto(cf, venues)) : [],
    warnings: result.ok ? result.warnings.map(warningDto) : [],
  });
});
