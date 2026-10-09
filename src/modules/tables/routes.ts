import { Hono } from "hono";
import { personalLinkUrl, revealOrIssueToken } from "../public-tables/personal-link.js";
import { issuePersonalLink, resolvePublicAppBaseUrl } from "../public-tables/routes.js";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireAnyClubRole, requireClubRole } from "../../auth/middleware.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { TableSuggestionsQueryDtoSchema, TableAssignmentsQueryDtoSchema, PutTableAssignmentDtoSchema, TableAssignmentRoleSchema, PutRefereeStatusDtoSchema } from "../../contracts/tables.js";
import { assignTableRole, buildTableSuggestions, loadHomeMatchOrThrow, loadTableAssignmentsList, removeTableRole, setRefereeNotNeeded } from "./shared.js";

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

  return c.json(await buildTableSuggestions(supabase, { id: club.id, timezone: club.timezone }, matchId, query.data.role));
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
    allowMatchConflict: body.data.ignoreMatchConflict === true,
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

  await setRefereeNotNeeded(club.id, matchId, body.data.noRefereeNeeded, user.id);

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
 * GET .../table-assignments/public-access/claims — demandes de lien pour une
 * fiche sans adresse (retour du club, 2026-10-08 : « si ce n'est pas son
 * mail, c'est l'admin qui décide »). En attente et non expirées seulement.
 */
tableAssignmentsRouter.get("/public-access/claims", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const db = createServiceSupabaseClient();
  const { data: rows } = await db.from("licencie_claim_requests").select("id, licencie_id, requested_email, created_at, expires_at").eq("club_id", club.id).eq("status", "pending");
  const now = new Date().toISOString();
  const pending = (rows ?? []).filter((r) => r.expires_at > now);
  const ids = [...new Set(pending.map((r) => r.licencie_id))];
  const { data: licencies } = ids.length ? await db.from("licencies").select("id, first_name, last_name").eq("club_id", club.id).in("id", ids) : { data: [] as { id: string; first_name: string; last_name: string }[] };
  const byId = new Map((licencies ?? []).map((l) => [l.id, l]));
  const requests = pending
    .filter((r) => byId.has(r.licencie_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((r) => {
      const l = byId.get(r.licencie_id)!;
      return { id: r.id, licencie: { id: l.id, firstName: l.first_name, lastName: l.last_name }, requestedEmail: r.requested_email, createdAt: r.created_at, expiresAt: r.expires_at };
    });
  return c.json({ requests });
});

async function pendingClaimOrThrow(db: ReturnType<typeof createServiceSupabaseClient>, clubId: string, requestId: string | undefined) {
  if (!requestId) throw badRequest("Paramètre de route :requestId manquant.");
  const { data: claim } = await db.from("licencie_claim_requests").select("id, licencie_id, requested_email, return_to, status, expires_at").eq("id", requestId).eq("club_id", clubId).maybeSingle();
  if (!claim) throw notFound("Demande introuvable.");
  if (claim.status !== "pending") throw conflict("Cette demande a déjà été traitée.", "ALREADY_DECIDED");
  if (claim.expires_at <= new Date().toISOString()) throw conflict("Cette demande a expiré (14 jours sans réponse).", "EXPIRED");
  return claim;
}

/** POST .../public-access/claims/:requestId/approve — envoie le lien à l'adresse demandée et l'enregistre sur la fiche. */
tableAssignmentsRouter.post("/public-access/claims/:requestId/approve", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const db = createServiceSupabaseClient();
  const claim = await pendingClaimOrThrow(db, club.id, c.req.param("requestId"));
  if (!claim.requested_email) throw conflict("Cette demande n'a pas d'adresse.", "NO_EMAIL");

  const { data: licencie } = await db.from("licencies").select("id, first_name, email").eq("id", claim.licencie_id).eq("club_id", club.id).maybeSingle();
  if (!licencie) throw notFound("Licencié introuvable pour ce club.");

  await issuePersonalLink(db, {
    club: { id: club.id, slug: club.slug, name: club.name, logoUrl: club.logoUrl ?? null, accentColor: club.accentColor ?? null },
    licencie: { id: licencie.id, first_name: licencie.first_name, email: licencie.email ?? null },
    targetEmail: claim.requested_email,
    returnTo: claim.return_to,
    baseUrl: resolvePublicAppBaseUrl(c.req.header("origin")),
  });
  // Adresse validée par l'admin : elle devient celle de la fiche.
  await db.from("licencies").update({ email: claim.requested_email }).eq("id", licencie.id).eq("club_id", club.id);
  await db.from("licencie_claim_requests").update({ status: "approved", decided_by: user.id, decided_at: new Date().toISOString(), requested_email: null }).eq("id", claim.id);
  return c.json({ approved: true as const });
});

/** POST .../public-access/claims/:requestId/reject — rien n'est envoyé, l'adresse saisie est effacée. */
tableAssignmentsRouter.post("/public-access/claims/:requestId/reject", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const db = createServiceSupabaseClient();
  const claim = await pendingClaimOrThrow(db, club.id, c.req.param("requestId"));
  await db.from("licencie_claim_requests").update({ status: "rejected", decided_by: user.id, decided_at: new Date().toISOString(), requested_email: null }).eq("id", claim.id);
  return c.json({ rejected: true as const });
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
