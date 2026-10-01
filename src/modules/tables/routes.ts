import { Hono } from "hono";
import { personalLinkUrl, revealOrIssueToken } from "../public-tables/personal-link.js";
import { resolvePublicAppBaseUrl } from "../public-tables/routes.js";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireAnyClubRole, requireClubRole } from "../../auth/middleware.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { badRequest, notFound } from "../../api-error.js";
import { TableSuggestionsQueryDtoSchema, TableAssignmentsQueryDtoSchema, PutTableAssignmentDtoSchema, TableAssignmentRoleSchema, PutRefereeStatusDtoSchema } from "../../contracts/tables.js";
import { computeMatchWindow } from "./match-window.js";
import { DEFAULT_MATCH_DURATION_MINUTES } from "./suggestion-policy.js";
import { computeTableSuggestions, type RankedCandidate, type UnavailableCandidate } from "./table-suggestion-service.js";
import { loadClubDayContext, type ClubDayContext } from "./load-suggestion-data.js";
import { assignTableRole, candidateTeamsDto, findTeamNames, loadHomeMatchOrThrow, loadTableAssignmentsList, removeTableRole } from "./shared.js";

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
 * `requireAnyClubRole`, `auth/middleware.ts`. La logique de conflit/écriture
 * elle-même vit dans `shared.ts`, réutilisée telle quelle par le routeur
 * PUBLIC sans compte (`modules/public-tables/routes.ts`, retour du club,
 * 2026-09-29) — jamais deux implémentations des mêmes règles.
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
 * route qui transforme une suggestion en affectation réelle. Un admin peut
 * toujours remplacer le titulaire actuel (§77 "Modifier") — contrairement
 * au flux public, voir modules/public-tables/routes.ts.
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

  const assignment = await assignTableRole({
    readSupabase: supabase,
    clubId: club.id,
    clubTimezone: club.timezone,
    matchId: match.id,
    matchVenueRawLabel: match.venue_raw_label,
    matchDatetime: match.match_datetime,
    role: role.data,
    licencie: { id: licencie.id, firstName: licencie.first_name, lastName: licencie.last_name, teamId: licencie.team_id },
    createdByUserId: user.id,
  });

  return c.json({ assignment });
});

/** DELETE .../matches/:matchId/table-assignments/:role (§41) — remet le poste "À attribuer". Un admin peut toujours retirer n'importe qui. */
matchTablesRouter.delete("/table-assignments/:role", async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  const roleParam = c.req.param("role");
  if (!matchId || !roleParam) throw badRequest("Paramètres de route manquants.");

  const role = TableAssignmentRoleSchema.safeParse(roleParam);
  if (!role.success) throw badRequest(`Rôle inconnu : ${roleParam}.`);

  await removeTableRole(club.id, matchId, role.data);

  return c.json({ removed: true as const });
});

/**
 * PUT .../matches/:matchId/referee-status — retour du club, 2026-09-28 :
 * "il est possible qu'un arbitre officiel soit désigné, donc avoir la
 * possibilité de cocher un truc style pas besoin d'arbitre". N'affecte
 * JAMAIS `table_assignments` (aucun licencié impliqué) — écrit/efface une
 * ligne dans `match_referee_overrides`, table dédiée à cette seule bascule.
 * Refusé sur un match extérieur, même raisonnement que les affectations.
 * Réservé à l'admin (jamais exposé au flux public).
 */
matchTablesRouter.put("/referee-status", async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const body = PutRefereeStatusDtoSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));

  await loadHomeMatchOrThrow(supabase, club.id, matchId);

  const serviceSupabase = createServiceSupabaseClient();

  if (body.data.noRefereeNeeded) {
    const { error } = await serviceSupabase
      .from("match_referee_overrides")
      .upsert({ club_id: club.id, match_id: matchId, no_referee_needed: true, created_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "club_id,match_id" });
    if (error) throw new Error(`Enregistrement du statut arbitre échoué : ${error.message}`);
  } else {
    // Absence de ligne = état par défaut ("un arbitre du club est nécessaire") — jamais une ligne à `false` (voir commentaire de la migration).
    const { error } = await serviceSupabase.from("match_referee_overrides").delete().eq("club_id", club.id).eq("match_id", matchId);
    if (error) throw new Error(`Suppression du statut arbitre échouée : ${error.message}`);
  }

  return c.json({ refereeNotNeeded: body.data.noRefereeNeeded });
});

