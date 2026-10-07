import type { DbClient } from "../db/client.js";
import { deleteEmarqueFile, downloadEmarqueFile } from "../storage/emarque-storage.js";
import { parseEmarqueZip, PARSER_VERSION } from "../integrations/emarque/parser/parse-emarque-zip.js";
import { persistEmarqueMatchData } from "../integrations/emarque/persist/persist-emarque-match.js";
import { logError, logInfo } from "../logger.js";
import { currentSeasonStart } from "../season.js";

/**
 * Conservation des feuilles e-Marque : 30 jours après leur téléchargement,
 * puis suppression automatique (retour du club, 2026-10-06 : "oui on peut,
 * mais faut pas que ça surcharge le serveur" — une feuille pèse 1 à 2 Mo).
 * Les garder permet de relire un match (parseur corrigé, relance) SANS
 * retourner sur FBI. Remplace la purge immédiate après lecture.
 */
export const EMARQUE_DOCUMENT_RETENTION_DAYS = 30;

/** Supprime (Storage + `purged_at`) les feuilles lues depuis plus de 30 jours — par petits lots, jamais en masse. */
export async function purgeExpiredEmarqueDocuments(supabase: DbClient, now: Date = new Date(), limit = 20): Promise<number> {
  const cutoff = new Date(now.getTime() - EMARQUE_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: expired, error } = await supabase
    .from("match_documents")
    .select("id, storage_path")
    .is("purged_at", null)
    .in("status", ["imported", "error"])
    .lt("downloaded_at", cutoff)
    .limit(limit);
  if (error) throw new Error(`Recherche des feuilles e-Marque expirées échouée : ${error.message}`);

  let purged = 0;
  for (const doc of expired ?? []) {
    try {
      await deleteEmarqueFile(supabase, doc.storage_path);
      await supabase.from("match_documents").update({ purged_at: now.toISOString() }).eq("id", doc.id);
      purged += 1;
    } catch (purgeError) {
      logError("Suppression d'une feuille e-Marque expirée échouée (réessayée au prochain passage)", purgeError, { documentId: doc.id });
    }
  }
  return purged;
}

/**
 * Relit automatiquement, depuis la feuille CONSERVÉE (jamais FBI), les
 * matchs de la saison en cours lus par une version plus ancienne du
 * parseur — au plus `limit` par passage pour ne jamais surcharger.
 */
export async function requeueOutdatedEmarqueParses(supabase: DbClient, limit = 2): Promise<number> {
  const { data: docs, error } = await supabase
    .from("match_documents")
    .select("id, match_id")
    .eq("type", "emarque_zip")
    .eq("status", "imported")
    .is("purged_at", null);
  if (error) throw new Error(`Recherche des feuilles e-Marque conservées échouée : ${error.message}`);
  if (!docs || docs.length === 0) return 0;

  const matchIds = [...new Set(docs.map((d) => d.match_id))];
  const [{ data: seasonMatches }, { data: imports }] = await Promise.all([
    supabase.from("matches").select("id").in("id", matchIds).gte("match_datetime", currentSeasonStart().toISOString()),
    supabase.from("emarque_imports").select("match_id, parser_version, created_at").in("match_id", matchIds),
  ]);
  const inSeason = new Set((seasonMatches ?? []).map((m) => m.id));
  const latestVersion = new Map<string, { version: string | null; createdAt: string }>();
  for (const row of imports ?? []) {
    const current = latestVersion.get(row.match_id);
    if (!current || current.createdAt < row.created_at) latestVersion.set(row.match_id, { version: row.parser_version, createdAt: row.created_at });
  }

  const outdated = docs.filter((d) => inSeason.has(d.match_id) && latestVersion.get(d.match_id)?.version !== PARSER_VERSION).slice(0, limit);
  for (const doc of outdated) {
    await supabase.from("match_documents").update({ status: "downloaded", updated_at: new Date().toISOString() }).eq("id", doc.id);
  }
  if (outdated.length > 0) logInfo("Relecture automatique de feuilles e-Marque conservées (parseur plus récent)", { count: outdated.length, parserVersion: PARSER_VERSION });
  return outdated.length;
}

export interface ParseDownloadedDocumentsResult {
  candidatesExamined: number;
  imported: number;
  errors: number;
}

