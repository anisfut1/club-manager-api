import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { requireAuth, requireClubMembership } from "@/auth/middleware";
import { isClubAdmin } from "@/tenancy/roles";
import { createServiceSupabaseClient } from "@/db/client";
import { badRequest } from "@/api-error";
import { createEmarqueSignedUrl } from "@/storage/emarque-storage";
import type { MatchDocumentDto } from "@/contracts/documents";

export const documentsRouter = new Hono<AppEnv>();

documentsRouter.use("*", requireAuth);
documentsRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/matches/:matchId/documents — §33/§34 de la demande :
 * la liste est visible par tout membre, mais l'URL de téléchargement
 * (signée, courte durée) n'est incluse QUE pour un club_admin.
 */
documentsRouter.get("/", async (c) => {
  const { club, roles } = c.get("club");
  const supabase = c.get("supabase");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");
  const canDownload = isClubAdmin(roles);

  const { data, error } = await supabase
    .from("match_documents")
    .select("id, type, filename, mime_type, status, discovered_at, downloaded_at, storage_path")
    .eq("match_id", matchId)
    .eq("club_id", club.id)
    .order("downloaded_at", { ascending: false });

  if (error) throw new Error(`Lecture des documents échouée : ${error.message}`);

  // Le bucket `emarque` est privé, sans policy Storage pour `authenticated`
  // (voir docs/EMARQUE.md) : une URL signée ne peut être générée qu'avec le
  // client service role — MAIS seulement après avoir vérifié le rôle via LA
  // RLS ci-dessus (`club.roles`), jamais en se fiant à `clubId` seul (§9 de
  // la demande).
  const serviceSupabase = canDownload ? createServiceSupabaseClient() : null;

  const documents: MatchDocumentDto[] = await Promise.all(
    (data ?? []).map(async (doc) => ({
      id: doc.id,
      type: doc.type,
      filename: doc.filename,
      mimeType: doc.mime_type,
      status: doc.status,
      discoveredAt: doc.discovered_at,
      downloadedAt: doc.downloaded_at,
      downloadUrl: serviceSupabase ? await createEmarqueSignedUrl(serviceSupabase, doc.storage_path) : null,
    })),
  );

  return c.json({ documents });
});
