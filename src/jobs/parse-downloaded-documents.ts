import type { SupabaseClient } from "@supabase/supabase-js";
import type { DbClient } from "../db/client.js";
import { deleteEmarqueFile, downloadEmarqueFile } from "../storage/emarque-storage.js";
import { parseEmarqueZip, PARSER_VERSION } from "../integrations/emarque/parser/parse-emarque-zip.js";
import { persistEmarqueMatchData } from "../integrations/emarque/persist/persist-emarque-match.js";
import { logError, logInfo } from "../logger.js";

/**
 * TEMPORAIRE (diagnostic licence domicile feuillematch, 2026-09-30) —
 * capture une image PNG de la zone roster (en-tête + colonnes licence/nom)
 * du document feuillematch dans `debug_image_captures` (table temporaire,
 * jamais exposée par RLS à `authenticated`), pour inspection visuelle
 * directe — le document original est purgé juste après (voir
 * `purgeDocument` ci-dessous). Best-effort STRICT : toute erreur ici est
 * avalée, ne doit JAMAIS faire échouer le vrai pipeline de parsing. À
 * supprimer (avec la table) une fois le diagnostic terminé.
 */
async function debugCaptureFeuillematchRosterImage(supabase: DbClient, matchId: string, zipBuffer: Buffer): Promise<void> {
  try {
    const [{ default: JSZip }, { selectExtractor }, { PdfRasterOcrExtractor }] = await Promise.all([
      import("jszip"),
      import("../integrations/emarque/parser/select-extractor.js"),
      import("../integrations/emarque/extractors/pdf-raster-ocr-extractor.js"),
    ]);

    const zip = await JSZip.loadAsync(zipBuffer);
    const feuillematchEntry = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().includes("feuillematch_"));
    if (!feuillematchEntry) return;

    const buffer = Buffer.from(await feuillematchEntry.async("nodebuffer"));
    const extractor = await selectExtractor(buffer);
    try {
      if (!(extractor instanceof PdfRasterOcrExtractor)) return;

      const REF_WIDTH = 2479;
      const REF_HEIGHT = 3508;
      const png = await extractor.debugExportZonePng(1, {
        xFrac: 100 / REF_WIDTH,
        yFrac: 0,
        widthFrac: (1200 - 100) / REF_WIDTH,
        heightFrac: 1200 / REF_HEIGHT,
      });

      // `debug_image_captures` est une table TEMPORAIRE, absente du schéma
      // généré (db/types.ts) — cast local plutôt que de polluer les types
      // générés pour une table à supprimer sous peu.
      await (supabase as unknown as SupabaseClient).from("debug_image_captures").insert({ match_id: matchId, png_base64: png.toString("base64") });
    } finally {
      await extractor.dispose();
    }
  } catch (error) {
    logError("Capture debug image roster feuillematch échouée (non bloquant)", error, { matchId });
  }
}

/**
 * Purge le fichier original une fois le PARSING RÉUSSI — retour du club,
 * 2026-09-29 : "je veux juste l'interpréter, récupérer les stats et
 * ensuite pas la stocker". Jamais appelée sur un échec (voir le `catch`
 * ci-dessous) depuis le retour du club, même jour : "faut corriger les
 * imports des stats... sur tous les matchs, sans bug, sans interruption" —
 * purger un document en erreur supprimait la SEULE preuve exploitable pour
 * diagnostiquer un bug de parsing (constaté sur la rencontre n°3, saison
 * 2026-2027 : impossible de ré-examiner le fichier original une fois
 * purgé), et bloquait toute nouvelle tentative une fois le parseur corrigé
 * (voir `retryFailedEmarqueImports`, modules/platform/maintenance.ts, qui
 * réutilise ce même fichier plutôt que de forcer un nouveau téléchargement
 * FBI). Best-effort et jamais fatal — une suppression Storage en échec ne
 * doit jamais annuler l'import déjà persisté (les stats en base sont ce
 * qui compte, pas le fichier).
 */
async function purgeDocument(supabase: DbClient, documentId: string, storagePath: string): Promise<void> {
  try {
    await deleteEmarqueFile(supabase, storagePath);
    await supabase.from("match_documents").update({ purged_at: new Date().toISOString() }).eq("id", documentId);
  } catch (error) {
    logError("Purge Storage d'un document e-Marque après parsing échouée (non bloquant, stats déjà persistées)", error, { documentId, storagePath });
  }
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

      await debugCaptureFeuillematchRosterImage(supabase, doc.match_id, zipBuffer);

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
      await purgeDocument(supabase, doc.id, doc.storage_path);
    } catch (error) {
      result.errors += 1;
      const message = error instanceof Error ? error.message : String(error);

      await supabase
        .from("match_documents")
        .update({ status: "error", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", doc.id);

      logError("Parsing d'un document e-Marque téléchargé en erreur", error, { documentId: doc.id, matchId: doc.match_id, clubId: doc.club_id });

      // Le fichier n'est JAMAIS purgé ici — voir la doc de `purgeDocument`
      // ci-dessus : conservé pour diagnostic ET pour une nouvelle tentative
      // (`retryFailedEmarqueImports`) une fois le parseur corrigé.
    }
  }

  logInfo("Parsing des documents e-Marque téléchargés terminé", { ...result });
  return result;
}