/**
 * GET /v1/clubs/:clubId/table-assignments?from=&to= (§36) — matchs à
 * DOMICILE uniquement (§4 : un match extérieur n'apparaît jamais ici).
 */
tableAssignmentsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const query = TableAssignmentsQueryDtoSchema.safeParse(c.req.query());
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  const responseMatches = await loadTableAssignmentsList({ supabase, clubId: club.id, clubTimezone: club.timezone, from: query.data.from, to: query.data.to });

  return c.json({ matches: responseMatches });
});

/**
 * GET .../table-assignments/public-access — retour du club, 2026-09-29 :
 * vue admin de qui a déjà revendiqué son lien personnel sans compte
 * (`claimed`/`email`/`claimedAt`) pour savoir qui réinitialiser en cas de
 * lien perdu. `club_admin` uniquement (gestion d'accès/identité, plus
 * sensible que la simple gestion des postes — jamais responsable_tables).
 */
tableAssignmentsRouter.get("/public-access", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const [{ data: licencies }, { data: claims }] = await Promise.all([
    supabase.from("licencies").select("id, first_name, last_name").eq("club_id", club.id).eq("active", true).order("last_name").order("first_name"),
    supabase.from("licencie_public_tokens").select("licencie_id, email, created_at").eq("club_id", club.id).is("revoked_at", null),
  ]);

  const claimByLicencieId = new Map((claims ?? []).map((row) => [row.licencie_id, row]));

  const entries = (licencies ?? []).map((l) => {
    const claim = claimByLicencieId.get(l.id);
    return {
      licencie: { id: l.id, firstName: l.first_name, lastName: l.last_name },
      claimed: claim !== undefined,
      email: claim?.email ?? null,
      claimedAt: claim?.created_at ?? null,
    };
  });

  return c.json({ entries });
});

/**
 * POST .../table-assignments/public-access/:licencieId/link — retour du club,
 * 2026-10-01 : « l'admin doit avoir accès au lien unique par joueur au cas où
 * il a besoin de l'envoyer ». `club_admin` uniquement. Réaffiche le lien
 * ACTIF (inchangé, toujours valable) ; s'il n'y en a pas (ou s'il date
 * d'avant le chiffrement), en émet un nouveau — `created: true`.
 */
tableAssignmentsRouter.post("/public-access/:licencieId/link", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const serviceSupabase = createServiceSupabaseClient();
  const { data: licencie } = await serviceSupabase.from("licencies").select("id, email").eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!licencie) throw notFound("Licencié introuvable pour ce club.");

  const { token, created } = await revealOrIssueToken(serviceSupabase, { clubId: club.id, licencieId, email: licencie.email ?? null, adminUserId: user.id });
  // Ouvre l'accueil personnel (agenda de ses équipes, tables, dérogations selon ses rôles).
  return c.json({ link: personalLinkUrl(resolvePublicAppBaseUrl(c.req.header("origin")), club.slug, "accueil", token), created });
});

/**
 * POST .../table-assignments/public-access/:licencieId/reset — retour du
 * club : "sinon faut faire une demande admin" / "une fois qu'un nom est
 * choisi, il peut plus être choisi sauf si admin remet à reset son
 * profil". Révoque le jeton actif (le nom redevient choisissable) — ne
 * touche JAMAIS aux affectations déjà existantes de ce licencié (elles
 * restent, seul le lien d'accès change, voir docs/PUBLIC_TABLE_ACCESS.md).
 */
tableAssignmentsRouter.post("/public-access/:licencieId/reset", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const { data: licencie } = await supabase.from("licencies").select("id").eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!licencie) throw notFound("Licencié introuvable pour ce club.");

  const serviceSupabase = createServiceSupabaseClient();
  const { error } = await serviceSupabase
    .from("licencie_public_tokens")
    .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
    .eq("club_id", club.id)
    .eq("licencie_id", licencieId)
    .is("revoked_at", null);

  if (error) throw new Error(`Réinitialisation de l'accès public échouée : ${error.message}`);

  return c.json({ reset: true as const });
});
