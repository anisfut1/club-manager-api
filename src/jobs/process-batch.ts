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
      if (job.type === "test_connection") {
        const { processTestConnectionJob } = await import("./process-test-connection.js");
        await processTestConnectionJob(supabase, job);
      } else {
        const { processDiscoverEmarqueJob } = await import("./process-discover-emarque.js");
        await processDiscoverEmarqueJob(supabase, job);
      }
      succeeded += 1;
    } catch (error) {
      failed += 1;
      logError("Erreur non gérée en traitant un job FBI", error, { jobId: job.id, clubId: job.club_id });
      await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: "Erreur interne." }).eq("id", job.id);
    }
  }

  return { claimed, succeeded, failed };
}
