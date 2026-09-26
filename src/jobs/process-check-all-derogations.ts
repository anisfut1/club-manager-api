import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../integrations/fbi/errors.js";
import { nextErrorBackoffSeconds } from "./backoff.js";
import { getEnv } from "../config/env.js";
import { currentSeasonStart } from "../season.js";
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

/**
 * Traite un job `check_all_derogations` : login FBI (UNE SEULE fois pour
 * tout le club — "je veux un bouton global qui check toutes les demandes,
 * pas match par match", demande du club, 2026-09-25), récupère TOUTES les
 * dérogations FBI en une recherche non filtrée
 * (`BrowserFbiClient.fetchAllDerogations`), les rapproche des rencontres du
 * club déjà synchronisées FFBB par numéro (`competitions`/`matches.numero`
 * ne suffit pas ici, la clé FBI est le numéro SEUL — voir docs/FBI.md),
 * écrit/supprime les lignes `fbi_derogation_checks` correspondantes.
 * LECTURE SEULE, jamais d'écriture sur FBI (voir docs/FBI.md).
 */
export async function processCheckAllDerogationsJob(supabase: DbClient, job: FbiJobRow): Promise<boolean> {
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

    logError("Job check_all_derogations : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
    await browser.close();
    return false;
  }

  try {
    const derogations = await client.fetchAllDerogations(session);
    const passDiagnostics = client.getLastDerogationPassDiagnostics();

    // Scopé à la saison EN COURS (même convention que `currentSeasonStart`
    // côté /v1/clubs/:clubId/issues) — `numero` n'est PAS unique sur toute
    // l'historique d'un club : constaté en production le 2026-09-25, une
    // dérogation de septembre 2026 s'est vue associée à un match de mai
    // 2026 (saison précédente) partageant le même numéro de rencontre,
    // faussant complètement la date/l'adversaire affichés. Sans scoping,
    // `matchIdByNumero` garde arbitrairement le DERNIER match rencontré
    // pour un numéro donné, jamais forcément celui de la bonne saison.
    const { data: matches, error: matchesError } = await supabase
      .from("matches")
      .select("id, numero")
      .eq("club_id", job.club_id)
      .gte("match_datetime", currentSeasonStart().toISOString());
    if (matchesError) throw new Error(`Lecture des rencontres du club échouée : ${matchesError.message}`);

    const matchIdByNumero = new Map((matches ?? []).filter((m) => m.numero).map((m) => [m.numero as string, m.id]));

    const now = new Date().toISOString();
    let matched = 0;
    let unmatched = 0;

    for (const derogation of derogations) {
      const matchId = derogation.numero ? matchIdByNumero.get(derogation.numero) : undefined;
      if (!matchId) {
        // Dérogation FBI sans rencontre FFBB correspondante trouvée (pas
        // encore synchronisée, ou numéro non reconnu) — ignorée : cette
        // table est scopée par match_id (contrainte NOT NULL), jamais de
        // ligne orpheline créée.
        unmatched += 1;
        continue;
      }

      const { error: upsertError } = await supabase.from("fbi_derogation_checks").upsert(
        {
          club_id: job.club_id,
          match_id: matchId,
          numero: derogation.numero,
          etat: derogation.etat,
          date_depot: derogation.dateDepot,
          date_derogation: derogation.dateDerogation,
          date_rencontre: derogation.dateRencontre,
          heure: derogation.heure,
          domicile: derogation.domicile,
          visiteur: derogation.visiteur,
          demandeur: derogation.demandeur,
          motif: derogation.motif,
          date_rencontre_demandee: derogation.dateRencontreDemandee,
          heure_demandee: derogation.heureDemandee,
          adversaire: derogation.adversaire,
          date_reponse: derogation.dateReponse,
          acceptation: derogation.acceptation,
          motif_refus: derogation.motifRefus,
          checked_at: now,
          updated_at: now,
        },
        { onConflict: "club_id,match_id" },
      );
      if (upsertError) throw new Error(`Écriture du résultat de dérogation échouée : ${upsertError.message}`);
      matched += 1;
    }

    // PAS de suppression automatique des lignes "non retrouvées cette
    // fois" : tenté le 2026-09-25 (nettoyage des lignes dont checked_at
    // est antérieur à cette exécution), et retiré le jour même après avoir
    // constaté en production qu'une exécution ayant trouvé anormalement
    // PEU de dérogations (recherche FBI dégradée/partielle, jamais garanti
    // exhaustive) avait alors supprimé TOUTES les lignes connues du club —
    // une perte de données pour un simple affichage périmé, un échange
    // largement défavorable. Une ligne "A Créer" périmée qui reste
    // affichée quelques exécutions de plus est un moindre mal ; elle se
    // corrige d'elle-même dès qu'une exécution future la retrouve.

    /**
     * Diagnostic riche AJOUTÉ le 2026-09-26 (constaté en production : un
     * lot connu de ~20 dérogations est retombé à `derogationsFound: 3,
     * matched: 0` juste après le déploiement de l'extraction de détail par
     * `href`/nouvel onglet, § "cinquième round", docs/FBI.md) — jusqu'ici
     * `result` ne gardait que des COMPTEURS, impossible de distinguer
     * depuis la base (sans dépendre des logs Vercel, lus une seule fois
     * puis perdus) DEUX hypothèses très différentes :
     * 1. La recherche FBI elle-même a régressé (état/pagination cassés par
     *    le nouvel onglet de détail, qui n'a jamais été éprouvé contre le
     *    VRAI FBI) — les numéros trouvés seraient alors un SOUS-ENSEMBLE
     *    anormal des numéros déjà connus.
     * 2. La recherche a bien trouvé 3 VRAIES dérogations récentes, mais
     *    dont la rencontre FFBB correspondante n'est pas encore synchronisée
     *    (numéros absents de `matches` pour la saison en cours) — un simple
     *    problème de synchronisation, sans rapport avec ce job.
     * Persisté dans `fbi_jobs.result` (consultable en base immédiatement,
     * jamais un aller-retour Vercel) : le détail par ligne trouvée (numéro/
     * état/si le motif a pu être lu) et un échantillon des numéros de
     * `matches` disponibles pour comparaison.
     */
    // `foundDerogations`/`motifLu`/`pass` par ligne retirés le 2026-09-27
    // (§ "Timeout Vercel", docs/FBI.md) : `fetchAllDerogations` ne fait
    // plus qu'une seule passe SANS détail par ligne (voir sa doc), ces
    // deux champs étaient devenus systématiquement `false`/`null` — le
    // diagnostic utile (état réellement sélectionné, lignes brutes vs
    // conservées) reste dans `passDiagnostics`.
    const result = {
      derogationsFound: derogations.length,
      matched,
      unmatched,
      foundNumeros: derogations.map((d) => d.numero).sort(),
      matchNumerosDisponibles: Array.from(matchIdByNumero.keys()).sort(),
      passDiagnostics,
    };
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: now, result }).eq("id", job.id);

    logInfo("Job check_all_derogations réussi", { clubId: job.club_id, jobId: job.id, ...result });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job check_all_derogations en erreur", error, { clubId: job.club_id, jobId: job.id });
    return false;
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
