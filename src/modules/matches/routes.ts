import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, notFound } from "../../api-error.js";
import { MatchesQueryDtoSchema, type MatchListItemDto, type MatchDetailsDto } from "../../contracts/matches.js";
import { CreateDerogationDtoSchema, RespondToDerogationDtoSchema, type DerogationStatusDto } from "../../contracts/derogations.js";
import { isDerogationActionRequired } from "../derogations/action-required.js";
import { respondToDerogationForClub } from "../derogations/respond-derogation.js";
import { createDerogationForClub } from "../derogations/create-derogation.js";
import { computePeriodRange } from "../../util/timezone.js";
import { sanitizeEmarqueError } from "../../integrations/emarque/sanitize-error.js";
import type { QualityWarningDto } from "../../contracts/emarque.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { compareDerogationDateDepot } from "../../integrations/fbi/derogation-row.js";
import { checkDerogationForMatchSync } from "../derogations/check-derogation-sync.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";

export const matchesRouter = new Hono<AppEnv>();

matchesRouter.use("*", requireAuth);
matchesRouter.use("*", requireClubMembership);

const EMARQUE_STATUS_LABELS: Record<string, string> = {
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

/**
 * GET /v1/clubs/:clubId/matches — filtres et pagination (gap 7 de la
 * demande, voir `contracts/matches.ts#MatchesQueryDtoSchema`).
 *
 * `teamId` tenant-safe par construction (§20 de la demande) : la requête
 * filtre déjà sur `club_id = ce club`, donc un `teamId` d'un AUTRE club ne
 * peut jamais correspondre à une ligne `matches` de celui-ci — la réponse
 * est alors simplement une liste vide, jamais une fuite ni un statut
 * distinctif qui révélerait l'existence de l'équipe ailleurs.
 */
matchesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const query = MatchesQueryDtoSchema.safeParse(c.req.query());
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
      "id, numero, journee, match_datetime, is_home, opponent_name, opponent_logo_url, venue_raw_label, score_home, score_away, status, emarque_status, team_id",
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
    opponentName: m.opponent_name,
    opponentLogoUrl: m.opponent_logo_url,
    venueLabel: m.venue_raw_label,
    scoreHome: m.score_home,
    scoreAway: m.score_away,
    status: m.status,
    emarqueStatus: EMARQUE_STATUS_LABELS[m.emarque_status] ?? m.emarque_status,
    derogationStatus: derogationStatusByMatchId.get(m.id) ?? null,
  }));

  return c.json({ matches, pagination: { limit, offset, total: count ?? matches.length } });
});

