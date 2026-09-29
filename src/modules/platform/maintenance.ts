import type { DbClient } from "../../db/client.js";
import { deleteEmarqueFile } from "../../storage/emarque-storage.js";
import { currentSeasonStart } from "../../season.js";
import { logError, logInfo } from "../../logger.js";

export interface PurgeEmarqueDocumentsResult {
  documentsExamined: number;
  documentsPurged: number;
  errors: number;
}

/**
 * Purge RÉTROACTIVE de tous les documents e-Marque encore présents en
 * Storage (retour du club, 2026-09-29 : "je veux juste l'interpréter...
 * pas la stocker" — appliqué aussi à l'existant, pas seulement aux futurs
 * documents traités par `jobs/parse-downloaded-documents.ts`). Idempotente
 * (ne retouche jamais un document déjà `purged_at` non NULL, sûr à
 * relancer). Les stats déjà extraites en base ne sont jamais affectées —
 * seul le fichier original disparaît.
 *
 * `clubId` optionnel : tous les clubs confondus par défaut (route
 * `platform_admin`, même portée que `GET /v1/platform/clubs`).
 */
export async function purgeAllStoredEmarqueDocuments(supabase: DbClient, clubId?: string): Promise<PurgeEmarqueDocumentsResult> {
  const result: PurgeEmarqueDocumentsResult = { documentsExamined: 0, documentsPurged: 0, errors: 0 };

  let builder = supabase.from("match_documents").select("id, storage_path").is("purged_at", null);
  if (clubId) builder = builder.eq("club_id", clubId);

  const { data: docs, error } = await builder;

  if (error) throw new Error(`Recherche des documents e-Marque à purger échouée : ${error.message}`);
  if (!docs || docs.length === 0) return result;

  result.documentsExamined = docs.length;

  for (const doc of docs) {
    try {
      await deleteEmarqueFile(supabase, doc.storage_path);
      await supabase.from("match_documents").update({ purged_at: new Date().toISOString() }).eq("id", doc.id);
      result.documentsPurged += 1;
    } catch (purgeError) {
      result.errors += 1;
      logError("Purge rétroactive d'un document e-Marque échouée", purgeError, { documentId: doc.id });
    }
  }

  logInfo("Purge rétroactive des documents e-Marque terminée", { ...result, clubId: clubId ?? "tous clubs" });
  return result;
}

export interface DeleteOldSeasonsResult {
  matchesDeleted: number;
  seasonStart: string;
}

/**
 * Suppression DÉFINITIVE de tous les matchs d'UN club antérieurs à la
 * saison en cours (retour du club, 2026-09-29 : "tout les matchs des
 * saisons précédentes, faut les supprimer... focus saison 2026-2027").
 * `club_id` TOUJOURS explicite (jamais un défaut "tous les clubs") : la
 * portée la plus dangereuse de cette API ne doit jamais dépendre d'un
 * oubli de paramètre.
 *
 * Cascade FK sur TOUTES les tables liées (composition, stats, officiels,
 * documents, dérogations, jobs, table_assignments — voir les migrations
 * de création de `matches`) : un DELETE unique sur `matches` suffit,
 * jamais un nettoyage table par table. IRRÉVERSIBLE — la confirmation
 * revient à l'appelant (voir la route et son bouton confirmé côté UI).
 * `match_datetime IS NULL` n'est jamais supprimé ici (comparaison SQL
 * `<` toujours fausse sur NULL) : un match sans date connue n'est pas
 * automatiquement considéré comme "ancien".
 */
export async function deleteMatchesBeforeCurrentSeason(supabase: DbClient, clubId: string, now: Date = new Date()): Promise<DeleteOldSeasonsResult> {
  const seasonStartIso = currentSeasonStart(now).toISOString();

  const { count, error: countError } = await supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .lt("match_datetime", seasonStartIso);

  if (countError) throw new Error(`Comptage des matchs des saisons précédentes échoué : ${countError.message}`);

  const matchesDeleted = count ?? 0;
  if (matchesDeleted === 0) return { matchesDeleted: 0, seasonStart: seasonStartIso };

  const { error: deleteError } = await supabase.from("matches").delete().eq("club_id", clubId).lt("match_datetime", seasonStartIso);

  if (deleteError) throw new Error(`Suppression des matchs des saisons précédentes échouée : ${deleteError.message}`);

  logInfo("Suppression des matchs des saisons précédentes terminée", { clubId, matchesDeleted, seasonStart: seasonStartIso });
  return { matchesDeleted, seasonStart: seasonStartIso };
}
