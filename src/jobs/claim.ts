import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";

/**
 * Réclame le prochain job éligible via `claim_next_fbi_job` (FOR UPDATE
 * SKIP LOCKED côté Postgres, voir supabase/migrations/20260921110000_fbi_jobs.sql)
 * — c'est CETTE fonction SQL, jamais une logique applicative, qui garantit
 * qu'aucun job n'est traité deux fois, et qu'un club n'a jamais plus d'une
 * session FBI active simultanément quel que soit le nombre d'invocations
 * de Vercel Function en cours. `supabase` DOIT être le client service role
 * (§20 de la demande : la fonction reste service_role only, voir la
 * migration `20260921110040_fbi_jobs_execute_lockdown.sql`).
 */
export async function claimNextJob(supabase: DbClient, workerId: string): Promise<FbiJobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_fbi_job", { p_worker_id: workerId });

  if (error) {
    throw new Error(`Réclamation d'un job FBI échouée : ${error.message}`);
  }

  return data ?? null;
}

/**
 * Variante scopée à UN club de `claimNextJob`, via `claim_next_fbi_job_for_club`
 * (supabase/migrations/20260924100000_fbi_jobs_claim_for_club.sql) — utilisée
 * par `POST /v1/clubs/:clubId/integrations/fbi/process-jobs` pour ne jamais
 * réclamer/traiter les jobs d'un autre club depuis une route `/v1/*`.
 */
export async function claimNextJobForClub(supabase: DbClient, clubId: string, workerId: string): Promise<FbiJobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_fbi_job_for_club", { p_club_id: clubId, p_worker_id: workerId });

  if (error) {
    throw new Error(`Réclamation d'un job FBI (club) échouée : ${error.message}`);
  }

  return data ?? null;
}