/** GET /v1/clubs/:clubId/matches/:matchId */
matchesRouter.get("/:matchId", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const { data: match } = await supabase
    .from("matches")
    .select(
      "id, numero, journee, match_datetime, is_home, opponent_name, opponent_logo_url, venue_raw_label, score_home, score_away, status, emarque_status, team_id",
    )
    .eq("id", matchId)
    .eq("club_id", club.id)
    .maybeSingle();

  if (!match) throw notFound("Match introuvable.");

  const { data: team } = match.team_id
    ? await supabase.from("teams").select("name, sexe").eq("id", match.team_id).eq("club_id", club.id).maybeSingle()
    : { data: null };

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

  const dto: MatchDetailsDto = {
    id: match.id,
    numero: match.numero,
    journee: match.journee,
    matchDatetime: match.match_datetime,
    isHome: match.is_home,
    teamName: team ? formatTeamNameWithGender(team.name, team.sexe) : null,
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
      const participant = (row as any).match_participants;
      return {
        participantId: row.participant_id,
        teamSide: participant?.team_side ?? "home",
        jerseyNumber: participant?.jersey_number ?? null,
        firstName: participant?.first_name ?? null,
        lastName: participant?.last_name ?? null,
        licencieId: participant?.licencie_id ?? null,
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

  return c.json(dto);
});

/**
 * GET /v1/clubs/:clubId/matches/:matchId/derogation — dernier état CONNU
 * de la dérogation de ce match (voir docs/FBI.md, demande du club : "faut
 * qu'on gere les derog depuis l'outil"). `derogation: null` quand aucune
 * vérification n'a encore été lancée, OU que la dernière vérification n'a
 * trouvé aucune dérogation pour ce match — les deux cas sont normaux,
 * jamais une erreur (la grande majorité des matchs n'ont aucune dérogation).
 *
 * Une rencontre peut avoir PLUSIEURS lignes `fbi_derogation_checks` (§ "82
 * vs 51", docs/FBI.md, 2026-09-27 — jusqu'à 8 dérogations distinctes pour
 * la même rencontre) : `.maybeSingle()` échouait silencieusement dès qu'une
 * 2ᵉ ligne existait (erreur PostgREST ignorée par `const { data } = ...`),
 * affichant "aucune dérogation connue" alors qu'il y en avait bel et bien
 * une — bug confirmé par le club, 2026-09-27 : "ya une derog mais quand je
 * clique c ecrit aucune derog en cours" (match n°5009 : deux lignes réelles,
 * "En Cours" ET "Acceptée par l'organisme dirigeant"). Ce widget reste un
 * résumé compact (pas la liste complète, voir GET .../derogations pour ça).
 *
 * Round 2 du même bug (toujours le 2026-09-27, "jai pas le motif le
 * demandeur etc") : un premier correctif priorisait une dérogation
 * RÉELLEMENT "En Cours" — mais sur la rencontre n°15, la ligne "En Cours"
 * en base n'a JAMAIS eu son détail récupéré (`demandeur`/`motif`/etc tous
 * `null`), alors qu'une AUTRE ligne pour la MÊME rencontre, "Acceptée par
 * l'organisme dirigeant", a le détail complet. Priorité passée à la
 * complétude du DÉTAIL plutôt qu'à l'état.
 *
 * Round 3 (même jour) : le club revient sur ce choix — "c pas la en cours
 * qui a pris le dessus" : "En Cours" doit rester PRIORITAIRE sur tout état
 * déjà tranché, même sans détail, cohérent avec le badge coloré de la
 * liste des matchs (`derogationStatus`, "si ya accepté + en cours, c'est
 * le en cours qui prend le dessus"). La complétude du détail ne départage
 * plus qu'EN SECOND lieu : entre plusieurs lignes "En Cours" s'il y en a
 * plusieurs, ou entre les lignes déjà tranchées quand AUCUNE n'est "En
 * Cours" (c'est là que le round 2 reste utile — départager Acceptée vs
 * Refusée par leur détail). Départage final par `dateDepot` (date de dépôt
 * RÉELLE côté FBI, jamais `checked_at` qui ne reflète que l'heure de NOTRE
 * vérification), puis `checked_at`.
 */
matchesRouter.get("/:matchId/derogation", async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const { data: rows } = await c
    .get("supabase")
    .from("fbi_derogation_checks")
    .select(
      "id, numero, etat, date_depot, date_derogation, date_rencontre, heure, domicile, visiteur, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, checked_at",
    )
    .eq("club_id", club.id)
    .eq("match_id", matchId)
    .order("checked_at", { ascending: false });

  const { data: match } = await c.get("supabase").from("matches").select("is_home").eq("id", matchId).eq("club_id", club.id).maybeSingle();

  const hasDetail = (row: { demandeur: string | null; motif: string | null; date_rencontre_demandee: string | null; heure_demandee: string | null; adversaire: string | null; date_reponse: string | null; acceptation: string | null; motif_refus: string | null }): boolean =>
    Boolean(row.demandeur || row.motif || row.date_rencontre_demandee || row.heure_demandee || row.adversaire || row.date_reponse || row.acceptation || row.motif_refus);

  const enCoursRows = (rows ?? []).filter((r) => r.etat === "En Cours");
  const pool = enCoursRows.length > 0 ? enCoursRows : (rows ?? []);
  const detailedRows = pool.filter(hasDetail);
  const candidates = detailedRows.length > 0 ? detailedRows : pool;
  const data = [...candidates].sort((a, b) => compareDerogationDateDepot(b.date_depot, a.date_depot) || b.checked_at.localeCompare(a.checked_at))[0] ?? null;

  const derogation: DerogationStatusDto | null = data
    ? {
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
        checkedAt: data.checked_at,
      }
    : null;

  return c.json({ derogation });
});

