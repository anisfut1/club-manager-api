import type { DbClient } from "../../db/client.js";
import type { ClubRole, DerogationRequestStatus } from "../../db/types.js";
import { DEFAULT_MATCH_DURATION_MINUTES } from "../../scheduling/match-slot.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import type { PendingProposal, PlanningRules, ScheduledMatch, VenueRef } from "./availability.js";
import { ACTIVE_STATUSES, COORDINATOR_ROLE, availableActions, canPropose, canReadRequest, canSubmitOfficial, isSameIdentity, needsCoordinatorAttention, type Actor, type RoleGrant } from "./policy.js";

/**
 * Accès aux données des demandes de dérogation internes. Toujours via le
 * client SERVICE et TOUJOURS filtré par `club_id` : les permissions sont
 * appliquées en code (policy.ts), la RLS (`can_read_derogation_request`)
 * reste une défense en profondeur pour tout accès direct.
 *
 * AUCUNE fonction de ce module n'écrit sur FFBB/FBI ni sur `matches`.
 */

const durationMs = DEFAULT_MATCH_DURATION_MINUTES * 60_000;
const endOf = (iso: string) => new Date(new Date(iso).getTime() + durationMs).toISOString();

export async function loadActor(db: DbClient, membershipId: string, userId: string): Promise<Actor> {
  const [{ data, error }, { data: membership }] = await Promise.all([
    db.from("membership_roles").select("role, scope_team_id").eq("membership_id", membershipId),
    db.from("club_memberships").select("licencie_id").eq("id", membershipId).maybeSingle(),
  ]);
  if (error) throw new Error(`Lecture des rôles échouée : ${error.message}`);
  // Licencié rattaché au compte : ses demandes faites via le lien personnel restent « les siennes » une fois connecté.
  return { userId, licencieId: membership?.licencie_id ?? null, roles: (data ?? []).map((r) => ({ role: r.role as ClubRole, scopeTeamId: r.scope_team_id ?? null })) };
}

/**
 * Acteur de l'espace PUBLIC (lien personnel, sans compte) — retour du club,
 * 2026-10-01 : rôles posés depuis /joueurs sur le licencié, sans portée
 * d'équipe (« juste le rôle coach ») :
 *  - `public_coach` → coach de toutes les équipes ;
 *  - `public_coordinator` → coordinateur ;
 *  - `public_admin` → mêmes droits qu'un club_admin pour les demandes.
 * S'y ajoutent les rôles d'un compte ACTIF rattaché à ce licencié (même
 * règle que `isLicencieClubAdmin` pour les dérogations FBI publiques).
 */
export async function loadLicencieActor(db: DbClient, clubId: string, licencieId: string): Promise<Actor> {
  const [{ data: licencie }, { data: memberships }] = await Promise.all([
    db.from("licencies").select("public_admin, public_coach, public_coordinator").eq("id", licencieId).eq("club_id", clubId).maybeSingle(),
    db.from("club_memberships").select("id, user_id").eq("club_id", clubId).eq("licencie_id", licencieId).eq("status", "active"),
  ]);
  const roles: RoleGrant[] = [];
  if (licencie?.public_coach) roles.push({ role: "coach", scopeTeamId: null });
  if (licencie?.public_coordinator) roles.push({ role: COORDINATOR_ROLE, scopeTeamId: null });
  if (licencie?.public_admin) roles.push({ role: "club_admin", scopeTeamId: null });
  const ids = (memberships ?? []).map((m) => m.id);
  if (ids.length) {
    const { data: grants } = await db.from("membership_roles").select("role, scope_team_id").in("membership_id", ids);
    for (const g of grants ?? []) if (["coach", COORDINATOR_ROLE, "club_admin"].includes(g.role)) roles.push({ role: g.role as ClubRole, scopeTeamId: g.scope_team_id ?? null });
  }
  const userId = memberships?.length === 1 ? memberships[0]!.user_id : null;
  return { userId, licencieId, roles };
}

/** L'acteur public a-t-il un rôle sur les demandes de dérogation ? */
export function hasDerogationRole(actor: Actor): boolean {
  return actor.roles.some((r) => r.role === "coach" || r.role === COORDINATOR_ROLE || r.role === "club_admin");
}

