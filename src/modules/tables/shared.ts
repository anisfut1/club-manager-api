import type { DbClient } from "../../db/client.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { conflict, forbidden, notFound } from "../../api-error.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { computeDayRange } from "../../util/timezone.js";
import { computeMatchWindow } from "./match-window.js";
import { DEFAULT_MATCH_DURATION_MINUTES, type TableAssignmentRole } from "./suggestion-policy.js";
import { computeTableSuggestions, determineEligibility, type LicencieCandidateInput, type RankedCandidate, type UnavailableCandidate } from "./table-suggestion-service.js";
import { loadClubDayContext, type ClubDayContext } from "./load-suggestion-data.js";

/**
 * Logique métier partagée entre le routeur ADMIN authentifié
 * (`modules/tables/routes.ts`, Supabase Auth + club_admin/responsable_tables)
 * et le routeur PUBLIC sans compte (`modules/public-tables/routes.ts`,
 * jeton personnel — retour du club, 2026-09-29 : "l'accès se fera sans
 * création de compte"). Isolé ici pour ne JAMAIS dupliquer les règles de
 * conflit/éligibilité entre les deux points d'entrée — un seul moteur, deux
 * façades.
 */

export function candidateTeamsDto(candidate: Pick<LicencieCandidateInput, "teamIds" | "teamNames">): { id: string; name: string }[] {
  return candidate.teamIds.map((id) => ({ id, name: candidate.teamNames.get(id) ?? "?" }));
}

export function findTeamNames(context: ClubDayContext, licencieId: string): Map<string, string> {
  return context.candidates.find((x) => x.licencieId === licencieId)?.teamNames ?? new Map<string, string>();
}

