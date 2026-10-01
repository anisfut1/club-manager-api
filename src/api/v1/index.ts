import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth } from "../../auth/middleware.js";
import { clubsRouter } from "../../modules/clubs/routes.js";
import { matchesRouter } from "../../modules/matches/routes.js";
import { integrationsRouter } from "../../modules/integrations/routes.js";
import { jobStatusRouter } from "../../modules/integrations/job-status.js";
import { documentsRouter } from "../../modules/documents/routes.js";
import { issuesRouter } from "../../modules/issues/routes.js";
import { derogationsRouter } from "../../modules/derogations/routes.js";
import { emarqueImportsRouter } from "../../modules/emarque/routes.js";
import { licenciesRouter } from "../../modules/licencies/routes.js";
import { platformRouter } from "../../modules/platform/routes.js";
import { tableAssignmentsRouter, matchTablesRouter } from "../../modules/tables/routes.js";
import { publicTablesRouter } from "../../modules/public-tables/routes.js";
import { derogationAvailabilityRouter, derogationRequestsRouter } from "../../modules/derogation-requests/routes.js";
import { membersRouter } from "../../modules/members/routes.js";
import { clubVenuesRouter } from "../../modules/club-venues/routes.js";
import { standingsRouter } from "../../modules/standings/routes.js";
import { publicMatchesRouter } from "../../modules/public-matches/routes.js";
import type { MeDto } from "../../contracts/me.js";

/**
 * Toutes les routes destinées au frontend vivent sous `/v1` (§7 de la
 * demande) — jamais les crons/jobs internes, voir src/api/internal/index.ts.
 */
export const v1Router = new Hono<AppEnv>();

/**
 * GET /v1/me (gap 3/§24 de la demande) — identité de session : `displayName`
 * (repli sur `null` si `profiles.display_name` n'est pas renseigné, jamais
 * une identité inventée) et `isPlatformAdmin` (même RPC que la RLS,
 * évite un aller-retour dédié). Jamais la liste des clubs ici — voir
 * `GET /v1/clubs`, payload déjà dédié.
 */
v1Router.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const supabase = c.get("supabase");

  const [{ data: profile }, { data: isPlatformAdmin }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("user_id", user.id).maybeSingle(),
    supabase.rpc("is_platform_admin"),
  ]);

  const dto: MeDto = {
    id: user.id,
    email: user.email,
    displayName: profile?.display_name ?? null,
    isPlatformAdmin: isPlatformAdmin ?? false,
  };

  return c.json(dto);
});

v1Router.route("/clubs", clubsRouter);
v1Router.route("/clubs/:clubId/matches", matchesRouter);
v1Router.route("/clubs/:clubId/matches/:matchId/documents", documentsRouter);
// Avant matchTablesRouter (même préfixe) : voir derogation-requests/routes.ts.
v1Router.route("/clubs/:clubId/matches/:matchId", derogationAvailabilityRouter);
v1Router.route("/clubs/:clubId/matches/:matchId", matchTablesRouter);
v1Router.route("/clubs/:clubId/table-assignments", tableAssignmentsRouter);
v1Router.route("/public/clubs/:clubSlug", publicTablesRouter);
v1Router.route("/public/clubs/:clubSlug", publicMatchesRouter);
v1Router.route("/clubs/:clubId/integrations", integrationsRouter);
v1Router.route("/clubs/:clubId/issues", issuesRouter);
v1Router.route("/clubs/:clubId/derogations", derogationsRouter);
v1Router.route("/clubs/:clubId/emarque-imports", emarqueImportsRouter);
v1Router.route("/clubs/:clubId/licencies", licenciesRouter);
v1Router.route("/clubs/:clubId/standings", standingsRouter);
v1Router.route("/clubs/:clubId/derogation-requests", derogationRequestsRouter);
v1Router.route("/clubs/:clubId/members", membersRouter);
v1Router.route("/clubs/:clubId/venues", clubVenuesRouter);
v1Router.route("/jobs", jobStatusRouter);
v1Router.route("/platform", platformRouter);