/** « Demande formulée par » : prénom du licencié rattaché, sinon nom d'affichage, sinon partie locale de l'email. */
export async function resolveRequesterName(db: DbClient, membershipId: string, userId: string, email: string | null): Promise<{ name: string; source: "LICENCIE" | "PROFILE" | "EMAIL" }> {
  const { data: membership } = await db.from("club_memberships").select("licencie_id").eq("id", membershipId).maybeSingle();
  if (membership?.licencie_id) {
    const { data: licencie } = await db.from("licencies").select("first_name").eq("id", membership.licencie_id).maybeSingle();
    if (licencie?.first_name?.trim()) return { name: licencie.first_name.trim(), source: "LICENCIE" };
  }
  const { data: profile } = await db.from("profiles").select("display_name").eq("user_id", userId).maybeSingle();
  const display = profile?.display_name?.trim();
  if (display && !display.includes("@")) return { name: display, source: "PROFILE" };
  const local = (email ?? display ?? "").split("@")[0]?.trim();
  return { name: local || "Coach", source: "EMAIL" };
}

/** Au moins un coordinateur : membre actif `correspondant_club`, ou licencié actif marqué « Coordinateur » depuis /joueurs. */
export async function coordinatorsConfigured(db: DbClient, clubId: string): Promise<boolean> {
  const { data: flagged } = await db.from("licencies").select("id").eq("club_id", clubId).eq("public_coordinator", true).eq("active", true).limit(1);
  if ((flagged ?? []).length > 0) return true;
  const { data: memberships } = await db.from("club_memberships").select("id").eq("club_id", clubId).eq("status", "active");
  const ids = (memberships ?? []).map((m) => m.id);
  if (ids.length === 0) return false;
  const { data: roles } = await db.from("membership_roles").select("membership_id").in("membership_id", ids).eq("role", COORDINATOR_ROLE);
  return (roles ?? []).length > 0;
}

export interface ClubVenueRow {
  id: string;
  name: string;
  address: string | null;
  venue_id: string | null;
}

export async function loadClubVenues(db: DbClient, clubId: string): Promise<ClubVenueRow[]> {
  const { data, error } = await db.from("club_venues").select("id, name, address, venue_id, active, sort_order").eq("club_id", clubId).eq("active", true).order("sort_order").order("name");
  if (error) throw new Error(`Lecture des gymnases échouée : ${error.message}`);
  return (data ?? []).map((v) => ({ id: v.id, name: v.name, address: v.address, venue_id: v.venue_id }));
}

export function venueRefs(venues: readonly ClubVenueRow[]): VenueRef[] {
  return venues.map((v) => ({ id: v.id, name: v.name, address: v.address }));
}

export async function loadPlanningRules(db: DbClient, clubId: string): Promise<PlanningRules> {
  const { data, error } = await db.from("club_scheduling_rules").select("weekday, earliest_start, latest_start").eq("club_id", clubId);
  if (error) throw new Error(`Lecture des règles de planning échouée : ${error.message}`);
  const rules: PlanningRules = {};
  for (const row of data ?? []) rules[row.weekday] = { earliestStart: row.earliest_start.slice(0, 5), latestStart: row.latest_start.slice(0, 5) };
  return rules;
}

export interface MatchRow {
  id: string;
  club_id: string;
  numero: string | null;
  team_id: string | null;
  is_home: boolean | null;
  match_datetime: string | null;
  opponent_name: string | null;
  venue_id: string | null;
  venue_raw_label: string | null;
  status: string;
  competition_id: string | null;
}

const MATCH_COLUMNS = "id, club_id, numero, team_id, is_home, match_datetime, opponent_name, venue_id, venue_raw_label, status, competition_id";

export async function loadMatch(db: DbClient, clubId: string, matchId: string): Promise<MatchRow | null> {
  const { data } = await db.from("matches").select(MATCH_COLUMNS).eq("id", matchId).eq("club_id", clubId).maybeSingle();
  return (data as MatchRow | null) ?? null;
}

/** Libellés équipe/catégorie/salle d'un lot de matchs (une requête par table). */
export async function loadMatchLabels(db: DbClient, matches: readonly MatchRow[]): Promise<{ teamName: Map<string, string>; categoryLabel: Map<string, string | null> }> {
  const teamIds = [...new Set(matches.map((m) => m.team_id).filter((id): id is string => Boolean(id)))];
  const competitionIds = [...new Set(matches.map((m) => m.competition_id).filter((id): id is string => Boolean(id)))];
  const [{ data: teams }, { data: competitions }] = await Promise.all([
    teamIds.length ? db.from("teams").select("id, name, sexe").in("id", teamIds) : Promise.resolve({ data: [] as { id: string; name: string; sexe: "M" | "F" | null }[] }),
    competitionIds.length ? db.from("competitions").select("id, category_label").in("id", competitionIds) : Promise.resolve({ data: [] as { id: string; category_label: string | null }[] }),
  ]);
  return {
    teamName: new Map((teams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)])),
    categoryLabel: new Map((competitions ?? []).map((c) => [c.id, c.category_label])),
  };
}