/**
 * POST /v1/clubs/:clubId/matches/:matchId/derogation/respond — ÉCRIT
 * réellement sur FBI/FFBB (accepter/refuser), demande du club, 2026-09-27 :
 * "je veux le faire via loutil". Résout la MÊME dérogation que le widget
 * `GET .../derogation` ci-dessus vient d'afficher (même sélection —
 * priorité "En Cours", voir sa doc), pour que le bouton de la fiche match
 * agisse bien sur ce que l'admin vient de lire à l'écran.
 */
matchesRouter.post("/:matchId/derogation/respond", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const body = RespondToDerogationDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");

  const { data: rows } = await c
    .get("supabase")
    .from("fbi_derogation_checks")
    .select("id, etat, date_depot, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, checked_at")
    .eq("club_id", club.id)
    .eq("match_id", matchId)
    .order("checked_at", { ascending: false });

  const hasDetail = (row: { demandeur: string | null; motif: string | null; date_rencontre_demandee: string | null; heure_demandee: string | null; adversaire: string | null; date_reponse: string | null; acceptation: string | null; motif_refus: string | null }): boolean =>
    Boolean(row.demandeur || row.motif || row.date_rencontre_demandee || row.heure_demandee || row.adversaire || row.date_reponse || row.acceptation || row.motif_refus);

  const enCoursRows = (rows ?? []).filter((r) => r.etat === "En Cours");
  const pool = enCoursRows.length > 0 ? enCoursRows : (rows ?? []);
  const detailedRows = pool.filter(hasDetail);
  const candidates = detailedRows.length > 0 ? detailedRows : pool;
  const data = [...candidates].sort((a, b) => compareDerogationDateDepot(b.date_depot, a.date_depot) || b.checked_at.localeCompare(a.checked_at))[0] ?? null;

  if (!data) throw notFound("Aucune dérogation connue pour ce match.");

  const serviceSupabase = createServiceSupabaseClient();
  const result = await respondToDerogationForClub(serviceSupabase, {
    clubId: club.id,
    derogationCheckId: data.id,
    decision: body.data.decision,
    motifRefus: body.data.motifRefus ?? null,
    submittedBy: user.id,
  });

  return c.json(result);
});

/**
 * POST /v1/clubs/:clubId/matches/:matchId/derogation/check — SYNCHRONE
 * depuis 2026-09-28 ("doit y avoir rien en attente" — voir la doc de
 * `checkDerogationForMatchSync` : l'ancien modèle empilait un job
 * `fbi_jobs`, source directe de confusion quand un autre job plus ancien
 * du club se traitait à sa place). `club_admin` uniquement. LECTURE
 * SEULE : consulte l'état FBI de la dérogation, n'en soumet/modifie
 * jamais une (voir docs/FBI.md).
 */
matchesRouter.post("/:matchId/derogation/check", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const serviceSupabase = createServiceSupabaseClient();
  const result = await checkDerogationForMatchSync(serviceSupabase, { clubId: club.id, matchId });

  return c.json(result);
});

/**
 * POST /v1/clubs/:clubId/matches/:matchId/derogation/create — ÉCRIT
 * réellement sur FBI/FFBB : crée une NOUVELLE demande de dérogation pour ce
 * match (demande du club, 2026-09-28 : "sur chaque rencontre faut un bouton
 * 'Créer une dérogation'... on remplit et choisi le motif, et on envoie de
 * la meme facon que pour accpter ou refuser"). `club_admin` uniquement
 * (même verrou que `.../respond`). SYNCHRONE — voir la doc de
 * `createDerogationForClub`.
 */
matchesRouter.post("/:matchId/derogation/create", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const body = CreateDerogationDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");

  const serviceSupabase = createServiceSupabaseClient();
  const result = await createDerogationForClub(serviceSupabase, {
    clubId: club.id,
    matchId,
    motif: body.data.motif,
    modifierDate: body.data.modifierDate,
    dateDerogation: body.data.dateDerogation ?? null,
    modifierHoraire: body.data.modifierHoraire,
    horaire: body.data.horaire ?? null,
    inverserRencontre: body.data.inverserRencontre,
    inverserEquipe: body.data.inverserEquipe,
    submittedBy: user.id,
  });

  return c.json(result);
});
