import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../integrations/fbi/browser-launcher.js";
import type { Browser } from "playwright-core";
import type { SharedFbiSession } from "./shared-session.js";
import { classifyFbiLoginStatus, FbiError } from "../integrations/fbi/errors.js";
import { LicenceExportError, parseFbiLicenceExport } from "../modules/licencies/fbi-licence-export.js";
import { recordLicenceImportRun, syncLicenciesFromFbi } from "../modules/licencies/sync-from-fbi.js";
import { nextErrorBackoffSeconds } from "./backoff.js";
import { getEnv } from "../config/env.js";
import { logError, logInfo } from "../logger.js";

async function rescheduleJob(supabase: DbClient, job: FbiJobRow, delaySeconds: number, lastError: string | null): Promise<void> {
  await supabase
    .from("fbi_jobs")
    .update({ status: "pending", scheduled_at: new Date(Date.now() + delaySeconds * 1000).toISOString(), last_error: lastError })
    .eq("id", job.id);
}

async function failJob(supabase: DbClient, job: FbiJobRow, message: string): Promise<void> {
  await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: message }).eq("id", job.id);
}

/**
 * Traite un job `import_licences` (retour du club, 2026-10-08 : import
 * automatique des licenciés « pour les nuls ») : dans la session FBI,
 * télécharge l'export Excel des licences validées
 * (`downloadValidatedLicencesExport`), le lit, puis met à jour la liste des
 * joueurs (`syncLicenciesFromFbi`). Le fichier n'est jamais stocké : lu en
 * mémoire puis oublié. Résultat (compteurs seulement) dans `fbi_jobs.result`
 * et `licence_import_runs`.
 *
 * Un fichier qui n'a pas la forme attendue (FBI a changé son export) fait
 * échouer le job sans nouvel essai : réessayer ne changerait rien.
 */
export async function processImportLicencesJob(supabase: DbClient, job: FbiJobRow, shared?: SharedFbiSession): Promise<boolean> {
  let browser: Browser | null = null;
  let client: BrowserFbiClient;
  let session: BrowserFbiSession;
  if (shared) {
    ({ client, session } = shared);
  } else {
    const credentials = await getFbiCredentials(supabase, job.club_id);
    if (!credentials) {
      await failJob(supabase, job, "Aucun identifiant FBI enregistré pour ce club.");
      return false;
    }
    browser = await launchServerlessBrowser();
    client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });
    try {
      session = await client.login(credentials);
    } catch (error) {
      const status = classifyFbiLoginStatus(error);
      const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
      if (status === "INVALID_CREDENTIALS" || status === "AUTH_FLOW_CHANGED") await failJob(supabase, job, message);
      else if (job.attempt_count >= job.max_attempts) await failJob(supabase, job, `Connexion FBI en échec après ${job.attempt_count} tentatives : ${message}`);
      else await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
      logError("Job import_licences : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
      await browser.close().catch(() => undefined);
      return false;
    }
  }

  try {
    const { buffer } = await client.downloadValidatedLicencesExport(session);
    const { rows, skippedLines } = await parseFbiLicenceExport(buffer);
    const result = await syncLicenciesFromFbi(supabase, job.club_id, rows);
    await recordLicenceImportRun(supabase, job.club_id, "fbi", result, null);
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: new Date().toISOString(), last_error: null, result: { ...result, skippedLines } }).eq("id", job.id);
    logInfo("Job import_licences réussi", { clubId: job.club_id, jobId: job.id, ...result, skippedLines });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof LicenceExportError || job.attempt_count >= job.max_attempts) await failJob(supabase, job, message);
    else await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    logError("Job import_licences en erreur", error, { clubId: job.club_id, jobId: job.id });
    return false;
  } finally {
    if (!shared) {
      await client.closeSession(session).catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}
