import type { DbClient } from "../db/client.js";
import { downloadEmarqueFile } from "../storage/emarque-storage.js";
import { parseEmarqueZip, PARSER_VERSION } from "../integrations/emarque/parser/parse-emarque-zip.js";
import { persistEmarqueMatchData } from "../integrations/emarque/persist/persist-emarque-match.js";
import { logError, logInfo } from "../logger.js";

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
 */
export async function parseDownloadedEmarqueDocuments(supabase: DbClient): Promise<ParseDownloadedDocumentsResult> {
  const result: ParseDownloadedDocumentsResult = { candidatesExamined: 0, imported: 0, errors: 0 };

  const { data: pendingDocs, error: pendingError } = await supabase
    .from("match_documents")
    .select("id, club_id, match_id, filename, storage_path, sha256")
    .eq("type", "emarque_zip")
    .eq("status", "downloaded");

  if (pendingError) {
    throw new Error(`Recherche des documents e-Marque téléchargés échouée : ${pendingError.message}`);
  }

  if (!pendingDocs || pendingDocs.length === 0) {
    return result;
  }

  result.candidatesExamined = pendingDocs.length;

  for (const doc of pendingDocs) {
    await supabase.from("match_documents").update({ status: "parsing", updated_at: new Date().toISOString() }).eq("id", doc.id);
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

      await persistEmarqueMatchData(supabase, {
        matchId: doc.match_id,
        clubId: doc.club_id,
        fileHash: doc.sha256,
        sourceFileName: doc.filename,
        storagePath: doc.storage_path,
        parserVersion: PARSER_VERSION,
        data: parsed,
      });

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
    }
  }

  logInfo("Parsing des documents e-Marque téléchargés terminé", { ...result });
  return result;
}
