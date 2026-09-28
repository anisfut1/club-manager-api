import type { DbClient } from "../../db/client.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { getFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../../integrations/fbi/errors.js";
import { getEnv } from "../../config/env.js";
import { logError, logInfo } from "../../logger.js";
import { assertNoActiveFbiJob } from "./fbi-session-lock.js";

export interface CreateDerogationParams {
  clubId: string;
  matchId: string;
  motif: string;
  modifierDate: boolean;
  dateDerogation: string | null;
  modifierHoraire: boolean;
  horaire: string | null;
  inverserRencontre: boolean;
  inverserEquipe: boolean;
  submittedBy: string | null;
}

export interface CreateDerogationResult {
  outcome: "success" | "error" | "unknown";
  message: string | null;
}

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    { club_id: clubId, configured: true, last_login_at: now, last_login_success: success, last_job_at: now, last_job_status: success ? "success" : "error", last_error: success ? null : message, updated_at: now },
    { onConflict: "club_id" },
  );
}

/**
 * ÉCRIT réellement sur FBI/FFBB — traite `POST .../matches/:matchId/derogation/create`
 * (demande du club, 2026-09-28 : "on a vu comment accepter ou refuser une
 * dérog, mtn faut en créer une... (sur chaque rencontre faut un bouton
 * "Créer une dérogation")... on remplit et choisi le motif, et on envoie de
 * la meme facon que pour accpter ou refuser"). SYNCHRONE (même raisonnement
 * que `respondToDerogationForClub` : une action volontaire, ponctuelle, où
 * l'admin attend une confirmation immédiate).
 *
 * "on cherche la rencontre concernée" est fait ICI, côté serveur, à partir
 * du `matchId` déjà connu (numéro + division FFBB) — jamais une recherche
 * manuelle côté UI : `BrowserFbiClient.createDerogation` recherche la ligne
 * "A Créer" correspondante sur FBI lui-même (voir sa doc).
 *
 * Journalise CHAQUE tentative dans `fbi_derogation_creations` (succès,
 * erreur, ou état indéterminé) avant de retourner — action réelle et
 * engageante envers un tiers (l'adversaire, l'organisme dirigeant), jamais
 * silencieuse même en cas d'échec, même principe que
 * `fbi_derogation_responses`.
 */
export async function createDerogationForClub(supabase: DbClient, params: CreateDerogationParams): Promise<CreateDerogationResult> {
  const { clubId, matchId, motif, modifierDate, dateDerogation, modifierHoraire, horaire, inverserRencontre, inverserEquipe, submittedBy } = params;

  const { data: match, error: matchError } = await supabase.from("matches").select("id, numero, competition_id").eq("id", matchId).eq("club_id", clubId).maybeSingle();
  if (matchError) throw new Error(`Lecture du match échouée : ${matchError.message}`);
  if (!match || !match.numero) throw notFound("Match introuvable ou sans numéro de rencontre connu.");

  const credentials = await getFbiCredentials(supabase, clubId);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant de créer une dérogation.", "FBI_NOT_CONFIGURED");

  await assertNoActiveFbiJob(supabase, clubId);

  let division: string | null = null;
  if (match.competition_id) {
    const { data: competition } = await supabase.from("competitions").select("code").eq("id", match.competition_id).maybeSingle();
    division = competition?.code ?? null;
  }

  const browser = await launchServerlessBrowser();
  const client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });
  let session: BrowserFbiSession;

  try {
    session = await client.login(credentials);
    await recordLoginOutcome(supabase, clubId, true, null);
  } catch (error) {
    const status = classifyFbiLoginStatus(error);
    const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
    await recordLoginOutcome(supabase, clubId, false, message);
    logError("Création d'une dérogation : connexion FBI échouée", error, { clubId, matchId, loginStatus: status });
    await browser.close();
    throw badRequest(`Connexion FBI impossible : ${message}`);
  }

  try {
    const result = await client.createDerogation(session, match.numero, division, {
      motif,
      modifierDate,
      dateDerogation,
      modifierHoraire,
      horaire,
      inverserRencontre,
      inverserEquipe,
    });

    if (result === null) {
      const message = "Aucune rencontre « à créer » trouvée sur FBI pour ce match (une dérogation existe peut-être déjà, ou le numéro/la division ne correspond à rien).";
      await supabase.from("fbi_derogation_creations").insert({
        club_id: clubId,
        match_id: matchId,
        motif,
        modifier_date: modifierDate,
        date_derogation: dateDerogation,
        modifier_horaire: modifierHoraire,
        horaire,
        inverser_rencontre: inverserRencontre,
        inverser_equipe: inverserEquipe,
        submitted_by: submittedBy,
        outcome: "error",
        fbi_message: message,
      });
      logInfo("Création d'une dérogation FBI : aucune rencontre 'à créer' trouvée", { clubId, matchId });
      return { outcome: "error", message };
    }

    await supabase.from("fbi_derogation_creations").insert({
      club_id: clubId,
      match_id: matchId,
      motif,
      modifier_date: modifierDate,
      date_derogation: dateDerogation,
      modifier_horaire: modifierHoraire,
      horaire,
      inverser_rencontre: inverserRencontre,
      inverser_equipe: inverserEquipe,
      submitted_by: submittedBy,
      outcome: result.outcome,
      fbi_message: result.outcome === "success" ? null : result.message,
    });

    logInfo("Création d'une dérogation FBI", { clubId, matchId, outcome: result.outcome });

    if (result.outcome === "success") {
      // Rafraîchit IMMÉDIATEMENT l'état connu depuis FBI (jamais deviné) —
      // même session déjà authentifiée, même logique d'upsert que
      // `respondToDerogationForClub`/`processCheckDerogationJob`.
      try {
        const refreshed = await client.fetchDerogationForMatch(session, match.numero, division);
        if (refreshed) {
          const now = new Date().toISOString();
          const fbiRowKey = refreshed.idDerogation ?? `${clubId}:${matchId}:${now}`;
          await supabase.from("fbi_derogation_checks").upsert(
            {
              club_id: clubId,
              match_id: matchId,
              fbi_row_key: fbiRowKey,
              id_derogation: refreshed.idDerogation,
              numero: refreshed.numero,
              etat: refreshed.etat,
              date_depot: refreshed.dateDepot,
              date_derogation: refreshed.dateDerogation,
              date_rencontre: refreshed.dateRencontre,
              heure: refreshed.heure,
              domicile: refreshed.domicile,
              visiteur: refreshed.visiteur,
              demandeur: refreshed.demandeur,
              motif: refreshed.motif,
              date_rencontre_demandee: refreshed.dateRencontreDemandee,
              heure_demandee: refreshed.heureDemandee,
              adversaire: refreshed.adversaire,
              date_reponse: refreshed.dateReponse,
              acceptation: refreshed.acceptation,
              motif_refus: refreshed.motifRefus,
              checked_at: now,
              updated_at: now,
            },
            { onConflict: "club_id,fbi_row_key" },
          );
        }
      } catch (error) {
        // Best effort : la création a bien été enregistrée sur FBI (résultat
        // déjà journalisé ci-dessus) — un échec de ce simple rafraîchissement
        // ne doit jamais faire paraître la soumission elle-même en échec.
        logError("Création d'une dérogation FBI : rafraîchissement post-soumission échoué", error, { clubId, matchId });
      }
    }

    return { outcome: result.outcome, message: result.outcome === "success" ? null : result.message };
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
