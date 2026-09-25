import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { logError, logInfo } from "../logger.js";

export interface ProcessBatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

/**
 * Réclame et traite un lot de jobs FBI via `claimJob`, en dispatchant par
 * `type` — factorisé entre `/internal/cron/fbi-jobs` (réclamation globale,
 * `claim_next_fbi_job`) et `POST /v1/clubs/:clubId/integrations/fbi/process-jobs`
 * (réclamation scopée à un club, `claim_next_fbi_job_for_club`), voir
 * docs/FBI.md "Neuvième déclenchement".
 */
export async function processJobBatch(supabase: DbClient, batchSize: number, claimJob: () => Promise<FbiJobRow | null>): Promise<ProcessBatchResult> {
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < batchSize; i += 1) {
    const job = await claimJob();
    if (!job) break;

    claimed += 1;
    logInfo("Job FBI réclamé", { jobId: job.id, clubId: job.club_id, type: job.type });

    try {
      let jobSucceeded: boolean;
      if (job.type === "test_connection") {
        const { processTestConnectionJob } = await import("./process-test-connection.js");
        jobSucceeded = await processTestConnectionJob(supabase, job);
      } else if (job.type === "reconcile_schedule") {
        const { processReconcileScheduleJob } = await import("./process-reconcile-schedule.js");
        jobSucceeded = await processReconcileScheduleJob(supabase, job);
      } else if (job.type === "check_derogation") {
        const { processCheckDerogationJob } = await import("./process-check-derogation.js");
        jobSucceeded = await processCheckDerogationJob(supabase, job);
      } else {
        const { processDiscoverEmarqueJob } = await import("./process-discover-emarque.js");
        jobSucceeded = await processDiscoverEmarqueJob(supabase, job);
      }
      // Les deux fonctions ci-dessus gèrent LEURS PROPRES échecs en
      // interne (reschedule/fail, jamais de `throw` vers cette boucle) —
      // se fier au fait que l'appel "n'a pas levé d'exception" comptait
      // TOUJOURS un job comme réussi, y compris un job simplement
      // replanifié (page introuvable, rien à télécharger pour l'instant),
      // constaté en production le 2026-09-24 : "3 réussis" affiché côté
      // SCSB alors qu'un seul job avait réellement abouti. `catch`
      // ci-dessous ne couvre donc que le cas vraiment inattendu (crash
      // avant que la fonction gère elle-même son erreur).
      if (jobSucceeded) succeeded += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      logError("Erreur non gérée en traitant un job FBI", error, { jobId: job.id, clubId: job.club_id });
      await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: "Erreur interne." }).eq("id", job.id);
    }
  }

  return { claimed, succeeded, failed };
}
