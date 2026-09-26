import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import type { DerogationListItemDto } from "../../contracts/derogations.js";
import { findScheduleConflict, type OtherMatchSlot } from "./schedule-conflict.js";

/** Refusée : la date/heure demandée n'a jamais pris effet, jamais un vrai conflit de créneau à signaler. */
const ETATS_SANS_ALERTE_CONFLIT = new Set(["Refusée"]);

export const derogationsRouter = new Hono<AppEnv>();

derogationsRouter.use("*", requireAuth);
derogationsRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/derogations — TOUTES les dérogations connues du
 * club (dernier état par match), enrichies du numéro/adversaire/date/
 * catégorie/équipe du club du match FFBB correspondant — pour la page
 * "Vérifier toutes les dérogations" (demande du club, voir docs/FBI.md : "je veux un bouton
 * global qui check toutes les demandes, pas match par match"). Silencieux
 * (liste vide) pour un club sans FBI configuré, ou n'ayant jamais lancé de
 * vérification — jamais une erreur.
 *
 * `club_admin` uniquement : c'est aussi ce que la policy RLS
 * `fbi_derogation_checks_select_club_admin` autorise déjà en lecture (voir
 * migration 20260925130000) — un simple membre obtiendrait de toute façon
 * une liste vide via `c.get("supabase")` (client scopé utilisateur, jamais
 * la clé service ici), donc autoriser la route à tout membre serait
 * silencieusement trompeur. Cohérent avec /admin/derogations côté SCSB,
 * déjà réservée aux club_admin.
 */
derogationsRouter.get("/", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const { data: checks, error } = await supabase
    .from("fbi_derogation_checks")
    .select(
      "id, match_id, numero, etat, date_depot, date_derogation, date_rencontre, heure, domicile, visiteur, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, checked_at",
    )
    .eq("club_id", club.id)
    .order("checked_at", { ascending: false });

  if (error) throw new Error(`Lecture des dérogations échouée : ${error.message}`);

  const matchIds = (checks ?? []).map((row) => row.match_id);
  const { data: matches } = matchIds.length
    ? await supabase.from("matches").select("id, numero, opponent_name, match_datetime, competition_id, team_id").in("id", matchIds)
    : { data: [] };
  const matchById = new Map((matches ?? []).map((m) => [m.id, m]));

  const competitionIds = [...new Set((matches ?? []).map((m) => m.competition_id).filter((id): id is string => id !== null))];
  const { data: competitions } = competitionIds.length
    ? await supabase.from("competitions").select("id, category_label").in("id", competitionIds)
    : { data: [] };
  const categoryLabelByCompetitionId = new Map((competitions ?? []).map((c) => [c.id, c.category_label]));

  // Le club a PLUSIEURS équipes dans une même catégorie (demande du club,
  // 2026-09-26 : "faut préciser quelle équipe, seniors ya 4 equipes SM1
  // SM2 SM3 SF, pareil sur dautres catégories") — `category_label` seul
  // ("Seniors") ne les distingue pas, `teams.name` ("Seniors 1 M",
  // "Seniors 2"...) si.
  const teamIds = [...new Set((matches ?? []).map((m) => m.team_id).filter((id): id is string => id !== null))];
  const { data: teams } = teamIds.length ? await supabase.from("teams").select("id, name").in("id", teamIds) : { data: [] };
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, t.name]));

  // TOUS les matchs déjà programmés du club (pas seulement ceux ayant une
  // dérogation) — nécessaire pour détecter si la date/heure DEMANDÉE par
  // une dérogation chevauche le créneau (2h) d'un AUTRE match déjà prévu
  // (demande du club, 2026-09-26 : "il faut aussi avoir des alertes...").
  const { data: scheduledMatches } = await supabase.from("matches").select("id, numero, opponent_name, match_datetime").eq("club_id", club.id).neq("status", "cancelled");
  const otherMatchSlots: OtherMatchSlot[] = (scheduledMatches ?? [])
    .filter((m): m is typeof m & { match_datetime: string } => m.match_datetime !== null)
    .map((m) => ({ id: m.id, numero: m.numero, opponentName: m.opponent_name, matchDatetime: m.match_datetime }));

  const derogations: DerogationListItemDto[] = (checks ?? []).map((row) => {
    const match = matchById.get(row.match_id);
    const scheduleConflict =
      row.etat && ETATS_SANS_ALERTE_CONFLIT.has(row.etat)
        ? null
        : findScheduleConflict(row.date_rencontre_demandee, row.heure_demandee, row.match_id, otherMatchSlots);
    return {
      id: row.id,
      matchId: row.match_id,
      numero: row.numero,
      opponentName: match?.opponent_name ?? null,
      matchDatetime: match?.match_datetime ?? null,
      categoryLabel: match?.competition_id ? categoryLabelByCompetitionId.get(match.competition_id) ?? null : null,
      teamName: match?.team_id ? teamNameById.get(match.team_id) ?? null : null,
      scheduleConflict,
      etat: row.etat,
      dateDepot: row.date_depot,
      dateDerogation: row.date_derogation,
      dateRencontre: row.date_rencontre,
      heure: row.heure,
      domicile: row.domicile,
      visiteur: row.visiteur,
      demandeur: row.demandeur,
      motif: row.motif,
      dateRencontreDemandee: row.date_rencontre_demandee,
      heureDemandee: row.heure_demandee,
      adversaire: row.adversaire,
      dateReponse: row.date_reponse,
      acceptation: row.acceptation,
      motifRefus: row.motif_refus,
      checkedAt: row.checked_at,
    };
  });

  return c.json({ derogations });
});
