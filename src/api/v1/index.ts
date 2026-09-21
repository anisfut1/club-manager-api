import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { requireAuth } from "@/auth/middleware";
import { clubsRouter } from "@/modules/clubs/routes";
import { matchesRouter } from "@/modules/matches/routes";
import { integrationsRouter } from "@/modules/integrations/routes";
import { jobStatusRouter } from "@/modules/integrations/job-status";
import { documentsRouter } from "@/modules/documents/routes";
import { issuesRouter } from "@/modules/issues/routes";
import { platformRouter } from "@/modules/platform/routes";

/**
 * Toutes les routes destinées au frontend vivent sous `/v1` (§7 de la
 * demande) — jamais les crons/jobs internes, voir src/api/internal/index.ts.
 */
export const v1Router = new Hono<AppEnv>();

v1Router.get("/me", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, email: user.email });
});

v1Router.route("/clubs", clubsRouter);
v1Router.route("/clubs/:clubId/matches", matchesRouter);
v1Router.route("/clubs/:clubId/matches/:matchId/documents", documentsRouter);
v1Router.route("/clubs/:clubId/integrations", integrationsRouter);
v1Router.route("/clubs/:clubId/issues", issuesRouter);
v1Router.route("/jobs", jobStatusRouter);
v1Router.route("/platform", platformRouter);
