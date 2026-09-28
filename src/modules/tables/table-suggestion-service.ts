import { intervalsOverlap, type TimeWindow } from "./match-window.js";
import {
  PRIORITY_TIER_ORDER,
  SUGGESTION_SCORE,
  type PriorityTier,
  type SuggestionEligibility,
  type SuggestionReasonCode,
  type TableAssignmentRole,
  type UnavailableReasonCode,
} from "./suggestion-policy.js";

/**
 * TableSuggestionService — moteur d'éligibilité/classement des Tables de
 * marque (§34/§35 de la demande). ENTIÈREMENT PUR : aucun accès Supabase,
 * aucune horloge ambiante (`Date.now()` jamais appelé ici) — toutes les
 * données (licenciés candidats, matchs de leurs équipes, affectations déjà
 * existantes, compteurs d'équité) sont déjà résolues par l'appelant
 * (`modules/tables/routes.ts`), qui fait le travail Supabase puis délègue
 * TOUT le calcul ici. C'est ce qui rend `computeTableSuggestions` testable
 * unitairement sans base de données (§35, voir table-suggestion-service.test.ts).
 *
 * PRINCIPE À NE JAMAIS PERDRE : ce module ne CRÉE jamais de ligne
 * `table_assignments`. Il calcule des suggestions, jamais des affectations
 * — "LE LOGICIEL SUGGÈRE. LE RESPONSABLE DÉCIDE." (voir la route PUT, seule
 * autrice d'une affectation réelle).
 */

export interface LicencieCandidateInput {
  licencieId: string;
  firstName: string;
  lastName: string;
  /**
   * Équipe(s) de ce licencié — aujourd'hui `licencies.team_id` est une SEULE
   * équipe optionnelle (jamais un rattachement multiple, voir l'audit
   * docs/TABLE_ASSIGNMENTS.md), donc ce tableau contient 0 ou 1 élément en
   * pratique. Représenté en tableau dès maintenant pour que le moteur
   * n'ait RIEN à changer le jour où un licencié pourra être rattaché à
   * plusieurs équipes (§8 de la demande : "prendre TOUS ses matchs en
   * compte" — déjà vrai ici, `teamMatches` est simplement filtré sur
   * `teamIds.includes(occurrence.teamId)`, quel que soit le nombre
   * d'équipes).
   */
  teamIds: string[];
  teamNames: Map<string, string>;
}

/**
 * Une occurrence de match (domicile OU extérieur) pour UNE équipe du club,
 * dans la fenêtre temporelle pertinente (même jour calendaire que le match
 * cible — filtrage laissé à l'appelant, ce module n'a pas d'opinion sur la
 * plage de dates). Le match CIBLE lui-même doit être inclus ici pour
 * l'équipe qui le joue : c'est ce qui fait émerger naturellement le
 * conflit "l'équipe qui joue ce match est indisponible" (§9 de la
 * demande : "ne hardcode pas... si le calcul de calendrier suffit") — deux
 * fenêtres identiques se chevauchent toujours par construction.
 */
export interface TeamMatchOccurrence {
  matchId: string;
  teamId: string;
  isHome: boolean;
  window: TimeWindow;
  venueRawLabel: string | null;
  /** Libellé humain de l'adversaire, pour le texte de raison ("Match extérieur avec U13F à 16:00" cite l'équipe DU LICENCIÉ, pas l'adversaire — voir buildMatchConflictReason). */
  opponentName: string | null;
}

/** Une affectation de table déjà existante (n'importe quel match du club, même jour) — sert à détecter les conflits de table ET l'affectation déjà en place sur le match cible. */
export interface ExistingAssignmentOccurrence {
  matchId: string;
  role: TableAssignmentRole;
  licencieId: string;
  window: TimeWindow;
}

export interface SuggestionReason {
  code: SuggestionReasonCode;
  label: string;
}

export interface UnavailabilityReason {
  code: UnavailableReasonCode;
  reason: string;
  conflictingMatchId: string | null;
}

