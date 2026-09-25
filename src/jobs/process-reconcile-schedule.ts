import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../integrations/fbi/errors.js";
import { reconcileFbiSchedule, type OurMatchForReconciliation } from "../integrations/fbi/schedule-reconciliation.js";
import { nextErrorBackoffSeconds } from "./backoff.js";
import { getEnv } from "../config/env.js";
import { logError, logInfo } from "../logger.js";

async function rescheduleJob(supabase: DbClient, job: FbiJobRow, delaySeconds: number, lastError: string | null): Promise<void> {
  await supabase
    .from("fbi_jobs")
    .update({ status: "pending", scheduled_at: new Date(Date.now() + delaySeconds * 1000).toISOString(), last_error: lastError })
    .eq("id", job.id);
}

async function failJob(supabase: DbClient, job: FbiJobRow, message: string): Promise<void> {
  await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: message }).eq("id", job.id);
}

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    { club_id: clubId, configured: true, last_login_at: now, last_login_success: success, last_job_at: now, last_job_status: success ? "success" : "error", last_error: success ? null : message, updated_at: now },
    { onConflict: "club_id" },
  );
}

/** Clé stable d'une anomalie, pour rapprocher un résultat de rapprochement fraîchement calculé aux lignes déjà ouvertes en base (voir la contrainte fbi_schedule_discrepancies_unique_open, même logique côté application). */
function discrepancyKey(d: { divisionCode: string | null; numero: string | null; kind: string; fieldName: string | null }): string {
  return [d.divisionCode ?? "", d.numero ?? "", d.kind, d.fieldName ?? ""].join("::");
}

/**
 * Traite un job `reconcile_schedule` : login FBI (navigateur, voir
 * browser-client.ts), récupère TOUT le calendrier FBI du club, le compare
 * aux rencontres déjà synchronisées FFBB (`reconcileFbiSchedule`, fonction
 * pure), puis journalise les anomalies dans `fbi_schedule_discrepancies` —
 * jamais une écriture sur `matches` (FFBB reste la seule source écrite,
 * voir docs/FBI.md "Rapprochement calendrier FFBB/FBI").
 *
 * Un seul job PAR CLUB (jamais par match, contrainte
 * fbi_jobs_unique_pending_reconcile_schedule) — déclenché à la demande
 * (bouton admin) pour l'instant, voir POST .../fbi/reconcile-schedule.
 */
export async function processReconcileScheduleJob(supabase: DbClient, job: FbiJobRow): Promise<boolean> {
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
      await failJob(supabase, job, message);
    } else if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, `Connexion FBI en échec après ${job.attempt_count} tentatives : ${message}`);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job reconcile_schedule : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
    await browser.close();
    return false;
  }

  try {
    const fbiRows = await client.fetchScheduleRows(session);

    const { data: matches, error: matchesError } = await supabase
      .from("matches")
      .select("id, numero, match_datetime, status, competition_id")
      .eq("club_id", job.club_id);
    if (matchesError) throw new Error(`Lecture des rencontres du club échouée : ${matchesError.message}`);

    const competitionIds = Array.from(new Set((matches ?? []).map((m) => m.competition_id).filter((id): id is string => Boolean(id))));
    const { data: competitions, error: competitionsError } =
      competitionIds.length > 0 ? await supabase.from("competitions").select("id, code").in("id", competitionIds) : { data: [], error: null };
    if (competitionsError) throw new Error(`Lecture des compétitions échouée : ${competitionsError.message}`);

    const codeByCompetitionId = new Map((competitions ?? []).map((c) => [c.id, c.code]));

    const ourMatches: OurMatchForReconciliation[] = (matches ?? []).map((m) => ({
      id: m.id,
      competitionCode: m.competition_id ? (codeByCompetitionId.get(m.competition_id) ?? null) : null,
      numero: m.numero,
      matchDatetime: m.match_datetime,
      status: m.status,
    }));

    const freshDiscrepancies = reconcileFbiSchedule(fbiRows, ourMatches);
    const freshByKey = new Map(freshDiscrepancies.map((d) => [discrepancyKey(d), d]));

    const { data: openRows, error: openRowsError } = await supabase
      .from("fbi_schedule_discrepancies")
      .select("id, division_code, numero, kind, field_name")
      .eq("club_id", job.club_id)
      .is("resolved_at", null);
    if (openRowsError) throw new Error(`Lecture des anomalies ouvertes échouée : ${openRowsError.message}`);

    const openByKey = new Map(
      (openRows ?? []).map((r) => [discrepancyKey({ divisionCode: r.division_code, numero: r.numero, kind: r.kind, fieldName: r.field_name }), r.id]),
    );

    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;

    for (const [key, discrepancy] of freshByKey) {
      const existingId = openByKey.get(key);

      if (existingId) {
        await supabase
          .from("fbi_schedule_discrepancies")
          .update({ last_seen_at: now, ffbb_value: discrepancy.ffbbValue, fbi_value: discrepancy.fbiValue, fbi_opponent_name: discrepancy.fbiOpponentName })
          .eq("id", existingId);
        updated += 1;
      } else {
        await supabase.from("fbi_schedule_discrepancies").insert({
          club_id: job.club_id,
          match_id: discrepancy.matchId,
          division_code: discrepancy.divisionCode,
          numero: discrepancy.numero,
          kind: discrepancy.kind,
          field_name: discrepancy.fieldName,
          ffbb_value: discrepancy.ffbbValue,
          fbi_value: discrepancy.fbiValue,
          fbi_opponent_name: discrepancy.fbiOpponentName,
          detected_at: now,
          last_seen_at: now,
        });
        created += 1;
      }
    }

    // Une anomalie précédemment ouverte que ce rapprochement ne revoit plus
    // (mismatch corrigé côté FFBB, rencontre désormais alignée) est résolue
    // automatiquement — jamais une résolution manuelle nécessaire pour une
    // anomalie qui ne se reproduit plus.
    const resolvedIds = (openRows ?? []).filter((r) => !freshByKey.has(discrepancyKey({ divisionCode: r.division_code, numero: r.numero, kind: r.kind, fieldName: r.field_name }))).map((r) => r.id);
    let resolved = 0;
    if (resolvedIds.length > 0) {
      await supabase.from("fbi_schedule_discrepancies").update({ resolved_at: now }).in("id", resolvedIds);
      resolved = resolvedIds.length;
    }

    const result = { fbiRowsFound: fbiRows.length, ourMatchesExamined: ourMatches.length, discrepanciesCreated: created, discrepanciesUpdated: updated, discrepanciesResolved: resolved };
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: new Date().toISOString(), result }).eq("id", job.id);

    logInfo("Job reconcile_schedule réussi", { clubId: job.club_id, jobId: job.id, ...result });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job reconcile_schedule en erreur", error, { clubId: job.club_id, jobId: job.id });
    return false;
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
