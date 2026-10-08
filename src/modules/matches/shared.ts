import type { DbClient } from "../../db/client.js";
import { badRequest, notFound } from "../../api-error.js";
import { MatchesQueryDtoSchema, type MatchListItemDto, type MatchDetailsDto } from "../../contracts/matches.js";
import type { DerogationStatusDto } from "../../contracts/derogations.js";
import { isDerogationActionRequired } from "../derogations/action-required.js";
import { computePeriodRange } from "../../util/timezone.js";
import { sanitizeEmarqueError } from "../../integrations/emarque/sanitize-error.js";
import type { QualityWarningDto } from "../../contracts/emarque.js";
import { compareDerogationDateDepot } from "../../integrations/fbi/derogation-row.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";

/**
 * Moteur partagé "matchs" — extrait de `modules/matches/routes.ts` (mêmes
 * principes que `modules/tables/shared.ts`) pour être appelé IDENTIQUEMENT
 * par le routeur authentifié (`matches/routes.ts`) et par le routeur
 * public sans compte (`public-matches/routes.ts`, retour du club,
 * 2026-09-29 : "je veux une vue publique avec toutes les infos... sans
 * compte, en libre service"). Paramétré par `club: ClubRef` plutôt que par
 * `c.get("club")` : reste indépendant de la façon dont l'appelant a résolu
 * ce club (session Supabase vs slug public).
 */
export interface ClubRef {
  id: string;
  timezone: string;
}

export const EMARQUE_STATUS_LABELS: Record<string, string> = {
  not_applicable: "not_applicable",
  pending: "pending",
  waiting_for_emarque: "waiting_for_emarque",
  discovered: "discovered",
  downloading: "downloading",
  downloaded: "downloaded",
  parsing: "parsing",
  imported: "imported",
  error: "error",
  needs_review: "needs_review",
  not_available: "not_available",
};

type DerogationStatusCategory = "en_cours" | "acceptee" | "refusee";

/**
 * "acceptée" recouvre les DEUX libellés FBI réels ("...organisme
 * dirigeant" / "...deux associations sportives", voir docs/FBI.md) —
 * jamais "A Créer" (état de bruit sans vraie demande) ni un état inconnu :
 * `null` dans les deux cas, jamais une couleur devinée.
 */
const ACCEPTED_DEROGATION_ETATS = new Set(["Acceptée par l'organisme dirigeant", "Acceptée par les deux associations sportives"]);

function categorizeDerogationEtat(etat: string | null): DerogationStatusCategory | null {
  if (etat === "En Cours") return "en_cours";
  if (etat && ACCEPTED_DEROGATION_ETATS.has(etat)) return "acceptee";
  if (etat === "Refusée") return "refusee";
  return null;
}

/** "en_cours" > "acceptee" > "refusee" — demande du club, 2026-09-27 : "si ya accepté + en cours, c'est le en cours qui prend le dessus" (un match peut avoir plusieurs dérogations distinctes, § "82 vs 51"). */
const DEROGATION_STATUS_PRIORITY: Record<DerogationStatusCategory, number> = { en_cours: 0, acceptee: 1, refusee: 2 };

export interface ListMatchesResult {
  matches: MatchListItemDto[];
  pagination: { limit: number; offset: number; total: number };
}

/**
 * Filtres et pagination (gap 7 de la demande, voir
 * `contracts/matches.ts#MatchesQueryDtoSchema`). `queryParams` est le
 * résultat brut de `c.req.query()` — jamais parsé par l'appelant, pour que
 * la validation Zod (et ses messages d'erreur) reste identique entre le
 * routeur authentifié et le routeur public.
 *
 * `teamId` tenant-safe par construction (§20 de la demande) : la requête
 * filtre déjà sur `club_id = ce club`, donc un `teamId` d'un AUTRE club ne
 * peut jamais correspondre à une ligne `matches` de celui-ci.
 */
