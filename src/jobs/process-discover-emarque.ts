import { createHash } from "node:crypto";
import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../integrations/fbi/errors.js";
import { inferMatchDocumentType, mimeTypeForFileName } from "../integrations/fbi/document-type.js";
import { looksLikeZip } from "../integrations/fbi/emarque-search.js";
import { emarqueStoragePath, resolveSeasonLabel, uploadEmarqueFile } from "../storage/emarque-storage.js";
import { nextErrorBackoffSeconds, nextWaitingBackoffSeconds } from "./backoff.js";
import { getEnv } from "../config/env.js";
import { logError, logInfo } from "../logger.js";

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
 *
 * Renvoie `true` UNIQUEMENT quand le job atteint réellement `status:
 * "succeeded"` — jamais juste "n'a pas levé d'exception jusqu'à l'appelant".
 * Constaté en production le 2026-09-24 : cette fonction gère ELLE-MÊME ses
 * échecs (reschedule/fail en interne, jamais de `throw` vers
 * `processJobBatch`), donc l'ancien `Promise<void>` faisait compter
 * `processJobBatch` un job comme "réussi" dès que l'appel se terminait
 * sans exception — y compris pour un job simplement REPLANIFIÉ (page de
 * résultat introuvable, aucun document trouvé pour l'instant...). Un
 * admin cliquant "Traiter les jobs FBI en attente" voyait "3 réussis"
 * alors qu'un seul job avait réellement abouti.
 */
export async function processDiscoverEmarqueJob(supabase: DbClient, job: FbiJobRow): Promise<boolean> {
  if (!job.match_id) {
    await failJob(supabase, job, "Job discover_emarque sans match_id (ne devrait jamais arriver, voir la contrainte NOT NULL applicative).");
    return false;
  }

  const { data: match, error: matchError } = await supabase
    .from("matches")
    .select("id, club_id, numero, match_datetime, competition_id")
    .eq("id", job.match_id)
    .single();

  if (matchError || !match || !match.numero) {
    await failJob(supabase, job, `Match introuvable ou sans numéro de rencontre : ${matchError?.message ?? "numero manquant"}`);
    return false;
  }

  // `division` (§ "82 vs 51", docs/FBI.md, 2026-09-27 ; retour du club,
  // 2026-09-30 : "tu confonds les matchs") désambiguïse un numéro de
  // rencontre qui n'est PAS unique au club — même dérivation que
  // `process-check-derogation.ts`. `null` (compétition inconnue) reste un
  // repli best-effort, jamais un échec du job.
  let division: string | null = null;
  if (match.competition_id) {
    const { data: competition } = await supabase.from("competitions").select("code").eq("id", match.competition_id).maybeSingle();
    division = competition?.code ?? null;
  }

  const credentials = await getFbiCredentials(supabase, job.club_id);
  if (!credentials) {
    await failJob(supabase, job, "Aucun identifiant FBI enregistré pour ce club.");
    return false;
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
    return false;
  }

  try {
    const season = resolveSeasonLabel(match.match_datetime);
    const { documents, diagnostic } = await client.findEmarqueDocuments(session, match.numero, season, division);

    if (documents.length === 0) {
      await supabase.from("matches").update({ emarque_status: "waiting_for_emarque" }).eq("id", job.match_id);
      /**
       * Le diagnostic riche (trace/champs/HTML) est persisté dans
       * `last_error` MÊME si ce n'est pas une vraie erreur (§ "Vingt-
       * septième déclenchement", docs/FBI.md) — même colonne déjà utilisée
       * pour un échec dur, directement consultable en base sans dépendre
       * des logs Vercel. Le préfixe `[info, pas une erreur]` (déjà dans
       * `diagnostic`) évite toute confusion en le relisant plus tard.
       */
      await rescheduleJob(supabase, job, nextWaitingBackoffSeconds(job.attempt_count), diagnostic);
      logInfo("Job discover_emarque : aucun document trouvé pour l'instant, nouvelle tentative planifiée", { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
      return false;
    }

    await supabase.from("matches").update({ emarque_status: "downloading" }).eq("id", job.match_id);

    // Priorité absolue au ZIP complet s'il existe : les documents séparés
    // ne sont téléchargés que si aucun ZIP n'est disponible.
    const zip = documents.find((doc) => doc.fileName.toLowerCase().endsWith(".zip"));
    const toDownload = zip ? [zip] : documents;

    let downloadedCount = 0;

    for (const doc of toDownload) {
      const buffer = await client.downloadDocument(session, doc.url);

      // Retour du club, 2026-10-02 : FBI renvoie une page HTML (pas une erreur HTTP) quand le fichier
      // n'est pas encore disponible — jamais l'enregistrer comme e-Marque (le parsing échouerait) :
      // le match reste « en attente », nouvelle tentative plus tard.
      if (doc.fileName.toLowerCase().endsWith(".zip") && !looksLikeZip(buffer)) {
        const preview = buffer.subarray(0, 200).toString("utf8").replace(/\s+/g, " ").trim();
        await supabase.from("matches").update({ emarque_status: "waiting_for_emarque" }).eq("id", job.match_id);
        await rescheduleJob(
          supabase,
          job,
          nextWaitingBackoffSeconds(job.attempt_count),
          `[info, pas une erreur] FBI n'a pas renvoyé de ZIP e-Marque pour la rencontre ${match.numero} (${buffer.length} octets, début : ${preview})`,
        );
        logInfo("Job discover_emarque : fichier e-Marque pas encore disponible (réponse non-ZIP)", { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
        return false;
      }
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

      if (insertError) {
        // Même fichier déjà connu (souvent déjà parsé puis purgé) : il vient
        // d'être re-déposé en Storage, on le remet en file de parsing — sans
        // quoi une nouvelle découverte volontaire (ex : relecture avec un
        // parseur corrigé) ne serait jamais reparsée. Le parsing reste
        // idempotent (voir `persistEmarqueMatchData`).
        const now = new Date().toISOString();
        const { error: resetError } = await supabase
          .from("match_documents")
          .update({ status: "downloaded", storage_path: storagePath, purged_at: null, last_error: null, downloaded_at: now, updated_at: now })
          .eq("club_id", job.club_id)
          .eq("match_id", job.match_id)
          .eq("type", type)
          .eq("sha256", sha256);
        if (resetError) throw new Error(`Remise en file du document e-Marque existant échouée : ${resetError.message}`);
      }

      downloadedCount += 1;
    }

    await supabase.from("matches").update({ emarque_status: "downloaded" }).eq("id", job.match_id);
    await supabase
      .from("fbi_jobs")
      .update({ status: "succeeded", finished_at: new Date().toISOString(), result: { documentsFound: documents.length, documentsDownloaded: downloadedCount } })
      .eq("id", job.id);

    logInfo("Job discover_emarque réussi", { clubId: job.club_id, jobId: job.id, matchId: job.match_id, documentsDownloaded: downloadedCount });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    await supabase.from("matches").update({ emarque_status: "error" }).eq("id", job.match_id);
    logError("Job discover_emarque en erreur", error, { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
    return false;
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
