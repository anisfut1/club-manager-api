import type { DbClient } from "../../db/client.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { createEmarqueSignedUrl } from "../../storage/emarque-storage.js";
import type { MatchDocumentDto } from "../../contracts/documents.js";

/**
 * §33/§34 de la demande : la liste des documents e-Marque est visible par
 * tout membre, mais l'URL de téléchargement (signée, courte durée) n'est
 * incluse QUE pour un club_admin. Extrait pour être réutilisé
 * IDENTIQUEMENT par le routeur public sans compte (`public-matches/routes.ts`,
 * retour du club, 2026-09-29) — qui appelle toujours avec `canDownload:
 * false` (jamais de génération d'URL signée pour un visiteur anonyme).
 */
export async function loadMatchDocuments(supabase: DbClient, club: { id: string }, matchId: string, canDownload: boolean): Promise<MatchDocumentDto[]> {
  const { data, error } = await supabase
    .from("match_documents")
    .select("id, type, filename, mime_type, status, discovered_at, downloaded_at, storage_path")
    .eq("match_id", matchId)
    .eq("club_id", club.id)
    .order("downloaded_at", { ascending: false });

  if (error) throw new Error(`Lecture des documents échouée : ${error.message}`);

  // Le bucket `emarque` est privé, sans policy Storage pour `authenticated`
  // (voir docs/EMARQUE.md) : une URL signée ne peut être générée qu'avec le
  // client service role — MAIS seulement après avoir vérifié le rôle
  // (`canDownload`), jamais en se fiant à `clubId` seul (§9 de la demande).
  const serviceSupabase = canDownload ? createServiceSupabaseClient() : null;

  return Promise.all(
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
}
