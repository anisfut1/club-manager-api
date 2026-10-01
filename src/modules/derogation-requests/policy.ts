import type { ClubRole } from "../../db/types.js";

/**
 * Permissions et machine d'état des demandes de dérogation internes — PURES,
 * testées sans Supabase. Réutilisent le RBAC existant (`membership_roles`) :
 *  - `coach` (portée `scope_team_id`, NULL = toutes les équipes du club) :
 *    crée/suit les demandes des équipes qu'il encadre ;
 *  - `correspondant_club` = le COORDINATEUR (libellé UI) : reçoit et traite
 *    toutes les demandes du club ;
 *  - `club_admin` : mêmes droits que le coordinateur + création.
 *
 * L'acteur est soit un COMPTE (`userId`, espace club), soit un LICENCIÉ
 * reconnu par son lien personnel (`licencieId`, espace public sans compte —
 * drapeaux `licencies.public_coach` / `public_coordinator` / `public_admin`
 * traduits en rôles, voir service.ts `loadLicencieActor`).
 */

export type DerogationRequestStatus = "REQUESTED" | "IN_PROGRESS" | "NEEDS_CHANGE" | "COMPLETED" | "CANCELLED";
export type DerogationAction = "TAKE_IN_CHARGE" | "REQUEST_CHANGE" | "COMPLETE" | "CANCEL";

export const ACTIVE_STATUSES: readonly DerogationRequestStatus[] = ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"];
export const COORDINATOR_ROLE: ClubRole = "correspondant_club";

export interface RoleGrant {
  role: ClubRole;
  scopeTeamId: string | null;
}

export interface Actor {
  userId: string | null;
  licencieId: string | null;
  roles: readonly RoleGrant[];
}

export function isCoordinator(actor: Actor): boolean {
  return actor.roles.some((r) => r.role === COORDINATOR_ROLE);
}

export function isClubAdminActor(actor: Actor): boolean {
  return actor.roles.some((r) => r.role === "club_admin");
}

/** Traite les demandes (inbox, actions coordinateur). */
export function canManageRequests(actor: Actor): boolean {
  return isCoordinator(actor) || isClubAdminActor(actor);
}

/** Équipes encadrées : "ALL" si un rôle coach à portée club entière existe. */
export function coachedTeams(actor: Actor): "ALL" | Set<string> {
  const grants = actor.roles.filter((r) => r.role === "coach");
  if (grants.some((g) => g.scopeTeamId === null)) return "ALL";
  return new Set(grants.map((g) => g.scopeTeamId).filter((id): id is string => id !== null));
}

export function coachesTeam(actor: Actor, teamId: string | null): boolean {
  const teams = coachedTeams(actor);
  if (teams === "ALL") return true;
  return teamId !== null && teams.has(teamId);
}

/** Peut créer au moins une demande (club_admin, ou coach d'au moins une équipe). */
export function canCreateAny(actor: Actor): boolean {
  const teams = coachedTeams(actor);
  return isClubAdminActor(actor) || teams === "ALL" || teams.size > 0;
}

/** Créer une demande pour un match de cette équipe. */
export function canCreateForTeam(actor: Actor, teamId: string | null): boolean {
  return isClubAdminActor(actor) || coachesTeam(actor, teamId);
}

export interface RequestRef {
  teamId: string | null;
  createdByUserId: string | null;
  createdByLicencieId: string | null;
  status: DerogationRequestStatus;
}

/** Même identité (compte OU licencié) — jamais `null === null`. */
export function isSameIdentity(actor: Actor, userId: string | null, licencieId: string | null): boolean {
  return (actor.userId !== null && actor.userId === userId) || (actor.licencieId !== null && actor.licencieId === licencieId);
}

export function isAuthor(actor: Actor, request: RequestRef): boolean {
  return isSameIdentity(actor, request.createdByUserId, request.createdByLicencieId);
}

/** Même règle que la fonction SQL `can_read_derogation_request` (RLS). */
export function canReadRequest(actor: Actor, request: RequestRef): boolean {
  return canManageRequests(actor) || isAuthor(actor, request) || coachesTeam(actor, request.teamId);
}

/** Côté coach : auteur ou coach de l'équipe. */
export function isRequesterSide(actor: Actor, request: RequestRef): boolean {
  return isAuthor(actor, request) || coachesTeam(actor, request.teamId);
}

export function isActiveStatus(status: DerogationRequestStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** Transitions autorisées (`from` → `to`) par action. */
const TRANSITIONS: Record<DerogationAction, { from: readonly DerogationRequestStatus[]; to: DerogationRequestStatus }> = {
  TAKE_IN_CHARGE: { from: ["REQUESTED", "NEEDS_CHANGE"], to: "IN_PROGRESS" },
  REQUEST_CHANGE: { from: ["REQUESTED", "IN_PROGRESS"], to: "NEEDS_CHANGE" },
  COMPLETE: { from: ["IN_PROGRESS"], to: "COMPLETED" },
  CANCEL: { from: ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"], to: "CANCELLED" },
};

export function nextStatus(action: DerogationAction, from: DerogationRequestStatus): DerogationRequestStatus | null {
  const rule = TRANSITIONS[action];
  return rule.from.includes(from) ? rule.to : null;
}

/** Qui peut déclencher l'action (indépendamment du statut). */
export function canPerformAction(actor: Actor, request: RequestRef, action: DerogationAction): boolean {
  if (action === "CANCEL") return canManageRequests(actor) || isRequesterSide(actor, request);
  return canManageRequests(actor);
}

/** Nouvelle proposition de créneau : côté demandeur, tant que la demande est ouverte côté coach. */
export function canPropose(actor: Actor, request: RequestRef): boolean {
  return (isRequesterSide(actor, request) || isClubAdminActor(actor)) && (request.status === "REQUESTED" || request.status === "NEEDS_CHANGE");
}

/** Envoi de la dérogation OFFICIELLE (FBI) : coordinateur/admin, une fois la demande prise en charge. */
export function canSubmitOfficial(actor: Actor, request: RequestRef): boolean {
  return canManageRequests(actor) && request.status === "IN_PROGRESS";
}

/** Actions proposées dans l'UI pour CET utilisateur et CE statut. */
export function availableActions(actor: Actor, request: RequestRef): DerogationAction[] {
  return (Object.keys(TRANSITIONS) as DerogationAction[]).filter((action) => nextStatus(action, request.status) !== null && canPerformAction(actor, request, action));
}

/** Libellé de rôle affiché dans la conversation. */
export function roleLabelFor(actor: Actor, request: RequestRef): string {
  if (isRequesterSide(actor, request) && !canManageRequests(actor)) return "Coach";
  if (isCoordinator(actor)) return "Coordinateur";
  if (isClubAdminActor(actor)) return "Administrateur";
  return "Coach";
}

/** "Attention requise" côté coordinateur : demande envoyée/reproposée, pas encore prise en charge. */
export function needsCoordinatorAttention(status: DerogationRequestStatus): boolean {
  return status === "REQUESTED";
}
