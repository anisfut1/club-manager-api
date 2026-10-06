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
import { emarqueCheckWindowStart, nextEmarqueCheckAt } from "./backoff.js";
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

/**
 * Seule issue d'un essai qui n'a pas abouti (feuille pas encore publiée,
 * FBI injoignable, fichier invalide, erreur imprévue) : prochain créneau
 * du calendrier FIXE (`nextEmarqueCheckAt`), jamais un délai dépendant du
 * nombre d'essais ni un abandon anticipé. Fenêtre de 7 jours écoulée :
 * match "pas de feuille e-Marque" (relance manuelle possible).
 */
async function scheduleNextCheck(supabase: DbClient, job: FbiJobRow, matchDatetime: string | null, message: string | null): Promise<void> {
  // Match sans date connue : fenêtre ouverte à la création du job.
  const windowStart = emarqueCheckWindowStart(matchDatetime, job.window_start ?? (matchDatetime ? null : job.created_at));
  const next = windowStart ? nextEmarqueCheckAt(windowStart) : null;

  if (next) {
    await supabase.from("matches").update({ emarque_status: "waiting_for_emarque" }).eq("id", job.match_id!);
    await rescheduleJob(supabase, job, Math.max(0, (next.getTime() - Date.now()) / 1000), message);
    return;
  }

  await supabase.from("matches").update({ emarque_status: "not_available" }).eq("id", job.match_id!);
  await failJob(supabase, job, `Pas de feuille e-Marque récupérée sur FBI 7 jours après le match — vérifications automatiques terminées (relance manuelle possible). Dernier essai : ${message ?? "—"}`);
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

interface DiscoverTarget {
  match: { id: string; numero: string; match_datetime: string | null };
  division: string | null;
}

/** Charge le match du job (et sa division FBI) ; job en échec définitif si le match est inutilisable. */
async function loadDiscoverTarget(supabase: DbClient, job: FbiJobRow): Promise<DiscoverTarget | null> {
  if (!job.match_id) {
    await failJob(supabase, job, "Job discover_emarque sans match_id (ne devrait jamais arriver, voir la contrainte NOT NULL applicative).");
    return null;
  }

  const { data: match, error: matchError } = await supabase
    .from("matches")
    .select("id, club_id, numero, match_datetime, competition_id")
    .eq("id", job.match_id)
    .single();

  if (matchError || !match || !match.numero) {
    await failJob(supabase, job, `Match introuvable ou sans numéro de rencontre : ${matchError?.message ?? "numero manquant"}`);
    return null;
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

  return { match: { id: match.id, numero: match.numero, match_datetime: match.match_datetime }, division };
}

/**
 * Une connexion FBI pour PLUSIEURS matchs (2026-10-06 : une connexion par
 * match — identifiant + mot de passe à chaque fois — était précisément ce
 * que FBI coupait quand plusieurs matchs attendaient). Après le premier
 * job, les jobs `discover_emarque` dus du MÊME club sont réclamés et
 * traités dans la même session, tant qu'il reste du temps sur l'invocation
 * Vercel (`maxDuration` 300 s) — jamais un nouveau match démarré après
 * `SESSION_NEW_JOB_BUDGET_MS`, une courte pause entre deux matchs.
 */
const SESSION_NEW_JOB_BUDGET_MS = 120_000;
const PAUSE_BETWEEN_MATCHES_MS = 3_000;

export interface DiscoverSessionOptions {
  /** Réclame le prochain job `discover_emarque` dû du même club, à traiter dans la session déjà ouverte. */
  claimNextInSession?: () => Promise<FbiJobRow | null>;
  /** Issue de chaque job SUPPLÉMENTAIRE traité dans la session (le premier est la valeur de retour). */
  onSessionJobDone?: (succeeded: boolean) => void;
  /** Surcharge de test. */
  newJobBudgetMs?: number;
  pauseBetweenMatchesMs?: number;
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
export async function processDiscoverEmarqueJob(supabase: DbClient, job: FbiJobRow, options: DiscoverSessionOptions = {}): Promise<boolean> {
  const target = await loadDiscoverTarget(supabase, job);
  if (!target) return false;

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
    } else {
      // FBI injoignable : jamais d'abandon, créneau suivant du calendrier —
      // pour CE match et pour tous les autres matchs dus du club : une seule
      // tentative de connexion par passage, jamais une par match (FBI coupe
      // précisément les connexions répétées).
      await scheduleNextCheck(supabase, job, target.match.match_datetime, message);
      if (options.claimNextInSession) {
        let deferred = 0;
        for (let nextJob = await options.claimNextInSession(); nextJob; nextJob = await options.claimNextInSession()) {
          const nextTarget = await loadDiscoverTarget(supabase, nextJob);
          if (nextTarget) await scheduleNextCheck(supabase, nextJob, nextTarget.match.match_datetime, message);
          options.onSessionJobDone?.(false);
          deferred += 1;
        }
        if (deferred > 0) logInfo("Connexion FBI échouée : autres matchs du club reportés au créneau suivant", { clubId: job.club_id, deferred });
      }
    }

    logError("Job discover_emarque : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
    await browser.close();
    return false;
  }

  const startedAt = Date.now();
  const budgetMs = options.newJobBudgetMs ?? SESSION_NEW_JOB_BUDGET_MS;
  let firstSucceeded = false;
  let current: { job: FbiJobRow; target: DiscoverTarget } | null = { job, target };

  try {
    while (current) {
      const outcome = await discoverWithSession(supabase, client, session, current.job, current.target);
      if (current.job.id === job.id) firstSucceeded = outcome === "succeeded";
      else options.onSessionJobDone?.(outcome === "succeeded");

      current = null;
      // Erreur FBI (coupure, délai dépassé) : on n'insiste pas sur les
      // matchs suivants dans cette session — ils gardent leur créneau et
      // seront repris au prochain passage.
      while (outcome !== "error" && options.claimNextInSession && Date.now() - startedAt < budgetMs) {
        const nextJob = await options.claimNextInSession();
        if (!nextJob) break;
        const nextTarget = await loadDiscoverTarget(supabase, nextJob);
        if (!nextTarget) {
          options.onSessionJobDone?.(false);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, options.pauseBetweenMatchesMs ?? PAUSE_BETWEEN_MATCHES_MS));
        current = { job: nextJob, target: nextTarget };
        break;
      }
    }
  } finally {
    await client.closeSession(session);
    await browser.close();
  }

  return firstSucceeded;
}

type DiscoverOutcome = "succeeded" | "not_yet" | "error";

/** Recherche + téléchargement d'UN match dans une session FBI déjà ouverte — gère lui-même son issue (succès, créneau suivant). */
async function discoverWithSession(supabase: DbClient, client: BrowserFbiClient, session: BrowserFbiSession, job: FbiJobRow, target: DiscoverTarget): Promise<DiscoverOutcome> {
  const { match, division } = target;
  try {
    const season = resolveSeasonLabel(match.match_datetime);
    const { documents, diagnostic } = await client.findEmarqueDocuments(session, match.numero, season, division);

    if (documents.length === 0) {
      /**
       * Le diagnostic riche (trace/champs/HTML) est persisté dans
       * `last_error` MÊME si ce n'est pas une vraie erreur (§ "Vingt-
       * septième déclenchement", docs/FBI.md) — même colonne déjà utilisée
       * pour un échec dur, directement consultable en base sans dépendre
       * des logs Vercel. Le préfixe `[info, pas une erreur]` (déjà dans
       * `diagnostic`) évite toute confusion en le relisant plus tard.
       */
      await scheduleNextCheck(supabase, job, match.match_datetime, diagnostic);
      logInfo("Job discover_emarque : aucun document trouvé pour l'instant, nouvelle tentative planifiée", { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
      return "not_yet";
    }

    await supabase.from("matches").update({ emarque_status: "downloading" }).eq("id", match.id);

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
        await scheduleNextCheck(
          supabase,
          job,
          match.match_datetime,
          `[info, pas une erreur] FBI n'a pas renvoyé de ZIP e-Marque pour la rencontre ${match.numero} (${buffer.length} octets, début : ${preview})`,
        );
        logInfo("Job discover_emarque : fichier e-Marque pas encore disponible (réponse non-ZIP)", { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
        return "not_yet";
      }
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const type = inferMatchDocumentType(doc.fileName);
      const storagePath = emarqueStoragePath(job.club_id, season, match.id, doc.fileName);

      await uploadEmarqueFile(supabase, storagePath, buffer, mimeTypeForFileName(doc.fileName));

      const { error: insertError } = await supabase.from("match_documents").insert({
        club_id: job.club_id,
        match_id: match.id,
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
          .eq("match_id", match.id)
          .eq("type", type)
          .eq("sha256", sha256);
        if (resetError) throw new Error(`Remise en file du document e-Marque existant échouée : ${resetError.message}`);
      }

      downloadedCount += 1;
    }

    await supabase.from("matches").update({ emarque_status: "downloaded" }).eq("id", match.id);
    await supabase
      .from("fbi_jobs")
      .update({ status: "succeeded", finished_at: new Date().toISOString(), result: { documentsFound: documents.length, documentsDownloaded: downloadedCount } })
      .eq("id", job.id);

    logInfo("Job discover_emarque réussi", { clubId: job.club_id, jobId: job.id, matchId: job.match_id, documentsDownloaded: downloadedCount });
    return "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Erreur imprévue (téléchargement, dépôt...) : jamais d'abandon ni de
    // match laissé "en erreur" — créneau suivant du calendrier fixe.
    await scheduleNextCheck(supabase, job, match.match_datetime, message);
    logError("Job discover_emarque en erreur", error, { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
    return "error";
  }
}