export interface RankedCandidate {
  licencieId: string;
  firstName: string;
  lastName: string;
  teamIds: string[];
  eligibility: Extract<SuggestionEligibility, "RECOMMENDED" | "POTENTIALLY_AVAILABLE">;
  priorityTier: PriorityTier;
  /** Cosmétique uniquement (§22) — ne JAMAIS l'utiliser pour trier ailleurs que dans ce module, `rankCandidates` trie déjà par comparateur explicite. */
  score: number;
  reasons: SuggestionReason[];
  seasonAssignmentCount: number;
  sameDayAssignmentCount: number;
  /** Vrai si ce licencié occupe DÉJÀ le rôle demandé sur le match cible (§77 : "l'actuelle apparaît clairement comme Affecté actuellement"). */
  isCurrentHolder: boolean;
}

export interface UnavailableCandidate {
  licencieId: string;
  firstName: string;
  lastName: string;
  teamIds: string[];
  eligibility: "UNAVAILABLE";
  reasonCode: UnavailableReasonCode;
  reason: string;
  conflictingMatchId: string | null;
}

export interface TableSuggestionEngineInput {
  targetMatchId: string;
  targetRole: TableAssignmentRole;
  targetWindow: TimeWindow;
  targetVenueRawLabel: string | null;
  /** Fuseau du club (§2 de la demande, ARCHITECTURE.md) — utilisé UNIQUEMENT pour formater les heures dans les raisons humaines (Intl.DateTimeFormat avec timeZone explicite : déterministe, reste une fonction pure). */
  clubTimezone: string;
  candidates: LicencieCandidateInput[];
  teamMatches: TeamMatchOccurrence[];
  existingTableAssignments: ExistingAssignmentOccurrence[];
  seasonAssignmentCountByLicencieId: Map<string, number>;
  todayAssignmentCountByLicencieId: Map<string, number>;
}

export interface TableSuggestionsResult {
  recommended: RankedCandidate[];
  available: RankedCandidate[];
  unavailable: UnavailableCandidate[];
}

function formatTimeInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function normalizeVenueForComparison(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function sameVenue(a: string | null, b: string | null): boolean {
  const na = normalizeVenueForComparison(a);
  const nb = normalizeVenueForComparison(b);
  return na.length > 0 && na === nb;
}

/**
 * Vérifie l'ALIGNEMENT "ALREADY_ASSIGNED_ON_MATCH" (§11/§17) : ce licencié
 * occupe-t-il déjà un AUTRE rôle sur CE match ? Retourne aussi
 * `isCurrentHolder` (déjà titulaire du rôle DEMANDÉ — pas un conflit, voir
 * `RankedCandidate.isCurrentHolder`).
 */
function findExistingAssignmentOnTargetMatch(
  licencieId: string,
  input: Pick<TableSuggestionEngineInput, "targetMatchId" | "targetRole" | "existingTableAssignments">,
): { otherRole: ExistingAssignmentOccurrence | null; isCurrentHolder: boolean } {
  const onTarget = input.existingTableAssignments.filter((a) => a.matchId === input.targetMatchId && a.licencieId === licencieId);
  const currentHolder = onTarget.find((a) => a.role === input.targetRole) ?? null;
  const otherRole = onTarget.find((a) => a.role !== input.targetRole) ?? null;
  return { otherRole, isCurrentHolder: currentHolder !== null };
}

/**
 * Cherche, parmi les matchs À DOMICILE des équipes du candidat, le plus
 * proche qui ne chevauche PAS la fenêtre cible et se situe APRÈS
 * (`direction: "next"`) ou AVANT (`direction: "previous"`) celle-ci (§12/
 * §13). "Adjacent" est interprété au sens large (pas seulement un
 * enchaînement exact 17:00→17:00) : le match HOME le plus proche dans
 * cette direction, quel que soit l'écart réel — c'est à l'appelant de ne
 * fournir que les matchs du même jour calendaire pour que ce classement
 * reste pertinent (voir la doc de `TeamMatchOccurrence`).
 */
function findClosestAdjacentHomeMatch(teamIds: string[], teamMatches: TeamMatchOccurrence[], targetWindow: TimeWindow, direction: "next" | "previous"): TeamMatchOccurrence | null {
  const candidates = teamMatches.filter((occurrence) => {
    if (!occurrence.isHome) return false;
    if (!teamIds.includes(occurrence.teamId)) return false;
    if (intervalsOverlap(occurrence.window.start, occurrence.window.end, targetWindow.start, targetWindow.end)) return false;
    return direction === "next" ? occurrence.window.start >= targetWindow.end : occurrence.window.end <= targetWindow.start;
  });

  if (candidates.length === 0) return null;

  return candidates.reduce((closest, current) => {
    const closestDistanceMs = direction === "next" ? closest.window.start.getTime() - targetWindow.end.getTime() : targetWindow.start.getTime() - closest.window.end.getTime();
    const currentDistanceMs = direction === "next" ? current.window.start.getTime() - targetWindow.end.getTime() : targetWindow.start.getTime() - current.window.end.getTime();
    return currentDistanceMs < closestDistanceMs ? current : closest;
  });
}

/**
 * determineEligibility (§34/§35) — conflits DURS, dans cet ordre de
 * détection : déjà affecté à un AUTRE rôle sur ce match, puis son propre
 * match (l'équipe qui joue CE match ressort naturellement ici, §9), puis
 * une AUTRE table déjà affectée qui chevauche. `null` = aucun conflit dur.
 */
export function determineEligibility(candidate: LicencieCandidateInput, input: TableSuggestionEngineInput): UnavailabilityReason | null {
  const { otherRole } = findExistingAssignmentOnTargetMatch(candidate.licencieId, input);
  if (otherRole) {
    return { code: "ALREADY_ASSIGNED_ON_MATCH", reason: `Déjà affecté·e comme ${ROLE_LABELS[otherRole.role]} sur ce match`, conflictingMatchId: otherRole.matchId };
  }

  const matchConflict = input.teamMatches.find(
    (occurrence) => candidate.teamIds.includes(occurrence.teamId) && intervalsOverlap(occurrence.window.start, occurrence.window.end, input.targetWindow.start, input.targetWindow.end),
  );
  if (matchConflict) {
    const teamName = candidate.teamNames.get(matchConflict.teamId) ?? "son équipe";
    const time = formatTimeInTimezone(matchConflict.window.start, input.clubTimezone);
    const label = matchConflict.isHome ? "à domicile" : "extérieur";
    return { code: "MATCH_CONFLICT", reason: `Match ${label} avec ${teamName} à ${time}`, conflictingMatchId: matchConflict.matchId };
  }

  const tableConflict = input.existingTableAssignments.find(
    (assignment) =>
      assignment.licencieId === candidate.licencieId &&
      assignment.matchId !== input.targetMatchId &&
      intervalsOverlap(assignment.window.start, assignment.window.end, input.targetWindow.start, input.targetWindow.end),
  );
  if (tableConflict) {
    const time = formatTimeInTimezone(tableConflict.window.start, input.clubTimezone);
    return { code: "TABLE_ASSIGNMENT_CONFLICT", reason: `Déjà affecté·e à une autre table à ${time}`, conflictingMatchId: tableConflict.matchId };
  }

  return null;
}

const ROLE_LABELS: Record<TableAssignmentRole, string> = { SCORER: "marqueur", TIMEKEEPER: "chronométreur", CLUB_DELEGATE: "délégué de club", REFEREE: "arbitre" };

/**
 * determinePriorityTier (§12/§13/§22) — ADJACENT_NEXT_HOME (l'équipe joue
 * juste après, priorité 1) > ADJACENT_PREVIOUS_HOME (vient de jouer,
 * priorité 2) > AVAILABLE_OTHER (aucune proximité particulière). Renvoie
 * aussi le match adjacent retenu (pour les raisons ET le bonus de lieu).
 */
export function determinePriorityTier(candidate: LicencieCandidateInput, input: TableSuggestionEngineInput): { tier: PriorityTier; adjacentMatch: TeamMatchOccurrence | null } {
  const next = findClosestAdjacentHomeMatch(candidate.teamIds, input.teamMatches, input.targetWindow, "next");
  if (next) return { tier: "ADJACENT_NEXT_HOME", adjacentMatch: next };

  const previous = findClosestAdjacentHomeMatch(candidate.teamIds, input.teamMatches, input.targetWindow, "previous");
  if (previous) return { tier: "ADJACENT_PREVIOUS_HOME", adjacentMatch: previous };

  return { tier: "AVAILABLE_OTHER", adjacentMatch: null };
}

/** buildSuggestionReasons (§19/§38) — raisons humaines, l'historique de tables toujours en dernier (information, pas un argument de tri). */
export function buildSuggestionReasons(
  tier: PriorityTier,
  adjacentMatch: TeamMatchOccurrence | null,
  targetVenueRawLabel: string | null,
  clubTimezone: string,
  seasonAssignmentCount: number,
): SuggestionReason[] {
  const reasons: SuggestionReason[] = [];

  if (adjacentMatch) {
    const time = formatTimeInTimezone(adjacentMatch.window.start, clubTimezone);
    if (tier === "ADJACENT_NEXT_HOME") reasons.push({ code: "NEXT_HOME_MATCH", label: `Joue juste après à ${time}` });
    else if (tier === "ADJACENT_PREVIOUS_HOME") reasons.push({ code: "PREVIOUS_HOME_MATCH", label: `Vient de jouer à ${time}` });

    if (sameVenue(adjacentMatch.venueRawLabel, targetVenueRawLabel)) reasons.push({ code: "SAME_VENUE", label: "Même gymnase" });
  }

  reasons.push({ code: "SEASON_DUTY_COUNT", label: seasonAssignmentCount === 0 ? "Aucune table cette saison" : seasonAssignmentCount === 1 ? "1 table cette saison" : `${seasonAssignmentCount} tables cette saison` });

  return reasons;
}

/** Score cosmétique (§22/§23) — dérivé du tier + bonus déjà utilisés par le tri, jamais une arithmétique indépendante. */
function computeCosmeticScore(tier: PriorityTier, adjacentMatch: TeamMatchOccurrence | null, targetVenueRawLabel: string | null, seasonAssignmentCount: number, sameDayAssignmentCount: number): number {
  let score = SUGGESTION_SCORE.TIER_BASE[tier];
  if (adjacentMatch) score += sameVenue(adjacentMatch.venueRawLabel, targetVenueRawLabel) ? SUGGESTION_SCORE.SAME_VENUE_BONUS : SUGGESTION_SCORE.DIFFERENT_VENUE_BONUS;
  score -= seasonAssignmentCount * SUGGESTION_SCORE.FAIRNESS_PENALTY_PER_SEASON_ASSIGNMENT;
  score -= sameDayAssignmentCount * SUGGESTION_SCORE.SAME_DAY_PENALTY_PER_ASSIGNMENT;
  return Math.max(0, Math.round(score));
}

/**
 * rankCandidates (§21/§24) — comparateur EXPLICITE multi-clés, jamais une
 * soustraction de scores : 1) tier (règle métier) 2) bonus de lieu (même
 * gymnase d'abord, §14) 3) équité (moins de tables cette saison d'abord,
 * §20) 4) moins de tables aujourd'hui d'abord 5) tie-break déterministe
 * (nom, prénom, id — §24 : "à données identiques, ordre identique").
 */
export function rankCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  return [...candidates].sort((a, b) => {
    if (PRIORITY_TIER_ORDER[a.priorityTier] !== PRIORITY_TIER_ORDER[b.priorityTier]) return PRIORITY_TIER_ORDER[a.priorityTier] - PRIORITY_TIER_ORDER[b.priorityTier];
    const aSameVenue = a.reasons.some((r) => r.code === "SAME_VENUE") ? 0 : 1;
    const bSameVenue = b.reasons.some((r) => r.code === "SAME_VENUE") ? 0 : 1;
    if (aSameVenue !== bSameVenue) return aSameVenue - bSameVenue;
    if (a.seasonAssignmentCount !== b.seasonAssignmentCount) return a.seasonAssignmentCount - b.seasonAssignmentCount;
    if (a.sameDayAssignmentCount !== b.sameDayAssignmentCount) return a.sameDayAssignmentCount - b.sameDayAssignmentCount;
    const lastNameCompare = a.lastName.localeCompare(b.lastName, "fr");
    if (lastNameCompare !== 0) return lastNameCompare;
    const firstNameCompare = a.firstName.localeCompare(b.firstName, "fr");
    if (firstNameCompare !== 0) return firstNameCompare;
    return a.licencieId.localeCompare(b.licencieId);
  });
}

