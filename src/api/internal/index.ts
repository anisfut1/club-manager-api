import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { getEnv } from "@/config/env";
import { unauthorized } from "@/api-error";
import { createServiceSupabaseClient } from "@/db/client";
import { syncAllDueClubs } from "@/integrations/ffbb/scheduler";
import { FfbbPublicProvider } from "@/integrations/ffbb/public-provider";
import { enqueueEmarqueDiscoveryJobsForAllClubs } from "@/jobs/enqueue-emarque";
import { claimNextJob } from "@/jobs/claim";
import { processDiscoverEmarqueJob } from "@/jobs/process-discover-emarque";
import { processTestConnectionJob } from "@/jobs/process-test-connection";
import { parseDownloadedEmarqueDocuments } from "@/jobs/parse-downloaded-documents";
import { logError, logInfo } from "@/logger";

/**
 * Traitements automatiques — JAMAIS sous `/v1` (§8 de la demande). Protégé
 * par `CRON_SECRET` (en-tête `Authorization: Bearer <CRON_SECRET>`),
 * exactement le mécanisme que Vercel Cron envoie déjà par défaut pour les
 * routes déclarées dans `vercel.json` (voir docs/DEPLOYMENT.md).
 */
export const internalRouter = new Hono<AppEnv>();

internalRouter.use("*", async (c, next) => {
  const header = c.req.header("authorization");
  if (header !== `Bearer ${getEnv().CRON_SECRET}`) {
    throw unauthorized("Route interne protégée par CRON_SECRET.");
  }
  await next();
});

/** GET /internal/cron/ffbb — §29 de la demande : clubs dus, petit lot, le cron suivant reprendra le reste. */
internalRouter.get("/cron/ffbb", async (c) => {
  const supabase = createServiceSupabaseClient();
  try {
    const result = await syncAllDueClubs(supabase, new FfbbPublicProvider());
    return c.json(result);
  } catch (error) {
    logError("Cron FFBB en erreur", error);
    return c.json({ error: "ffbb_sync_failed" }, 500);
  }
});

/** GET /internal/cron/fbi-enqueue — empile des jobs discover_emarque, ne pilote jamais Playwright lui-même. */
internalRouter.get("/cron/fbi-enqueue", async (c) => {
  const supabase = createServiceSupabaseClient();
  try {
    const result = await enqueueEmarqueDiscoveryJobsForAllClubs(supabase);
    return c.json(result);
  } catch (error) {
    logError("Cron d'empilement FBI en erreur", error);
    return c.json({ error: "fbi_enqueue_failed" }, 500);
  }
});

const JOB_BATCH_SIZE = 3;

/**
 * GET /internal/cron/fbi-jobs — §27/§28 de la demande : réclame un PETIT lot
 * de jobs (jamais 50 clubs d'un coup), les traite séquentiellement dans
 * CETTE invocation, s'arrête. Le cron suivant (5 min plus tard, voir
 * vercel.json) reprendra la suite — c'est LUI le "scheduler", pas une
 * boucle infinie dans une seule invocation.
 */
internalRouter.get("/cron/fbi-jobs", async (c) => {
  const supabase = createServiceSupabaseClient();
  const workerId = `vercel-cron#${Date.now()}`;
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < JOB_BATCH_SIZE; i += 1) {
    const job = await claimNextJob(supabase, workerId);
    if (!job) break;

    claimed += 1;
    logInfo("Job FBI réclamé par le cron", { jobId: job.id, clubId: job.club_id, type: job.type });

    try {
      if (job.type === "test_connection") {
        await processTestConnectionJob(supabase, job);
      } else {
        await processDiscoverEmarqueJob(supabase, job);
      }
      succeeded += 1;
    } catch (error) {
      failed += 1;
      logError("Erreur non gérée en traitant un job FBI", error, { jobId: job.id, clubId: job.club_id });
      await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: "Erreur interne." }).eq("id", job.id);
    }
  }

  return c.json({ claimed, succeeded, failed });
});

/** GET /internal/cron/emarque-parse — étape parsing (OCR/PDF), jamais de Playwright ici. */
internalRouter.get("/cron/emarque-parse", async (c) => {
  const supabase = createServiceSupabaseClient();
  try {
    const result = await parseDownloadedEmarqueDocuments(supabase);
    return c.json(result);
  } catch (error) {
    logError("Cron de parsing e-Marque en erreur", error);
    return c.json({ error: "emarque_parse_failed" }, 500);
  }
});
