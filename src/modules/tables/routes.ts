import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireAnyClubRole } from "../../auth/middleware.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { computeDayRange } from "../../util/timezone.js";
import { TableSuggestionsQueryDtoSchema, TableAssignmentsQueryDtoSchema, PutTableAssignmentDtoSchema, TableAssignmentRoleSchema } from "../../contracts/tables.js";
import { computeMatchWindow } from "./match-window.js";
import { DEFAULT_MATCH_DURATION_MINUTES, type TableAssignmentRole } from "./suggestion-policy.js";
import { computeTableSuggestions, determineEligibility, type LicencieCandidateInput, type RankedCandidate, type UnavailableCandidate } from "./table-suggestion-service.js";
import { loadClubDayContext, type ClubDayContext } from "./load-suggestion-data.js";

/**
 * Tables de marque (demande du club, 2026-09-28). DEUX routeurs montés à
 * des chemins différents (voir src/api/v1/index.ts) :
 * - `tableAssignmentsRouter` : `/v1/clubs/:clubId/table-assignments`
 *   (vue liste, §36).
 * - `matchTablesRouter` : `/v1/clubs/:clubId/matches/:matchId` (suggestions
 *   + écriture d'une affectation par rôle, §37/§40/§41), mêmes principes
 *   que `documentsRouter` déjà monté sous `matches/:matchId/documents`.
 *
 * Accès réservé à club_admin OU responsable_tables (§31 : rôle déjà
 * présent dans club_role, jamais exploité avant ce module) — voir
 * `requireAnyClubRole`, `auth/middleware.ts`.
 */
const TABLE_MANAGER_ROLES = ["club_admin", "responsable_tables"] as const;

export const tableAssignmentsRouter = new Hono<AppEnv>();
export const matchTablesRouter = new Hono<AppEnv>();

tableAssignmentsRouter.use("*", requireAuth);
tableAssignmentsRouter.use("*", requireClubMembership);
tableAssignmentsRouter.use("*", requireAnyClubRole(TABLE_MANAGER_ROLES));

matchTablesRouter.use("*", requireAuth);
matchTablesRouter.use("*", requireClubMembership);
matchTablesRouter.use("*", requireAnyClubRole(TABLE_MANAGER_ROLES));

function candidateTeamsDto(candidate: Pick<LicencieCandidateInput, "teamIds" | "teamNames">): { id: string; name: string }[] {
  return candidate.teamIds.map((id) => ({ id, name: candidate.teamNames.get(id) ?? "?" }));
}

function findTeamNames(context: ClubDayContext, licencieId: string): Map<string, string> {
  return context.candidates.find((x) => x.licencieId === licencieId)?.teamNames ?? new Map<string, string>();
}

function mapRankedCandidateToDto(candidate: RankedCandidate, context: ClubDayContext) {
  const teamNames = findTeamNames(context, candidate.licencieId);
  return {
    licencie: { id: candidate.licencieId, firstName: candidate.firstName, lastName: candidate.lastName },
    teams: candidateTeamsDto({ teamIds: candidate.teamIds, teamNames }),
    eligibility: candidate.eligibility,
    priorityTier: candidate.priorityTier,
    score: candidate.score,
    reasons: candidate.reasons,
    seasonAssignmentCount: candidate.seasonAssignmentCount,
    sameDayAssignmentCount: candidate.sameDayAssignmentCount,
    isCurrentHolder: candidate.isCurrentHolder,
  };
}

function mapUnavailableCandidateToDto(candidate: UnavailableCandidate, context: ClubDayContext) {
  const teamNames = findTeamNames(context, candidate.licencieId);
  return {
    licencie: { id: candidate.licencieId, firstName: candidate.firstName, lastName: candidate.lastName },
    teams: candidateTeamsDto({ teamIds: candidate.teamIds, teamNames }),
    eligibility: candidate.eligibility,
    reasonCode: candidate.reasonCode,
    reason: candidate.reason,
    conflictingMatchId: candidate.conflictingMatchId,
  };
}

