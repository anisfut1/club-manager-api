import type { DbClient } from "../../db/client.js";
import type { DerogationListItemDto } from "../../contracts/derogations.js";
import { findScheduleConflict, type OtherMatchSlot } from "./schedule-conflict.js";
import { isDerogationActionRequired } from "./action-required.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";

/** Refusée : la date/heure demandée n'a jamais pris effet, jamais un vrai conflit de créneau à signaler. */
const ETATS_SANS_ALERTE_CONFLIT = new Set(["Refusée"]);

/**
 * Liste complète des dérogations connues d'un club (dernier état par match),
 * enrichie — partagée entre la route authentifiée ci-dessous et la vue
 * publique par lien personnel réservée aux licenciés club_admin (voir
 * modules/public-tables/routes.ts). Le `supabase` passé décide de la portée :
 * client scopé utilisateur (RLS) ici, client service côté public — où c'est
 * alors le code appelant qui garantit le club et le rôle.
 */
export async function loadClubDerogations(supabase: DbClient, clubId: string): Promise<DerogationListItemDto[]> {
  const { data: checks, error } = await supabase
    .from("fbi_derogation_checks")
    .select(
      "id, match_id, numero, etat, date_depot, date_derogation, date_rencontre, heure, domicile, visiteur, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, modifier_date, modifier_horaire, modifier_salle, salle_demandee, inverser_rencontre, inverser_equipe, checked_at",
    )
    .eq("club_id", clubId)
    .order("checked_at", { ascending: false });

  if (error) throw new Error(`Lecture des dérogations échouée : ${error.message}`);

  const matchIds = (checks ?? []).map((row) => row.match_id);
  const { data: matches } = matchIds.length
    ? await supabase.from("matches").select("id, numero, opponent_name, match_datetime, competition_id, team_id, is_home").in("id", matchIds)
    : { data: [] };
  const matchById = new Map((matches ?? []).map((m) => [m.id, m]));

  const competitionIds = [...new Set((matches ?? []).map((m) => m.competition_id).filter((id): id is string => id !== null))];
  const { data: competitions } = competitionIds.length
    ? await supabase.from("competitions").select("id, category_label").in("id", competitionIds)
    : { data: [] };
  const categoryLabelByCompetitionId = new Map((competitions ?? []).map((c) => [c.id, c.category_label]));

  // TOUS les matchs À DOMICILE déjà programmés du club (pas seulement ceux
  // ayant une dérogation) — nécessaire pour détecter si la date/heure
  // DEMANDÉE par une dérogation chevauche le créneau (2h) d'un AUTRE match
  // déjà prévu (demande du club, 2026-09-26 : "il faut aussi avoir des
  // alertes..."). UNIQUEMENT les matchs à domicile des deux côtés (demande
  // du club, 2026-09-27 : "palavas sete c un match a lextérieur. donc il ny
  // a pas de conflit... si ya 1 match domicile 1 extérieur meme heure c pas
  // un soucis") — seul un match À DOMICILE occupe une salle DU CLUB, un
  // match à l'extérieur se joue chez l'adversaire et ne peut jamais entrer
  // en conflit de créneau avec un autre match du club (même raisonnement
  // que `venue-conflicts.ts` pour la page Anomalies).
  const { data: scheduledMatches } = await supabase
    .from("matches")
    .select("id, numero, opponent_name, match_datetime, is_home, team_id")
    .eq("club_id", clubId)
    .eq("is_home", true)
    .neq("status", "cancelled");

  // Le club a PLUSIEURS équipes dans une même catégorie (demande du club,
  // 2026-09-26 : "faut préciser quelle équipe, seniors ya 4 equipes SM1
  // SM2 SM3 SF, pareil sur dautres catégories") — `category_label` seul
  // ("Seniors") ne les distingue pas, `teams.name` ("Seniors 1 M",
  // "Seniors 2"...) si. Même besoin pour le bandeau de conflit de créneau
  // (demande du club, 2026-09-27 : "faut dire aussi c le match de quelle
  // equipe en conflit") — équipes des matchs AYANT une dérogation ET des
  // matchs candidats au conflit rassemblées en une seule requête.
  const teamIds = [
    ...new Set([...(matches ?? []).map((m) => m.team_id), ...(scheduledMatches ?? []).map((m) => m.team_id)].filter((id): id is string => id !== null)),
  ];
  const { data: teams } = teamIds.length ? await supabase.from("teams").select("id, name, sexe").in("id", teamIds) : { data: [] };
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));

  const otherMatchSlots: OtherMatchSlot[] = (scheduledMatches ?? [])
    .filter((m): m is typeof m & { match_datetime: string } => m.match_datetime !== null)
    .map((m) => ({
      id: m.id,
      numero: m.numero,
      opponentName: m.opponent_name,
      matchDatetime: m.match_datetime,
      teamName: m.team_id ? (teamNameById.get(m.team_id) ?? null) : null,
    }));

  const derogations: DerogationListItemDto[] = (checks ?? []).map((row) => {
    const match = matchById.get(row.match_id);
    const scheduleConflict =
      match?.is_home === true && !(row.etat && ETATS_SANS_ALERTE_CONFLIT.has(row.etat))
        ? findScheduleConflict(row.date_rencontre_demandee, row.heure_demandee, row.match_id, otherMatchSlots)
        : null;
    return {
      id: row.id,
      matchId: row.match_id,
      numero: row.numero,
      opponentName: match?.opponent_name ?? null,
      matchDatetime: match?.match_datetime ?? null,
      categoryLabel: match?.competition_id ? categoryLabelByCompetitionId.get(match.competition_id) ?? null : null,
      teamName: match?.team_id ? teamNameById.get(match.team_id) ?? null : null,
      scheduleConflict,
      actionRequired: isDerogationActionRequired({ etat: row.etat, demandeur: row.demandeur, isHome: match?.is_home ?? null }),
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
      modifierDate: row.modifier_date,
      modifierHoraire: row.modifier_horaire,
      modifierSalle: row.modifier_salle,
      salleDemandee: row.salle_demandee,
      inverserRencontre: row.inverser_rencontre,
      inverserEquipe: row.inverser_equipe,
      checkedAt: row.checked_at,
    };
  });

  return derogations;
}
