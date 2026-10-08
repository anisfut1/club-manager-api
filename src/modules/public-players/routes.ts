import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { badRequest, notFound } from "../../api-error.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { loadPublicPlayerProfile } from "./shared.js";

/**
 * Fiche joueur PUBLIQUE, sans compte, lecture seule (retour du club,
 * 2026-10-08). Monté à `/v1/public/clubs/:clubSlug/players` (voir
 * src/api/v1/index.ts). Uniquement des `GET`.
 */
interface PublicPlayersEnv {
  Variables: {
    supabase: DbClient;
    publicClub: PublicClub;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const publicPlayersRouter = new Hono<PublicPlayersEnv>();

publicPlayersRouter.use("*", resolvePublicClub<PublicPlayersEnv>());

/** GET /v1/public/clubs/:clubSlug/players/:licencieId */
publicPlayersRouter.get("/:licencieId", async (c) => {
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");
  if (!UUID.test(licencieId)) throw notFound("Joueur introuvable.");
  return c.json(await loadPublicPlayerProfile(c.get("supabase"), c.get("publicClub").id, licencieId));
});