export function matchRef(match: MatchRow, labels: Awaited<ReturnType<typeof loadMatchLabels>>) {
  return {
    id: match.id,
    numero: match.numero,
    teamId: match.team_id,
    teamName: match.team_id ? (labels.teamName.get(match.team_id) ?? null) : null,
    categoryLabel: match.competition_id ? (labels.categoryLabel.get(match.competition_id) ?? null) : null,
    opponentName: match.opponent_name,
    isHome: match.is_home,
    matchDatetime: match.match_datetime,
    venueName: match.venue_raw_label ? (match.venue_raw_label.split(" — ")[0] ?? null) : null,
    status: match.status,
  };
}

/** Matchs programmés (hors annulés) qui peuvent chevaucher [from ; to) — HARD conflicts. */
export async function loadScheduledMatches(db: DbClient, clubId: string, from: Date, to: Date, venues: readonly ClubVenueRow[]): Promise<ScheduledMatch[]> {
  const { data, error } = await db
    .from("matches")
    .select(MATCH_COLUMNS)
    .eq("club_id", clubId)
    .gte("match_datetime", new Date(from.getTime() - durationMs).toISOString())
    .lt("match_datetime", to.toISOString());
  if (error) throw new Error(`Lecture des matchs échouée : ${error.message}`);
  const rows = ((data ?? []) as MatchRow[]).filter((m) => m.match_datetime && m.status !== "cancelled");
  const labels = await loadMatchLabels(db, rows);
  const clubVenueByVenueId = new Map(venues.filter((v) => v.venue_id).map((v) => [v.venue_id as string, v.id]));
  return rows.map((m) => ({
    id: m.id,
    startAt: new Date(m.match_datetime as string),
    clubVenueId: m.is_home && m.venue_id ? (clubVenueByVenueId.get(m.venue_id) ?? null) : null,
    teamId: m.team_id,
    teamName: m.team_id ? (labels.teamName.get(m.team_id) ?? null) : null,
    opponentName: m.opponent_name,
    isHome: m.is_home,
  }));
}

/** Autres demandes ACTIVES dont la proposition courante tombe dans [from ; to) — SOFT warnings. */
export async function loadPendingProposals(db: DbClient, clubId: string, from: Date, to: Date): Promise<PendingProposal[]> {
  const { data, error } = await db
    .from("derogation_requests")
    .select("id, match_id, requested_start_at, requested_club_venue_id, status")
    .eq("club_id", clubId)
    .in("status", [...ACTIVE_STATUSES])
    .gte("requested_start_at", new Date(from.getTime() - durationMs).toISOString())
    .lt("requested_start_at", to.toISOString());
  if (error) throw new Error(`Lecture des demandes en cours échouée : ${error.message}`);
  const rows = data ?? [];
  const matchIds = [...new Set(rows.map((r) => r.match_id))];
  const { data: matches } = matchIds.length ? await db.from("matches").select(MATCH_COLUMNS).in("id", matchIds) : { data: [] };
  const matchRows = (matches ?? []) as MatchRow[];
  const labels = await loadMatchLabels(db, matchRows);
  const byId = new Map(matchRows.map((m) => [m.id, m]));
  return rows.map((r) => {
    const m = byId.get(r.match_id);
    return {
      requestId: r.id,
      matchId: r.match_id,
      startAt: new Date(r.requested_start_at),
      clubVenueId: r.requested_club_venue_id,
      teamName: m?.team_id ? (labels.teamName.get(m.team_id) ?? null) : null,
      opponentName: m?.opponent_name ?? null,
    };
  });
}

export interface RequestRow {
  id: string;
  club_id: string;
  match_id: string;
  team_id: string | null;
  created_by_user_id: string | null;
  created_by_licencie_id: string | null;
  requester_membership_id: string | null;
  requester_display_name: string;
  original_scheduled_at: string | null;
  original_venue_id: string | null;
  requested_start_at: string;
  requested_club_venue_id: string | null;
  is_custom_weekday: boolean;
  status: DerogationRequestStatus;
  created_at: string;
  updated_at: string;
  last_message_at: string;
}

export const REQUEST_COLUMNS =
  "id, club_id, match_id, team_id, created_by_user_id, created_by_licencie_id, requester_membership_id, requester_display_name, original_scheduled_at, original_venue_id, requested_start_at, requested_club_venue_id, is_custom_weekday, status, created_at, updated_at, last_message_at";

export async function loadRequest(db: DbClient, clubId: string, requestId: string): Promise<RequestRow | null> {
  const { data } = await db.from("derogation_requests").select(REQUEST_COLUMNS).eq("id", requestId).eq("club_id", clubId).maybeSingle();
  return (data as RequestRow | null) ?? null;
}

