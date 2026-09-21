import { createHash } from "node:crypto";
import type { DbClient } from "@/db/client";
import type { FbiJobRow } from "@/db/types";
import { getFbiCredentials } from "@/integrations/fbi/credentials-store";
import { BrowserFbiClient, type BrowserFbiSession } from "@/integrations/fbi/browser-client";
import { launchServerlessBrowser } from "@/integrations/fbi/browser-launcher";
import { classifyFbiLoginStatus, FbiError } from "@/integrations/fbi/errors";
import { inferMatchDocumentType, mimeTypeForFileName } from "@/integrations/fbi/document-type";
import { emarqueStoragePath, resolveSeasonLabel, uploadEmarqueFile } from "@/storage/emarque-storage";
import { nextErrorBackoffSeconds, nextWaitingBackoffSeconds } from "./backoff";
import { getEnv } from "@/config/env";
import { logError, logInfo } from "@/logger";

const UNIQUE_VIOLATION = "23505";

async function rescheduleJob(supabase: DbClient, job: FbiJobRow, delaySeconds: number, lastError: string | null): Promise<void> {
  await supabase
    .from("fbi_jobs")
    .update({ status: "pending", scheduled_at: new Date(Date.now() + delaySeconds * 1000).toISOString(), last_error: lastError })
    .eq("id", job.id);
}

async function failJob(supabase: DbClient, job: FbiJobRow, message: string): Promise<void> {
  await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: message }).eq("id", job.id);
}

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    {
      club_id: clubId,
      configured: true,
      last_login_at: now,
      last_login_success: success,
      last_job_at: now,
      last_job_status: success ? "success" : "error",
      last_error: success ? null : message,
      updated_at: now,
    },
    { onConflict: "club_id" },
  );
}

/**
 * Traite un job `discover_emarque` : login FBI (navigateur — voir
 * browser-client.ts, l'endpoint HTTP direct n'existe pas pour cette étape),
 * recherche des documents de la rencontre, téléchargement, dépôt Storage,
 * puis une ligne `match_documents` PAR fichier. Le PARSING du ZIP n'a pas
 * lieu ici — voir src/jobs/parse-downloaded-documents.ts (route/cron léger,
 * sans Playwright) qui consomme `match_documents.status = 'downloaded'`.
 */
export async function processDiscoverEmarqueJob(supabase: DbClient, job: FbiJobRow): Promise<void> {
  if (!job.match_id) {
    await failJob(supabase, job, "Job discover_emarque sans match_id (ne devrait jamais arriver, voir la contrainte NOT NULL applicative).");
    return;
  }

  const { data: match, error: matchError } = await supabase
    .from("matches")
    .select("id, club_id, numero, match_datetime")
    .eq("id", job.match_id)
    .single();

  if (matchError || !match || !match.numero) {
    await failJob(supabase, job, `Match introuvable ou sans numéro de rencontre : ${matchError?.message ?? "numero manquant"}`);
    return;
  }

  const credentials = await getFbiCredentials(supabase, job.club_id);
  if (!credentials) {
    await failJob(supabase, job, "Aucun identifiant FBI enregistré pour ce club.");
    return;
  }

  const browser = await launchServerlessBrowser();
  const client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });
  let session: BrowserFbiSession;

  try {
    session = await client.login(credentials);
    await recordLoginOutcome(supabase, job.club_id, true, null);
  } catch (error) {
    const status = classifyFbiLoginStatus(error);
    const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
    await recordLoginOutcome(supabase, job.club_id, false, message);

    if (status === "INVALID_CREDENTIALS" || status === "AUTH_FLOW_CHANGED") {
      // Ne se corrigera jamais tout seul en réessayant — surfacé via
      // fbi_integration_status.last_error, visible côté API/admin.
      await failJob(supabase, job, message);
    } else if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, `Connexion FBI en échec après ${job.attempt_count} tentatives : ${message}`);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job discover_emarque : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
    await browser.close();
    return;
  }

  try {
    const documents = await client.findEmarqueDocuments(session, match.numero);

    if (documents.length === 0) {
      await supabase.from("matches").update({ emarque_status: "waiting_for_emarque" }).eq("id", job.match_id);
      await rescheduleJob(supabase, job, nextWaitingBackoffSeconds(job.attempt_count), null);
      logInfo("Job discover_emarque : aucun document trouvé pour l'instant, nouvelle tentative planifiée", { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
      return;
    }

    await supabase.from("matches").update({ emarque_status: "downloading" }).eq("id", job.match_id);

    // Priorité absolue au ZIP complet s'il existe : les documents séparés
    // ne sont téléchargés que si aucun ZIP n'est disponible.
    const zip = documents.find((doc) => doc.fileName.toLowerCase().endsWith(".zip"));
    const toDownload = zip ? [zip] : documents;

    const season = resolveSeasonLabel(match.match_datetime);
    let downloadedCount = 0;

    for (const doc of toDownload) {
      const buffer = await client.downloadDocument(session, doc.url);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const type = inferMatchDocumentType(doc.fileName);
      const storagePath = emarqueStoragePath(job.club_id, season, job.match_id, doc.fileName);

      await uploadEmarqueFile(supabase, storagePath, buffer, mimeTypeForFileName(doc.fileName));

      const { error: insertError } = await supabase.from("match_documents").insert({
        club_id: job.club_id,
        match_id: job.match_id,
        type,
        filename: doc.fileName,
        mime_type: mimeTypeForFileName(doc.fileName),
        sha256,
        storage_path: storagePath,
        status: "downloaded",
        downloaded_at: new Date().toISOString(),
      });

      if (insertError && insertError.code !== UNIQUE_VIOLATION) {
        throw new Error(`Insertion match_documents échouée : ${insertError.message}`);
      }

      downloadedCount += 1;
    }

    await supabase.from("matches").update({ emarque_status: "downloaded" }).eq("id", job.match_id);
    await supabase
      .from("fbi_jobs")
      .update({ status: "succeeded", finished_at: new Date().toISOString(), result: { documentsFound: documents.length, documentsDownloaded: downloadedCount } })
      .eq("id", job.id);

    logInfo("Job discover_emarque réussi", { clubId: job.club_id, jobId: job.id, matchId: job.match_id, documentsDownloaded: downloadedCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    await supabase.from("matches").update({ emarque_status: "error" }).eq("id", job.match_id);
    logError("Job discover_emarque en erreur", error, { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