interface TargetMatchRow {
  id: string;
  club_id: string;
  numero: string | null;
  team_id: string | null;
  is_home: boolean | null;
  match_datetime: string;
  opponent_name: string | null;
  venue_raw_label: string | null;
}

/** §44 : le backend refuse toute lecture/écriture de table pour un match extérieur — jamais seulement une convention frontend. */
async function loadHomeMatchOrThrow(supabase: DbClient, clubId: string, matchId: string): Promise<TargetMatchRow> {
  const { data: match } = await supabase
    .from("matches")
    .select("id, club_id, numero, team_id, is_home, match_datetime, opponent_name, venue_raw_label")
    .eq("id", matchId)
    .eq("club_id", clubId)
    .maybeSingle();

  if (!match) throw notFound("Match introuvable.");
  if (match.is_home !== true) throw conflict("Une table de marque ne peut être gérée que pour un match à domicile.", "AWAY_MATCH_NOT_SUPPORTED");
  if (!match.match_datetime) throw conflict("Ce match n'a pas encore de date/heure connue — impossible de calculer son créneau.", "MATCH_DATETIME_UNKNOWN");

  return { ...match, match_datetime: match.match_datetime };
}

/**
 * GET .../matches/:matchId/table-suggestions?role=SCORER (§37/§39) —
 * STRICTEMENT en lecture (§37 : "GET suggestions est READ-ONLY, il ne crée
 * aucune ligne") : appelle uniquement `computeTableSuggestions` (fonction
 * pure), aucun `.insert()`/`.update()` nulle part dans ce handler.
 */
matchTablesRouter.get("/table-suggestions", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const query = TableSuggestionsQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  const match = await loadHomeMatchOrThrow(supabase, club.id, matchId);
  const targetWindow = computeMatchWindow(new Date(match.match_datetime), DEFAULT_MATCH_DURATION_MINUTES);
  const context = await loadClubDayContext(supabase, club.id, new Date(match.match_datetime), club.timezone);

  const result = computeTableSuggestions({
    targetMatchId: match.id,
    targetRole: query.data.role,
    targetWindow,
    targetVenueRawLabel: match.venue_raw_label,
    clubTimezone: club.timezone,
    candidates: context.candidates,
    teamMatches: context.teamMatches,
    existingTableAssignments: context.existingTableAssignments,
    seasonAssignmentCountByLicencieId: context.seasonAssignmentCountByLicencieId,
    todayAssignmentCountByLicencieId: context.todayAssignmentCountByLicencieId,
  });

  return c.json({
    recommended: result.recommended.map((r) => mapRankedCandidateToDto(r, context)),
    available: result.available.map((r) => mapRankedCandidateToDto(r, context)),
    unavailable: result.unavailable.map((u) => mapUnavailableCandidateToDto(u, context)),
  });
});

/**
 * PUT .../matches/:matchId/table-assignments/:role (§40/§42/§43) — SEULE
 * route qui transforme une suggestion en affectation réelle. Recalcule
 * TOUJOURS les conflits au moment de l'écriture (§42 : "ne fais pas
 * confiance au fait que le candidat était disponible 30 secondes
 * auparavant") — jamais de force/override en V1 (§43).
 */