export function requestRef(row: RequestRow) {
  return { teamId: row.team_id, createdByUserId: row.created_by_user_id, createdByLicencieId: row.created_by_licencie_id, status: row.status };
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

/** Résumés (liste/inbox) : une requête par table, jamais une par demande. */
export async function buildSummaries(db: DbClient, rows: readonly RequestRow[], actor: Actor, venues: readonly ClubVenueRow[]) {
  if (rows.length === 0) return [];
  const matchIds = [...new Set(rows.map((r) => r.match_id))];
  const requestIds = rows.map((r) => r.id);
  const [{ data: matches }, { data: messages }] = await Promise.all([
    db.from("matches").select(MATCH_COLUMNS).in("id", matchIds),
    db.from("derogation_messages").select("request_id, message_type, author_display_name, body, created_at").in("request_id", requestIds).order("created_at", { ascending: false }),
  ]);
  const matchRows = (matches ?? []) as MatchRow[];
  const labels = await loadMatchLabels(db, matchRows);
  const matchById = new Map(matchRows.map((m) => [m.id, m]));
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const lastByRequest = new Map<string, { message_type: "USER" | "SYSTEM"; author_display_name: string; body: string; created_at: string }>();
  for (const m of messages ?? []) if (!lastByRequest.has(m.request_id)) lastByRequest.set(m.request_id, m);

  return rows.map((row) => {
    const match = matchById.get(row.match_id);
    const venue = row.requested_club_venue_id ? venueById.get(row.requested_club_venue_id) : undefined;
    const last = lastByRequest.get(row.id);
    return {
      id: row.id,
      status: row.status,
      match: match
        ? matchRef(match, labels)
        : { id: row.match_id, numero: null, teamId: row.team_id, teamName: null, categoryLabel: null, opponentName: null, isHome: null, matchDatetime: null, venueName: null, status: "unknown" },
      requesterDisplayName: row.requester_display_name,
      createdByMe: isSameIdentity(actor, row.created_by_user_id, row.created_by_licencie_id),
      originalScheduledAt: row.original_scheduled_at,
      requestedStartAt: row.requested_start_at,
      requestedEndAt: endOf(row.requested_start_at),
      requestedVenue: venue ? { id: venue.id, name: venue.name, address: venue.address } : null,
      isCustomWeekday: row.is_custom_weekday,
      needsCoordinatorAttention: needsCoordinatorAttention(row.status),
      lastMessage: last ? { type: last.message_type, authorDisplayName: last.author_display_name, excerpt: excerpt(last.body), createdAt: last.created_at } : null,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
    };
  });
}

export async function buildDetail(db: DbClient, row: RequestRow, actor: Actor, venues: readonly ClubVenueRow[]) {
  const [summary] = await buildSummaries(db, [row], actor, venues);
  const [{ data: proposals }, { data: messages }, match] = await Promise.all([
    db.from("derogation_proposals").select("id, requested_start_at, requested_club_venue_id, is_custom_weekday, proposed_by_display_name, created_at").eq("request_id", row.id).order("created_at"),
    db.from("derogation_messages").select("id, message_type, event, body, author_display_name, author_role_label, author_user_id, author_licencie_id, created_at").eq("request_id", row.id).order("created_at"),
    loadMatch(db, row.club_id, row.match_id),
  ]);
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const ref = requestRef(row);
  const current = match?.match_datetime ?? null;
  const same = (a: string | null, b: string | null) => a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime();

  return {
    ...summary!,
    proposals: (proposals ?? []).map((p) => {
      const venue = p.requested_club_venue_id ? venueById.get(p.requested_club_venue_id) : undefined;
      return {
        id: p.id,
        requestedStartAt: p.requested_start_at,
        requestedEndAt: endOf(p.requested_start_at),
        venue: venue ? { id: venue.id, name: venue.name, address: venue.address } : null,
        isCustomWeekday: p.is_custom_weekday,
        proposedByDisplayName: p.proposed_by_display_name,
        createdAt: p.created_at,
      };
    }),
    messages: (messages ?? []).map((m) => ({
      id: m.id,
      type: m.message_type,
      event: m.event,
      body: m.body,
      authorDisplayName: m.author_display_name,
      authorRoleLabel: m.author_role_label,
      isMine: isSameIdentity(actor, m.author_user_id, m.author_licencie_id) && m.message_type === "USER",
      createdAt: m.created_at,
    })),
    permissions: {
      canMessage: canReadRequest(actor, ref) && row.status !== "CANCELLED",
      canPropose: canPropose(actor, ref),
      actions: availableActions(actor, ref),
      canSubmitOfficial: canSubmitOfficial(actor, ref),
    },
    officialSchedule: {
      currentScheduledAt: current,
      changedSinceRequest: current !== null && row.original_scheduled_at !== null && !same(current, row.original_scheduled_at),
      matchesCurrentProposal: same(current, row.requested_start_at),
    },
  };
}
