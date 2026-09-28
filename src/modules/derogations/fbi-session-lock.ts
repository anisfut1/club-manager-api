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
 */
export async function assertNoActiveFbiJob(supabase: DbClient, clubId: string): Promise<void> {
  const { data } = await supabase.from("fbi_jobs").select("id").eq("club_id", clubId).in("status", ["claimed", "running"]).limit(1).maybeSingle();

  if (data) {
    throw conflict("Une vérification FBI est déjà en cours pour ce club (job en arrière-plan) — réessaie dans quelques instants.", "FBI_SESSION_ACTIVE");
  }
}