matchTablesRouter.put("/table-assignments/:role", async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const matchId = c.req.param("matchId");
  const roleParam = c.req.param("role");
  if (!matchId || !roleParam) throw badRequest("Paramètres de route manquants.");

  const role = TableAssignmentRoleSchema.safeParse(roleParam);
  if (!role.success) throw badRequest(`Rôle inconnu : ${roleParam}.`);

  const body = PutTableAssignmentDtoSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));

  const match = await loadHomeMatchOrThrow(supabase, club.id, matchId);

  // Scopé à CE club (§59 : jamais un licencié d'un autre club, même UUID connu) — 404, jamais une 403 qui confirmerait son existence ailleurs.
  const { data: licencie } = await supabase.from("licencies").select("id, first_name, last_name, team_id").eq("id", body.data.licencieId).eq("club_id", club.id).maybeSingle();
  if (!licencie) throw notFound("Licencié introuvable pour ce club.");

  const targetWindow = computeMatchWindow(new Date(match.match_datetime), DEFAULT_MATCH_DURATION_MINUTES);
  const context = await loadClubDayContext(supabase, club.id, new Date(match.match_datetime), club.timezone);

  const candidateInput: LicencieCandidateInput = {
    licencieId: licencie.id,
    firstName: licencie.first_name,
    lastName: licencie.last_name,
    teamIds: licencie.team_id ? [licencie.team_id] : [],
    teamNames: findTeamNames(context, licencie.id),
  };

  const conflictResult = determineEligibility(candidateInput, {
    targetMatchId: match.id,
    targetRole: role.data,
    targetWindow,
    targetVenueRawLabel: match.venue_raw_label,
    clubTimezone: club.timezone,
    candidates: context.candidates,
    teamMatches: context.teamMatches,
    existingTableAssignments: context.existingTableAssignments,
    seasonAssignmentCountByLicencieId: context.seasonAssignmentCountByLicencieId,
    todayAssignmentCountByLicencieId: context.todayAssignmentCountByLicencieId,
  });

  if (conflictResult) throw conflict(conflictResult.reason, conflictResult.code);

  const serviceSupabase = createServiceSupabaseClient();
  const { data: saved, error } = await serviceSupabase
    .from("table_assignments")
    .upsert({ club_id: club.id, match_id: match.id, role: role.data, licencie_id: licencie.id, created_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "club_id,match_id,role" })
    .select("id")
    .single();

  if (error || !saved) throw new Error(`Enregistrement de l'affectation échoué : ${error?.message}`);

  return c.json({
    assignment: {
      id: saved.id,
      licencie: { id: licencie.id, firstName: licencie.first_name, lastName: licencie.last_name },
      teams: candidateTeamsDto(candidateInput),
      hasConflict: false,
      conflictReason: null,
    },
  });
});

/** DELETE .../matches/:matchId/table-assignments/:role (§41) — remet le poste "À attribuer". */
matchTablesRouter.delete("/table-assignments/:role", async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  const roleParam = c.req.param("role");
  if (!matchId || !roleParam) throw badRequest("Paramètres de route manquants.");

  const role = TableAssignmentRoleSchema.safeParse(roleParam);
  if (!role.success) throw badRequest(`Rôle inconnu : ${roleParam}.`);

  const serviceSupabase = createServiceSupabaseClient();
  const { error } = await serviceSupabase.from("table_assignments").delete().eq("club_id", club.id).eq("match_id", matchId).eq("role", role.data);
  if (error) throw new Error(`Suppression de l'affectation échouée : ${error.message}`);

  return c.json({ removed: true as const });
});

interface AssignmentSlotDto {
  id: string;
  licencie: { id: string; firstName: string; lastName: string };
  teams: { id: string; name: string }[];
  hasConflict: boolean;
  conflictReason: string | null;
}

/** Reconstruit le slot d'un rôle pour UN match (déjà affecté ou non) + recalcule son conflit éventuel (§45/§79) via le MÊME moteur que les suggestions — jamais une vérification ad-hoc séparée. */
function buildAssignmentSlot(
  role: TableAssignmentRole,
  match: { id: string; venue_raw_label: string | null; window: ReturnType<typeof computeMatchWindow> },
  context: ClubDayContext,
  clubTimezone: string,
): AssignmentSlotDto | null {
  const existing = context.existingTableAssignments.find((a) => a.matchId === match.id && a.role === role);
  if (!existing) return null;

  const licencie = context.candidates.find((cand) => cand.licencieId === existing.licencieId);
  const candidateInput: LicencieCandidateInput = licencie ?? { licencieId: existing.licencieId, firstName: "?", lastName: "?", teamIds: [], teamNames: new Map() };

  const conflictResult = determineEligibility(candidateInput, {
    targetMatchId: match.id,
    targetRole: role,
    targetWindow: match.window,
    targetVenueRawLabel: match.venue_raw_label,
    clubTimezone,
    candidates: context.candidates,
    teamMatches: context.teamMatches,
    existingTableAssignments: context.existingTableAssignments,
    seasonAssignmentCountByLicencieId: context.seasonAssignmentCountByLicencieId,
    todayAssignmentCountByLicencieId: context.todayAssignmentCountByLicencieId,
  });

  return {
    id: `${match.id}:${role}`,
    licencie: { id: candidateInput.licencieId, firstName: candidateInput.firstName, lastName: candidateInput.lastName },
    teams: candidateTeamsDto(candidateInput),
    hasConflict: conflictResult !== null,
    conflictReason: conflictResult?.reason ?? null,
  };
}

