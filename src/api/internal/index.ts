import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { getEnv } from "../../config/env.js";
import { unauthorized } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { syncAllDueClubs } from "../../integrations/ffbb/scheduler.js";
import { FfbbPublicProvider } from "../../integrations/ffbb/public-provider.js";
import { enqueueEmarqueDiscoveryJobsForAllClubs } from "../../jobs/enqueue-emarque.js";
import { claimNextJob } from "../../jobs/claim.js";
import { logError, logInfo } from "../../logger.js";

/**
 * `processDiscoverEmarqueJob`/`processTestConnectionJob` (via
 * browser-launcher.ts) et `parseDownloadedEmarqueDocuments` (via le
 * pipeline OCR/PDF) tirent playwright-core/@sparticuz/chromium/tesseract.js/
 * @napi-rs/canvas — des dépendances natives volumineuses. Ce fichier
 * n'utilisant PAS de bundler sur Vercel (chaque .ts est transpilé et
 * exécuté individuellement par le runtime, voir docs/DEPLOYMENT.md),
 * un `import` statique ici les chargerait à CHAQUE démarrage à froid de la
 * fonction — y compris pour `/health` ou `/v1/clubs`, qui ne les utilisent
 * jamais — au point de dépasser le temps d'exécution du plan Vercel Hobby.
 * Import dynamique : le coût n'est payé que par les invocations qui
 * traitent réellement un job FBI/e-Marque.
 */

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
        const { processTestConnectionJob } = await import("../../jobs/process-test-connection.js");
        await processTestConnectionJob(supabase, job);
      } else {
        const { processDiscoverEmarqueJob } = await import("../../jobs/process-discover-emarque.js");
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
    const { parseDownloadedEmarqueDocuments } = await import("../../jobs/parse-downloaded-documents.js");
    const result = await parseDownloadedEmarqueDocuments(supabase);
    return c.json(result);
  } catch (error) {
    logError("Cron de parsing e-Marque en erreur", error);
    return c.json({ error: "emarque_parse_failed" }, 500);
  }
});
