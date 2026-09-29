import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { isClubAdmin } from "../../tenancy/roles.js";
import { badRequest } from "../../api-error.js";
import { loadMatchDocuments } from "./shared.js";

export const documentsRouter = new Hono<AppEnv>();

documentsRouter.use("*", requireAuth);
documentsRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/matches/:matchId/documents — §33/§34 de la demande :
 * la liste est visible par tout membre, mais l'URL de téléchargement
 * (signée, courte durée) n'est incluse QUE pour un club_admin. Voir
 * `./shared.ts#loadMatchDocuments`.
 */
documentsRouter.get("/", async (c) => {
  const { club, roles } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const documents = await loadMatchDocuments(c.get("supabase"), club, matchId, isClubAdmin(roles));
  return c.json({ documents });
});
