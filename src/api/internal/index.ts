import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { getEnv } from "../../config/env.js";
import { unauthorized } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { syncAllDueClubs } from "../../integrations/ffbb/scheduler.js";
import { FfbbPublicProvider } from "../../integrations/ffbb/public-provider.js";
import { enqueueEmarqueDiscoveryJobsForAllClubs } from "../../jobs/enqueue-emarque.js";
import { claimNextJob } from "../../jobs/claim.js";
import { processJobBatch } from "../../jobs/process-batch.js";
import { logError } from "../../logger.js";

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

/**
 * Un seul job `discover_emarque` RÉEL par invocation — constaté en
 * production le 2026-09-24 (§ "Vingt-deuxième déclenchement", docs/FBI.md) :
 * le tout premier succès de bout en bout (rencontre n°1481, 5 documents
 * téléchargés) a pris ~3min30 (login + navigation + recherche + téléchargement
 * réels contre le vrai FBI, bien plus lent que les fixtures locales). Un lot
 * de 3 (l'ancienne valeur) peut donc dépasser `maxDuration: 300` (vercel.json)
 * dès le 2ᵉ ou 3ᵉ job — provoquant un "Vercel Runtime Timeout Error", qui tue
 * le process AVANT que le job en cours puisse passer en `succeeded`/`failed`
 * ou même que son `finally` (fermeture de session/browser) s'exécute : il
 * reste bloqué en `status = 'claimed'` indéfiniment, ce qui bloque ENSUITE
 * tout nouveau job pour ce club via la contrainte "un job actif par club"
 * (voir la garde d'auto-guérison ajoutée aux deux fonctions SQL
 * `claim_next_fbi_job*`, migration 20260924140000).
 */
const JOB_BATCH_SIZE = 1;

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
  const result = await processJobBatch(supabase, JOB_BATCH_SIZE, () => claimNextJob(supabase, workerId));
  return c.json(result);
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
