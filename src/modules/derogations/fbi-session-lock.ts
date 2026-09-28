import type { DbClient } from "../../db/client.js";
import { conflict } from "../../api-error.js";

/**
 * `claim_next_fbi_job(_for_club)` garantit qu'un club n'a JAMAIS deux jobs
 * `fbi_jobs` actifs (`claimed`/`running`) simultanément — un garde-fou
 * direct contre le blocage anti-bot FBI déjà constaté en production (voir
 * ProcessFbiJobsButton.tsx côté SCSB, incident du 2026-09-24 : ~190
 * connexions FBI enchaînées sans pause).
 *
 * Les actions FBI SYNCHRONES (`respond-derogation.ts`, `check-derogation-
 * sync.ts`, `check-all-derogations-sync.ts` — jamais passées par
 * `fbi_jobs`, exécutées directement dans la requête pour donner un
 * résultat immédiat, demande du club 2026-09-28 : "doit y avoir rien en
 * attente") contournent ce verrou par construction. Le cron quotidien
 * (`/internal/cron/fbi-enqueue`) empile lui un job `check_all_derogations`/
 * `reconcile_schedule` chaque matin, traité plus tard par `/internal/cron/
 * fbi-jobs` — sans ce contrôle, un clic manuel synchrone pourrait tomber
 * EN MÊME TEMPS qu'un de ces jobs en cours de traitement et ouvrir une
 * DEUXIÈME session FBI simultanée pour le même club.
 *
 * Fenêtre de fraîcheur de 10 minutes — MÊME seuil que
 * `claim_next_fbi_job(_for_club)` (migration `20260924140000_fbi_jobs_claim_stale_recovery.sql`,
 * § "Vingt-deuxième déclenchement", docs/FBI.md) : un job `claimed`/`running`
 * plus vieux que ça a forcément été tué par un timeout Vercel (`maxDuration:
 * 300`) ou un crash, jamais un vrai traitement en cours. Sans cette fenêtre,
 * un job fantôme bloquerait ce verrou INDÉFINIMENT — constaté en
 * production le 2026-09-28 (rencontre 9538) : le job `check_all_derogations`
 * resté bloqué en "claimed" depuis la veille (§ "Vérifications manuelles
 * rendues SYNCHRONES" plus haut) empêchait alors TOUTE action FBI
 * synchrone pour ce club, "erreur lors de confirmation".
 */
const STALE_JOB_THRESHOLD_MINUTES = 10;

export async function assertNoActiveFbiJob(supabase: DbClient, clubId: string): Promise<void> {
  const freshSince = new Date(Date.now() - STALE_JOB_THRESHOLD_MINUTES * 60_000).toISOString();
  const { data } = await supabase.from("fbi_jobs").select("id").eq("club_id", clubId).in("status", ["claimed", "running"]).gt("claimed_at", freshSince).limit(1).maybeSingle();

  if (data) {
    throw conflict("Une vérification FBI est déjà en cours pour ce club (job en arrière-plan) — réessaie dans quelques instants.", "FBI_SESSION_ACTIVE");
  }
}