/**
 * GET /v1/clubs/:clubId/table-assignments?from=&to= (§36) — matchs à
 * DOMICILE uniquement (§4 : un match extérieur n'apparaît jamais ici),
 * groupés par jour calendaire (fuseau du club) pour ne recharger le
 * contexte de conflits qu'UNE fois par jour plutôt que par match.
 */
tableAssignmentsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const query = TableAssignmentsQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  // Pas de borne explicite -> matchs à venir uniquement (§36 : jamais tout
  // l'historique par défaut, même raisonnement que GET .../matches).
  const from = query.data.from ?? new Date().toISOString();
  const MAX_MATCHES = 200;

  let builder = supabase.from("matches").select("id, numero, team_id, match_datetime, opponent_name, venue_raw_label").eq("club_id", club.id).eq("is_home", true).gte("match_datetime", from);
  if (query.data.to) builder = builder.lt("match_datetime", query.data.to);

  const { data: matches, error } = await builder.order("match_datetime", { ascending: true }).limit(MAX_MATCHES);
  if (error) throw new Error(`Lecture des matchs à domicile échouée : ${error.message}`);

  const homeMatches = (matches ?? []).filter((m): m is typeof m & { match_datetime: string } => m.match_datetime !== null);

  const { data: teams } = await supabase.from("teams").select("id, name, sexe").eq("club_id", club.id);
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));

  // Un seul loadClubDayContext par jour calendaire distinct (club.timezone), partagé par tous les matchs de ce jour.
  const contextByDayKey = new Map<string, ClubDayContext>();
  const dayKeyFor = (isoDatetime: string): string => computeDayRange(new Date(isoDatetime), club.timezone).from;

  for (const m of homeMatches) {
    const dayKey = dayKeyFor(m.match_datetime);
    if (!contextByDayKey.has(dayKey)) {
      contextByDayKey.set(dayKey, await loadClubDayContext(supabase, club.id, new Date(m.match_datetime), club.timezone));
    }
  }

  const responseMatches = homeMatches.map((m) => {
    const context = contextByDayKey.get(dayKeyFor(m.match_datetime))!;
    const window = computeMatchWindow(new Date(m.match_datetime), DEFAULT_MATCH_DURATION_MINUTES);
    const matchRef = { id: m.id, venue_raw_label: m.venue_raw_label, window };

    const scorer = buildAssignmentSlot("SCORER", matchRef, context, club.timezone);
    const timekeeper = buildAssignmentSlot("TIMEKEEPER", matchRef, context, club.timezone);
    const clubDelegate = buildAssignmentSlot("CLUB_DELEGATE", matchRef, context, club.timezone);
    const hasConflict = [scorer, timekeeper, clubDelegate].some((slot) => slot?.hasConflict === true);

    return {
      match: {
        id: m.id,
        numero: m.numero,
        matchDatetime: m.match_datetime,
        teamName: m.team_id ? (teamNameById.get(m.team_id) ?? null) : null,
        opponentName: m.opponent_name,
        venueLabel: m.venue_raw_label,
      },
      assignments: { scorer, timekeeper, clubDelegate },
      hasConflict,
    };
  });

  return c.json({ matches: responseMatches });
});