/**
 * computeTableSuggestions — orchestrateur PUR de tout le module (§19/§34) :
 * répartit chaque candidat entre `recommended`/`available`/`unavailable`
 * (§39, jamais mélangés dans un seul classement) et trie les deux premiers
 * groupes selon `rankCandidates`. N'écrit RIEN, ne lit RIEN — reçoit tout
 * en entrée, renvoie tout en sortie (§57 : garantit qu'un appel de ce
 * module ne peut, PAR CONSTRUCTION, jamais créer d'affectation).
 */
export function computeTableSuggestions(input: TableSuggestionEngineInput): TableSuggestionsResult {
  const recommended: RankedCandidate[] = [];
  const available: RankedCandidate[] = [];
  const unavailable: UnavailableCandidate[] = [];

  for (const candidate of input.candidates) {
    const conflict = determineEligibility(candidate, input);
    if (conflict) {
      unavailable.push({
        licencieId: candidate.licencieId,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        teamIds: candidate.teamIds,
        eligibility: "UNAVAILABLE",
        reasonCode: conflict.code,
        reason: conflict.reason,
        conflictingMatchId: conflict.conflictingMatchId,
      });
      continue;
    }

    const { isCurrentHolder } = findExistingAssignmentOnTargetMatch(candidate.licencieId, input);
    const { tier, adjacentMatch } = determinePriorityTier(candidate, input);
    const seasonAssignmentCount = input.seasonAssignmentCountByLicencieId.get(candidate.licencieId) ?? 0;
    const sameDayAssignmentCount = input.todayAssignmentCountByLicencieId.get(candidate.licencieId) ?? 0;
    const reasons = buildSuggestionReasons(tier, adjacentMatch, input.targetVenueRawLabel, input.clubTimezone, seasonAssignmentCount);
    const score = computeCosmeticScore(tier, adjacentMatch, input.targetVenueRawLabel, seasonAssignmentCount, sameDayAssignmentCount);

    const ranked: RankedCandidate = {
      licencieId: candidate.licencieId,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      teamIds: candidate.teamIds,
      eligibility: tier === "AVAILABLE_OTHER" ? "POTENTIALLY_AVAILABLE" : "RECOMMENDED",
      priorityTier: tier,
      score,
      reasons,
      seasonAssignmentCount,
      sameDayAssignmentCount,
      isCurrentHolder,
    };

    if (ranked.eligibility === "RECOMMENDED") recommended.push(ranked);
    else available.push(ranked);
  }

  return {
    recommended: rankCandidates(recommended),
    available: rankCandidates(available),
    unavailable: unavailable.sort((a, b) => a.lastName.localeCompare(b.lastName, "fr") || a.firstName.localeCompare(b.firstName, "fr")),
  };
}