export interface TargetMatchRow {
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
export async function loadHomeMatchOrThrow(supabase: DbClient, clubId: string, matchId: string): Promise<TargetMatchRow> {
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

export interface AssignmentSlotDto {
  id: string;
  licencie: { id: string; firstName: string; lastName: string };
  teams: { id: string; name: string }[];
  hasConflict: boolean;
  conflictReason: string | null;
}

/** Reconstruit le slot d'un rôle pour UN match (déjà affecté ou non) + recalcule son conflit éventuel (§45/§79) via le MÊME moteur que les suggestions — jamais une vérification ad-hoc séparée. */
export function buildAssignmentSlot(
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

export interface TableAssignmentsListParams {
  /** Lecture seule — client "au nom de l'utilisateur" côté admin, client service côté public (pas de session Supabase à faire porter la RLS, voir modules/public-tables/routes.ts). */
  supabase: DbClient;
  clubId: string;
  clubTimezone: string;
  from?: string;
  to?: string;
}

/**
 * GET .../table-assignments?from=&to= (§36) — matchs à DOMICILE uniquement
 * (§4), groupés par jour calendaire (fuseau du club) pour ne recharger le
 * contexte de conflits qu'UNE fois par jour plutôt que par match. Utilisé
 * par le routeur admin ET le routeur public — même réponse, seule la porte
 * d'entrée change.
 */
export async function loadTableAssignmentsList(params: TableAssignmentsListParams) {
  const from = params.from ?? new Date().toISOString();
  const MAX_MATCHES = 200;

  let builder = params.supabase
    .from("matches")
    .select("id, numero, team_id, match_datetime, opponent_name, venue_raw_label")
    .eq("club_id", params.clubId)
    .eq("is_home", true)
    .gte("match_datetime", from);
  if (params.to) builder = builder.lt("match_datetime", params.to);

  const { data: matches, error } = await builder.order("match_datetime", { ascending: true }).limit(MAX_MATCHES);
  if (error) throw new Error(`Lecture des matchs à domicile échouée : ${error.message}`);

  const homeMatches = (matches ?? []).filter((m): m is typeof m & { match_datetime: string } => m.match_datetime !== null);

  const { data: teams } = await params.supabase.from("teams").select("id, name, sexe").eq("club_id", params.clubId);
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));

  const homeMatchIds = homeMatches.map((m) => m.id);
  const { data: refereeOverrides } = homeMatchIds.length
    ? await params.supabase.from("match_referee_overrides").select("match_id, no_referee_needed").eq("club_id", params.clubId).in("match_id", homeMatchIds)
    : { data: [] };
  const refereeNotNeededByMatchId = new Set((refereeOverrides ?? []).filter((o) => o.no_referee_needed).map((o) => o.match_id));

  const contextByDayKey = new Map<string, ClubDayContext>();
  const dayKeyFor = (isoDatetime: string): string => computeDayRange(new Date(isoDatetime), params.clubTimezone).from;

  for (const m of homeMatches) {
    const dayKey = dayKeyFor(m.match_datetime);
    if (!contextByDayKey.has(dayKey)) {
      contextByDayKey.set(dayKey, await loadClubDayContext(params.supabase, params.clubId, new Date(m.match_datetime), params.clubTimezone));
    }
  }

  return homeMatches.map((m) => {
    const context = contextByDayKey.get(dayKeyFor(m.match_datetime))!;
    const window = computeMatchWindow(new Date(m.match_datetime), DEFAULT_MATCH_DURATION_MINUTES);
    const matchRef = { id: m.id, venue_raw_label: m.venue_raw_label, window };

    const scorer = buildAssignmentSlot("SCORER", matchRef, context, params.clubTimezone);
    const timekeeper = buildAssignmentSlot("TIMEKEEPER", matchRef, context, params.clubTimezone);
    const clubDelegate = buildAssignmentSlot("CLUB_DELEGATE", matchRef, context, params.clubTimezone);
    const referee = buildAssignmentSlot("REFEREE", matchRef, context, params.clubTimezone);
    const hasConflict = [scorer, timekeeper, clubDelegate, referee].some((slot) => slot?.hasConflict === true);

    return {
      match: {
        id: m.id,
        numero: m.numero,
        matchDatetime: m.match_datetime,
        teamName: m.team_id ? (teamNameById.get(m.team_id) ?? null) : null,
        opponentName: m.opponent_name,
        venueLabel: m.venue_raw_label,
      },
      assignments: { scorer, timekeeper, clubDelegate, referee },
      refereeNotNeeded: refereeNotNeededByMatchId.has(m.id),
      hasConflict,
    };
  });
}

export interface AssignTableRoleParams {
  /** Lecture seule, pour charger le contexte de conflits (candidats/matchs/affectations du jour). */
  readSupabase: DbClient;
  clubId: string;
  clubTimezone: string;
  matchId: string;
  matchVenueRawLabel: string | null;
  matchDatetime: string;
  role: TableAssignmentRole;
  licencie: { id: string; firstName: string; lastName: string; teamId: string | null };
  /** `null` pour une auto-affectation publique (aucun compte Supabase, voir modules/public-tables/routes.ts). */
  createdByUserId: string | null;
  /**
   * Retour du club, 2026-09-29 : "la personne qui va se mettre sur un
   * match ne peut pas être supprimée [ni donc remplacée] par quelqu'un
   * d'autre sauf un admin" — le flux PUBLIC ne doit JAMAIS écraser
   * silencieusement un·e titulaire différent·e (contrairement au PUT admin,
   * qui reste volontairement un remplacement direct — §77 "Modifier").
   */
  blockIfHeldBySomeoneElse?: boolean;
}

/**
 * PUT .../table-assignments/:role (§40/§42/§43) — recalcule TOUJOURS les
 * conflits au moment de l'écriture, jamais de force/override. Partagée par
 * l'admin (peut remplacer n'importe qui) et le flux public (ne peut jamais
 * remplacer quelqu'un d'autre, voir `blockIfHeldBySomeoneElse`).
 */
export async function assignTableRole(params: AssignTableRoleParams): Promise<AssignmentSlotDto> {
  const targetWindow = computeMatchWindow(new Date(params.matchDatetime), DEFAULT_MATCH_DURATION_MINUTES);
  const context = await loadClubDayContext(params.readSupabase, params.clubId, new Date(params.matchDatetime), params.clubTimezone);

  if (params.blockIfHeldBySomeoneElse) {
    const existing = context.existingTableAssignments.find((a) => a.matchId === params.matchId && a.role === params.role);
    if (existing && existing.licencieId !== params.licencie.id) {
      throw conflict("Ce poste est déjà occupé par quelqu'un d'autre — demande à un·e responsable si besoin.", "ALREADY_TAKEN_BY_SOMEONE_ELSE");
    }
  }

  const candidateInput: LicencieCandidateInput = {
    licencieId: params.licencie.id,
    firstName: params.licencie.firstName,
    lastName: params.licencie.lastName,
    teamIds: params.licencie.teamId ? [params.licencie.teamId] : [],
    teamNames: findTeamNames(context, params.licencie.id),
  };

  const conflictResult = determineEligibility(candidateInput, {
    targetMatchId: params.matchId,
    targetRole: params.role,
    targetWindow,
    targetVenueRawLabel: params.matchVenueRawLabel,
    clubTimezone: params.clubTimezone,
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
    .upsert(
      { club_id: params.clubId, match_id: params.matchId, role: params.role, licencie_id: params.licencie.id, created_by: params.createdByUserId, updated_at: new Date().toISOString() },
      { onConflict: "club_id,match_id,role" },
    )
    .select("id")
    .single();

  if (error || !saved) throw new Error(`Enregistrement de l'affectation échoué : ${error?.message}`);

  return {
    id: saved.id,
    licencie: { id: params.licencie.id, firstName: params.licencie.firstName, lastName: params.licencie.lastName },
    teams: candidateTeamsDto(candidateInput),
    hasConflict: false,
    conflictReason: null,
  };
}

/**
 * DELETE .../table-assignments/:role (§41) — remet le poste à "à
 * attribuer". `onlyIfLicencieId` (retour du club, 2026-09-29) restreint le
 * retrait au titulaire lui-même : le flux public ne peut jamais retirer
 * l'affectation de quelqu'un d'autre (seul un admin, via le routeur admin
 * qui n'utilise jamais cette option, le peut).
 */
export async function removeTableRole(clubId: string, matchId: string, role: TableAssignmentRole, opts?: { onlyIfLicencieId?: string }): Promise<void> {
  const serviceSupabase = createServiceSupabaseClient();

  if (opts?.onlyIfLicencieId) {
    const { data: existing } = await serviceSupabase.from("table_assignments").select("licencie_id").eq("club_id", clubId).eq("match_id", matchId).eq("role", role).maybeSingle();
    if (!existing) return; // rien à retirer, jamais une erreur pour un poste déjà vide
    if (existing.licencie_id !== opts.onlyIfLicencieId) {
      throw forbidden("Seule la personne affectée à ce poste (ou un·e responsable du club) peut le retirer.");
    }
  }

  const { error } = await serviceSupabase.from("table_assignments").delete().eq("club_id", clubId).eq("match_id", matchId).eq("role", role);
  if (error) throw new Error(`Suppression de l'affectation échouée : ${error.message}`);
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

/**
 * Suggestions pour un poste d'un match à domicile (§37/§39) — STRICTEMENT
 * en lecture. Partagé par la vue admin et l'espace public des coachs /
 * admins (retour du club, 2026-10-02 : « désigner qui il veut comme un
 * admin général sur la page tables »).
 */
export async function buildTableSuggestions(supabase: DbClient, club: { id: string; timezone: string }, matchId: string, role: TableAssignmentRole) {
  const match = await loadHomeMatchOrThrow(supabase, club.id, matchId);
  const targetWindow = computeMatchWindow(new Date(match.match_datetime), DEFAULT_MATCH_DURATION_MINUTES);
  const context = await loadClubDayContext(supabase, club.id, new Date(match.match_datetime), club.timezone);

  const result = computeTableSuggestions({
    targetMatchId: match.id,
    targetRole: role,
    targetWindow,
    targetVenueRawLabel: match.venue_raw_label,
    clubTimezone: club.timezone,
    candidates: context.candidates,
    teamMatches: context.teamMatches,
    existingTableAssignments: context.existingTableAssignments,
    seasonAssignmentCountByLicencieId: context.seasonAssignmentCountByLicencieId,
    todayAssignmentCountByLicencieId: context.todayAssignmentCountByLicencieId,
  });

  return {
    recommended: result.recommended.map((r) => mapRankedCandidateToDto(r, context)),
    available: result.available.map((r) => mapRankedCandidateToDto(r, context)),
    unavailable: result.unavailable.map((u) => mapUnavailableCandidateToDto(u, context)),
  };
}

/**
 * « Pas besoin d'arbitre » (retour du club, 2026-09-28) — absence de ligne
 * = un arbitre du club est nécessaire, jamais une ligne à `false`.
 * `createdByUserId` null depuis l'espace public (pas de compte).
 */
export async function setRefereeNotNeeded(clubId: string, matchId: string, noRefereeNeeded: boolean, createdByUserId: string | null): Promise<void> {
  const serviceSupabase = createServiceSupabaseClient();
  if (noRefereeNeeded) {
    const { error } = await serviceSupabase
      .from("match_referee_overrides")
      .upsert({ club_id: clubId, match_id: matchId, no_referee_needed: true, created_by: createdByUserId, updated_at: new Date().toISOString() }, { onConflict: "club_id,match_id" });
    if (error) throw new Error(`Enregistrement du statut arbitre échoué : ${error.message}`);
  } else {
    const { error } = await serviceSupabase.from("match_referee_overrides").delete().eq("club_id", clubId).eq("match_id", matchId);
    if (error) throw new Error(`Suppression du statut arbitre échouée : ${error.message}`);
  }
}