export async function listMatchesForClub(supabase: DbClient, club: ClubRef, queryParams: Record<string, string | string[] | undefined>): Promise<ListMatchesResult> {
  const query = MatchesQueryDtoSchema.safeParse(queryParams);
  if (!query.success) {
    throw badRequest(query.error.issues.map((issue) => issue.message).join(" "));
  }
  const { period, teamId, homeAway, status, limit, offset } = query.data;
  let { from, to } = query.data;

  if (period && (from || to)) {
    throw badRequest("period et from/to sont mutuellement exclusifs.");
  }
  if (period) {
    const range = computePeriodRange(period, club.timezone);
    from = range.from ?? undefined;
    to = range.to ?? undefined;
  }

  let builder = supabase
    .from("matches")
    .select(
      "id, numero, journee, match_datetime, is_home, opponent_name, opponent_logo_url, venue_raw_label, score_home, score_away, status, emarque_status, team_id, competition_id",
      { count: "exact" },
    )
    .eq("club_id", club.id);

  if (teamId) builder = builder.eq("team_id", teamId);
  if (homeAway) builder = builder.eq("is_home", homeAway === "home");
  if (status) builder = builder.eq("status", status);
  if (from) builder = builder.gte("match_datetime", from);
  if (to) builder = builder.lt("match_datetime", to);

  const { data, error, count } = await builder
    .order("match_datetime", { ascending: period !== "past" })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Lecture des matchs échouée : ${error.message}`);

  const teamIds = [...new Set((data ?? []).map((m) => m.team_id).filter((id): id is string => Boolean(id)))];
  const { data: teams } = teamIds.length
    ? await supabase.from("teams").select("id, name, sexe").eq("club_id", club.id).in("id", teamIds)
    : { data: [] };
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));

  const competitionIds = [...new Set((data ?? []).map((m) => m.competition_id).filter((id): id is string => Boolean(id)))];
  const competitionById = await loadCompetitionLabels(supabase, competitionIds);

  const matchIds = (data ?? []).map((m) => m.id);
  const { data: derogationEtats } = matchIds.length
    ? await supabase.from("fbi_derogation_checks").select("match_id, etat").eq("club_id", club.id).in("match_id", matchIds)
    : { data: [] };
  const derogationStatusByMatchId = new Map<string, DerogationStatusCategory>();
  for (const row of derogationEtats ?? []) {
    const category = categorizeDerogationEtat(row.etat);
    if (!category) continue;
    const existing = derogationStatusByMatchId.get(row.match_id);
    if (!existing || DEROGATION_STATUS_PRIORITY[category] < DEROGATION_STATUS_PRIORITY[existing]) {
      derogationStatusByMatchId.set(row.match_id, category);
    }
  }

  const matches: MatchListItemDto[] = (data ?? []).map((m) => ({
    id: m.id,
    numero: m.numero,
    journee: m.journee,
    matchDatetime: m.match_datetime,
    isHome: m.is_home,
    teamName: m.team_id ? (teamNameById.get(m.team_id) ?? null) : null,
    competitionName: m.competition_id ? (competitionById.get(m.competition_id)?.name ?? null) : null,
    categoryLabel: m.competition_id ? (competitionById.get(m.competition_id)?.categoryLabel ?? null) : null,
    opponentName: m.opponent_name,
    opponentLogoUrl: m.opponent_logo_url,
    venueLabel: m.venue_raw_label,
    scoreHome: m.score_home,
    scoreAway: m.score_away,
    status: m.status,
    emarqueStatus: EMARQUE_STATUS_LABELS[m.emarque_status] ?? m.emarque_status,
    derogationStatus: derogationStatusByMatchId.get(m.id) ?? null,
  }));

  return { matches, pagination: { limit, offset, total: count ?? matches.length } };
}

/** Détail complet d'un match — throw `notFound` si absent ou hors de ce club (jamais de distinction, §9 de la demande). */
export async function loadMatchDetails(supabase: DbClient, club: ClubRef, matchId: string, options: { includePhotos?: boolean } = {}): Promise<MatchDetailsDto> {
  const { data: match } = await supabase
    .from("matches")
    .select(
      "id, numero, journee, match_datetime, is_home, opponent_name, opponent_logo_url, venue_raw_label, score_home, score_away, status, emarque_status, team_id, competition_id",
    )
    .eq("id", matchId)
    .eq("club_id", club.id)
    .maybeSingle();

  if (!match) throw notFound("Match introuvable.");

  const { data: team } = match.team_id
    ? await supabase.from("teams").select("name, sexe").eq("id", match.team_id).eq("club_id", club.id).maybeSingle()
    : { data: null };
  const competition = match.competition_id ? (await loadCompetitionLabels(supabase, [match.competition_id])).get(match.competition_id) : undefined;

  const [{ data: participants }, { data: coaches }, { data: officials }, { data: tableOfficials }, { data: stats }, { data: documents }, { data: latestImport }] =
    await Promise.all([
      supabase
        .from("match_participants")
        .select("id, team_side, jersey_number, first_name, last_name, is_captain, is_starter, licencie_id")
        .eq("match_id", matchId)
        .eq("club_id", club.id),
      supabase.from("match_coaches").select("team_side, role, first_name, last_name, licencie_id").eq("match_id", matchId).eq("club_id", club.id),
      supabase.from("match_officials").select("role, first_name, last_name, licencie_id").eq("match_id", matchId).eq("club_id", club.id),
      supabase.from("match_table_officials").select("role, first_name, last_name, licencie_id").eq("match_id", matchId).eq("club_id", club.id),
      supabase
        .from("player_match_stats")
        .select(
          "participant_id, seconds_played, points, three_points_made, two_points_interior_made, two_points_exterior_made, free_throws_made, fouls_committed, match_participants(team_side, jersey_number, first_name, last_name, licencie_id)",
        )
        .eq("match_id", matchId)
        .eq("club_id", club.id),
      supabase.from("match_documents").select("id, source, downloaded_at").eq("match_id", matchId).eq("club_id", club.id).order("downloaded_at", { ascending: false }),
      supabase
        .from("emarque_imports")
        .select("quality_warnings, parser_version, discovered_at, imported_at, last_error")
        .eq("match_id", matchId)
        .eq("club_id", club.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  // Photos des fiches joueurs, espace club uniquement (voir PlayerMatchStatsDto.photoUrl).
  const photoByLicencieId = new Map<string, string>();
  if (options.includePhotos) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = Array.from(new Set((stats ?? []).map((row) => (row as any).match_participants?.licencie_id).filter((id): id is string => Boolean(id))));
    if (ids.length > 0) {
      const { data: photos } = await supabase.from("licencies").select("id, photo_url").eq("club_id", club.id).in("id", ids);
      for (const p of photos ?? []) if (p.photo_url) photoByLicencieId.set(p.id, p.photo_url);
    }
  }

  return {
    id: match.id,
    numero: match.numero,
    journee: match.journee,
    matchDatetime: match.match_datetime,
    isHome: match.is_home,
    teamName: team ? formatTeamNameWithGender(team.name, team.sexe) : null,
    competitionName: competition?.name ?? null,
    categoryLabel: competition?.categoryLabel ?? null,
    opponentName: match.opponent_name,
    opponentLogoUrl: match.opponent_logo_url,
    venueLabel: match.venue_raw_label,
    scoreHome: match.score_home,
    scoreAway: match.score_away,
    status: match.status,
    emarque: {
      status: EMARQUE_STATUS_LABELS[match.emarque_status] ?? match.emarque_status,
      source: documents && documents.length > 0 ? documents[0]!.source.toUpperCase() : null,
      lastRetrievedAt: documents?.[0]?.downloaded_at ?? null,
      qualityWarningCount: Array.isArray(latestImport?.quality_warnings) ? latestImport.quality_warnings.length : null,
      parserVersion: latestImport?.parser_version ?? null,
      discoveredAt: latestImport?.discovered_at ?? null,
      importedAt: latestImport?.imported_at ?? null,
      qualityWarnings: Array.isArray(latestImport?.quality_warnings) ? (latestImport.quality_warnings as QualityWarningDto[]) : [],
      lastError: sanitizeEmarqueError(latestImport?.last_error ?? null),
    },
    participants: (participants ?? []).map((p) => ({
      id: p.id,
      teamSide: p.team_side,
      jerseyNumber: p.jersey_number,
      firstName: p.first_name,
      lastName: p.last_name,
      isCaptain: p.is_captain,
      isStarter: p.is_starter,
      licencieId: p.licencie_id,
    })),
    coaches: (coaches ?? []).map((coach) => ({
      teamSide: coach.team_side,
      role: coach.role,
      firstName: coach.first_name,
      lastName: coach.last_name,
      licencieId: coach.licencie_id,
    })),
    officials: (officials ?? []).map((o) => ({ role: o.role, firstName: o.first_name, lastName: o.last_name, licencieId: o.licencie_id })),
    tableOfficials: (tableOfficials ?? []).map((o) => ({ role: o.role, firstName: o.first_name, lastName: o.last_name, licencieId: o.licencie_id })),
    stats: (stats ?? []).map((row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const licencieId: string | null = (row as any).match_participants?.licencie_id ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const participant = (row as any).match_participants;
      return {
        participantId: row.participant_id,
        teamSide: participant?.team_side ?? "home",
        jerseyNumber: participant?.jersey_number ?? null,
        firstName: participant?.first_name ?? null,
        lastName: participant?.last_name ?? null,
        licencieId: participant?.licencie_id ?? null,
        photoUrl: licencieId ? (photoByLicencieId.get(licencieId) ?? null) : null,
        secondsPlayed: row.seconds_played,
        points: row.points,
        threePointsMade: row.three_points_made,
        twoPointsInteriorMade: row.two_points_interior_made,
        twoPointsExteriorMade: row.two_points_exterior_made,
        freeThrowsMade: row.free_throws_made,
        foulsCommitted: row.fouls_committed,
      };
    }),
  };
}

/**
 * Dernier état CONNU de la dérogation d'un match — voir la doc détaillée
 * (priorité "En Cours", puis complétude du détail, puis `dateDepot`) sur
 * la route `GET /v1/clubs/:clubId/matches/:matchId/derogation` d'origine
 * dans `matches/routes.ts`. Lecture seule — jamais d'écriture FBI ici,
 * contrairement à `.../derogation/respond` et `.../derogation/create`
 * (`club_admin` uniquement, restent dans `matches/routes.ts`, jamais
 * exposées au routeur public).
 */
export async function resolveDerogationStatus(supabase: DbClient, club: ClubRef, matchId: string): Promise<DerogationStatusDto | null> {
  const { data: rows } = await supabase
    .from("fbi_derogation_checks")
    .select(
      "id, numero, etat, date_depot, date_derogation, date_rencontre, heure, domicile, visiteur, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, modifier_date, modifier_horaire, modifier_salle, salle_demandee, inverser_rencontre, inverser_equipe, checked_at",
    )
    .eq("club_id", club.id)
    .eq("match_id", matchId)
    .order("checked_at", { ascending: false });

  const { data: match } = await supabase.from("matches").select("is_home").eq("id", matchId).eq("club_id", club.id).maybeSingle();

  const hasDetail = (row: { demandeur: string | null; motif: string | null; date_rencontre_demandee: string | null; heure_demandee: string | null; adversaire: string | null; date_reponse: string | null; acceptation: string | null; motif_refus: string | null }): boolean =>
    Boolean(row.demandeur || row.motif || row.date_rencontre_demandee || row.heure_demandee || row.adversaire || row.date_reponse || row.acceptation || row.motif_refus);

  const enCoursRows = (rows ?? []).filter((r) => r.etat === "En Cours");
  const pool = enCoursRows.length > 0 ? enCoursRows : (rows ?? []);
  const detailedRows = pool.filter(hasDetail);
  const candidates = detailedRows.length > 0 ? detailedRows : pool;
  const data = [...candidates].sort((a, b) => compareDerogationDateDepot(b.date_depot, a.date_depot) || b.checked_at.localeCompare(a.checked_at))[0] ?? null;

  if (!data) return null;

  return {
    id: data.id,
    actionRequired: isDerogationActionRequired({ etat: data.etat, demandeur: data.demandeur, isHome: match?.is_home ?? null }),
    numero: data.numero,
    etat: data.etat,
    dateDepot: data.date_depot,
    dateDerogation: data.date_derogation,
    dateRencontre: data.date_rencontre,
    heure: data.heure,
    domicile: data.domicile,
    visiteur: data.visiteur,
    demandeur: data.demandeur,
    motif: data.motif,
    dateRencontreDemandee: data.date_rencontre_demandee,
    heureDemandee: data.heure_demandee,
    adversaire: data.adversaire,
    dateReponse: data.date_reponse,
    acceptation: data.acceptation,
    motifRefus: data.motif_refus,
    modifierDate: data.modifier_date,
    modifierHoraire: data.modifier_horaire,
    modifierSalle: data.modifier_salle,
    salleDemandee: data.salle_demandee,
    inverserRencontre: data.inverser_rencontre,
    inverserEquipe: data.inverser_equipe,
    checkedAt: data.checked_at,
  };
}

/**
 * Nom + catégorie des compétitions FFBB (table de référence partagée, sans
 * `club_id` — les ids viennent toujours de matchs déjà filtrés sur le club).
 * Une lecture en échec n'empêche jamais l'affichage des matchs : map vide.
 */
async function loadCompetitionLabels(supabase: DbClient, ids: string[]): Promise<Map<string, { name: string | null; categoryLabel: string | null }>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase.from("competitions").select("id, name, category_label").in("id", ids);
  return new Map((data ?? []).map((c) => [c.id, { name: c.name ?? null, categoryLabel: c.category_label ?? null }]));
}
