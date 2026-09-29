import type { DbClient } from "../../db/client.js";
import { deleteEmarqueFile } from "../../storage/emarque-storage.js";
import { currentSeasonStart } from "../../season.js";
import { logError, logInfo } from "../../logger.js";

/** Tables écrites par `persistEmarqueMatchData` (voir son nettoyage en cas d'erreur) — reprises ici pour nettoyer aussi les données PARTIELLES laissées par un import antérieur à ce correctif. */
const EMARQUE_PERSISTED_TABLES = ["match_participants", "match_coaches", "match_officials", "match_table_officials", "player_match_stats"] as const;

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

export interface RetryFailedEmarqueImportsResult {
  matchesExamined: number;
  matchesRetried: number;
  matchesSkippedNoFile: number;
}

/**
 * Relance le PARSING d'un match e-Marque resté en `error` (retour du club,
 * 2026-09-29 : "faut que ce soit fait sur tous les matchs, sans bug, sans
 * interruption" — aucun mécanisme de nouvelle tentative n'existait avant ce
 * correctif, un match en `error` restait bloqué indéfiniment, exclu du cron
 * `discover_emarque` qui ne reprend que `pending`/`waiting_for_emarque`).
 *
 * Ne couvre QUE `emarque_status = 'error'` — jamais `needs_review` : ce
 * dernier correspond à un import qui a RÉUSSI (voir `statusFromWarnings`,
 * `persist-emarque-match.ts`) et dont le fichier original a donc déjà été
 * purgé par `purgeDocument` (jobs/parse-downloaded-documents.ts, purge sur
 * le chemin de succès). Relancer un `needs_review` nécessiterait un nouveau
 * téléchargement FBI (`discover_emarque`), hors du périmètre de cette
 * fonction qui réutilise volontairement le fichier déjà en Storage.
 *
 * Pour chaque match `error` :
 * 1. Nettoie les données PARTIELLES déjà en base (participants/stats/
 *    coachs/officiels — voir `EMARQUE_PERSISTED_TABLES`). Nécessaire même
 *    après le correctif de rollback dans `persistEmarqueMatchData` : ce
 *    nettoyage-ci couvre les imports en erreur persistés AVANT ce correctif.
 * 2. Supprime la ligne `emarque_imports` correspondante — la contrainte
 *    UNIQUE `(club_id, file_hash)` ferait sinon revenir `alreadyImported:
 *    true` sans rien retraiter (voir `persistEmarqueMatchData`).
 * 3. Repasse `match_documents.status` de `'error'` à `'downloaded'` — le
 *    prochain passage de `parseDownloadedEmarqueDocuments` (cron ou route)
 *    reprend alors ce document tel quel, SANS nouveau téléchargement FBI.
 *    Ignoré si le document a déjà été purgé (`purged_at` non NULL) : le
 *    fichier n'existe alors plus en Storage, rien à reparser (compté dans
 *    `matchesSkippedNoFile`).
 * 4. Repasse `matches.emarque_status` à `'downloaded'` (reflète l'état réel
 *    du document, jamais un `'pending'` qui suggérerait à tort qu'aucun
 *    fichier n'a encore été téléchargé).
 *
 * `clubId` optionnel : tous les clubs confondus par défaut, même portée que
 * `purgeAllStoredEmarqueDocuments`.
 */
export async function retryFailedEmarqueImports(supabase: DbClient, clubId?: string): Promise<RetryFailedEmarqueImportsResult> {
  const result: RetryFailedEmarqueImportsResult = { matchesExamined: 0, matchesRetried: 0, matchesSkippedNoFile: 0 };

  let matchesBuilder = supabase.from("matches").select("id, club_id").eq("emarque_status", "error");
  if (clubId) matchesBuilder = matchesBuilder.eq("club_id", clubId);

  const { data: failedMatches, error: matchesError } = await matchesBuilder;

  if (matchesError) throw new Error(`Recherche des matchs e-Marque en erreur échouée : ${matchesError.message}`);
  if (!failedMatches || failedMatches.length === 0) return result;

  result.matchesExamined = failedMatches.length;

  for (const match of failedMatches) {
    try {
      const { data: doc, error: docError } = await supabase
        .from("match_documents")
        .select("id, purged_at")
        .eq("match_id", match.id)
        .eq("type", "emarque_zip")
        .eq("status", "error")
        .maybeSingle();

      if (docError) throw new Error(`Recherche du document e-Marque en erreur échouée : ${docError.message}`);

      if (!doc || doc.purged_at !== null) {
        // Fichier déjà purgé (ou jamais retrouvé) : impossible de reparser
        // sans nouveau téléchargement FBI, hors périmètre ici (voir la doc
        // de cette fonction). On laisse ce match tel quel plutôt que de le
        // faire échouer.
        result.matchesSkippedNoFile += 1;
        continue;
      }

      await Promise.all(EMARQUE_PERSISTED_TABLES.map((table) => supabase.from(table).delete().eq("match_id", match.id).eq("club_id", match.club_id)));

      const { error: deleteImportError } = await supabase.from("emarque_imports").delete().eq("match_id", match.id).eq("club_id", match.club_id);
      if (deleteImportError) throw new Error(`Suppression de l'import e-Marque en erreur échouée : ${deleteImportError.message}`);

      const { error: docUpdateError } = await supabase
        .from("match_documents")
        .update({ status: "downloaded", last_error: null, updated_at: new Date().toISOString() })
        .eq("id", doc.id);
      if (docUpdateError) throw new Error(`Réinitialisation du document e-Marque échouée : ${docUpdateError.message}`);

      const { error: matchUpdateError } = await supabase.from("matches").update({ emarque_status: "downloaded" }).eq("id", match.id);
      if (matchUpdateError) throw new Error(`Réinitialisation du statut e-Marque du match échouée : ${matchUpdateError.message}`);

      result.matchesRetried += 1;
    } catch (retryError) {
      logError("Nouvelle tentative d'import e-Marque échouée", retryError, { matchId: match.id, clubId: match.club_id });
    }
  }

  logInfo("Nouvelle tentative des imports e-Marque en erreur terminée", { ...result, clubId: clubId ?? "tous clubs" });
  return result;
}
