import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";

/**
 * `claim_next_fbi_job`/`claim_next_fbi_job_for_club` sont déclarées
 * `returns public.fbi_jobs` (une seule ligne composite, jamais `SETOF`) —
 * quand rien n'est disponible, la fonction PL/pgSQL fait `return null`,
 * mais un appel RPC sur une fonction à ligne unique renvoie TOUJOURS
 * exactement une ligne, y compris quand cette ligne EST null : PostgREST
 * la sérialise alors comme un objet dont CHAQUE colonne vaut `null`
 * (`{ id: null, club_id: null, ... }`), jamais un `null` JSON bare — confirmé
 * en production le 2026-09-24 via `select * from
 * claim_next_fbi_job_for_club(...)` directement. Sans ce garde-fou, le
 * *ligne fantôme* passait le test `!job` de `processJobBatch` (un objet
 * est toujours "truthy"), incrémentait `claimed` à tort et partait en
 * traitement avec un job aux champs tous `null` — la file ne se vidait
 * donc jamais (`claimed` ne retombait jamais à 0), et chaque appel RPC
 * "réclamait" un job fantôme en plus des vrais. `id === null` est le
 * même sentinel que la fonction SQL utilise déjà en interne
 * (`if claimed_job.id is null then return null`).
 */
function isPhantomRow(row: FbiJobRow | null): boolean {
  return row === null || row.id === null;
}

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

  return isPhantomRow(data) ? null : data;
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

  return isPhantomRow(data) ? null : data;
}