/**
 * Étape PARSING du pipeline e-Marque — volontairement séparée du job
 * `discover_emarque` (Playwright) : ce module ne touche jamais un
 * navigateur, réutilise TEL QUEL le pipeline OCR/PDF déjà construit et
 * testé (src/integrations/emarque/**), et peut donc tourner dans une
 * invocation Vercel Function légère et rapide (`/internal/cron/emarque-parse`).
 *
 * Ne regarde QUE `type = 'emarque_zip'` : les documents séparés
 * (match_sheet/summary/shot_chart) sont déjà utilisables tels quels par
 * l'API (téléchargement direct via URL signée) et n'ont pas de parseur
 * dédié pour l'instant.
 *
 * `options.clubId`/`options.limit` (voir docs/FBI.md "Dixième déclenchement")
 * : le cron (`/internal/cron/emarque-parse`) les laisse vides — tout
 * traiter, tous clubs confondus, un run par jour. `POST .../fbi/parse-
 * documents` (route club-scoped) les fournit TOUJOURS : jamais parser les
 * documents d'un autre club depuis une route `/v1/clubs/:clubId/*`, et un
 * plafond pour rester sous `maxDuration: 300` même si beaucoup de documents
 * attendent (l'OCR/PDF a un coût non négligeable par document).
 */
export async function parseDownloadedEmarqueDocuments(supabase: DbClient, options: { clubId?: string; limit?: number } = {}): Promise<ParseDownloadedDocumentsResult> {
  const result: ParseDownloadedDocumentsResult = { candidatesExamined: 0, imported: 0, errors: 0 };

  let builder = supabase
    .from("match_documents")
    .select("id, club_id, match_id, filename, storage_path, sha256")
    .eq("type", "emarque_zip")
    .eq("status", "downloaded");

  if (options.clubId) builder = builder.eq("club_id", options.clubId);
  // Feuilles fraîchement téléchargées (matchs récents) avant les relectures.
  builder = builder.order("downloaded_at", { ascending: false });
  if (options.limit) builder = builder.limit(options.limit);

  const { data: pendingDocs, error: pendingError } = await builder;

  if (pendingError) {
    throw new Error(`Recherche des documents e-Marque téléchargés échouée : ${pendingError.message}`);
  }

  if (!pendingDocs || pendingDocs.length === 0) {
    return result;
  }

  result.candidatesExamined = pendingDocs.length;

  for (const doc of pendingDocs) {
    // Réservation atomique (2026-10-07) : l'API (Vercel) et le worker local
    // peuvent lire en même temps — une feuille déjà prise par l'autre est
    // sautée, jamais lue deux fois en parallèle.
    const { data: claimed, error: claimError } = await supabase
      .from("match_documents")
      .update({ status: "parsing", updated_at: new Date().toISOString() })
      .eq("id", doc.id)
      .eq("status", "downloaded")
      .select("id");
    if (claimError || !claimed || claimed.length === 0) continue;
    await supabase.from("matches").update({ emarque_status: "parsing" }).eq("id", doc.match_id);

    try {
      const { data: match, error: matchError } = await supabase
        .from("matches")
        .select("numero, score_home, score_away")
        .eq("id", doc.match_id)
        .single();

      if (matchError || !match) {
        throw new Error(`Match introuvable pour le document ${doc.id} : ${matchError?.message}`);
      }

      const zipBuffer = await downloadEmarqueFile(supabase, doc.storage_path);

      const parsed = await parseEmarqueZip(zipBuffer, {
        ffbbMatchNumero: match.numero,
        ffbbScoreHome: match.score_home,
        ffbbScoreAway: match.score_away,
      });

      const persisted = await persistEmarqueMatchData(supabase, {
        matchId: doc.match_id,
        clubId: doc.club_id,
        fileHash: doc.sha256,
        sourceFileName: doc.filename,
        storagePath: doc.storage_path,
        parserVersion: PARSER_VERSION,
        data: parsed,
      });
      // Fichier identique déjà lu par cette version du parseur (ex : relance
      // manuelle) : rien n'est réécrit, le match retrouve simplement le
      // statut de cette lecture — jamais laissé "en cours de lecture".
      if (persisted.alreadyImported) {
        await supabase.from("matches").update({ emarque_status: persisted.status }).eq("id", doc.match_id);
      }

      await supabase.from("match_documents").update({ status: "imported", updated_at: new Date().toISOString() }).eq("id", doc.id);
      result.imported += 1;
    } catch (error) {
      result.errors += 1;
      const message = error instanceof Error ? error.message : String(error);

      await supabase
        .from("match_documents")
        .update({ status: "error", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", doc.id);

      logError("Parsing d'un document e-Marque téléchargé en erreur", error, { documentId: doc.id, matchId: doc.match_id, clubId: doc.club_id });

      // Fichier conservé (30 jours, voir `purgeExpiredEmarqueDocuments`) :
      // diagnostic et nouvelle tentative possibles sans retourner sur FBI.
    }
  }

  logInfo("Parsing des documents e-Marque téléchargés terminé", { ...result });
  return result;
}
