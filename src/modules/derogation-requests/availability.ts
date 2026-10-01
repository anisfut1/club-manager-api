import { DEFAULT_MATCH_DURATION_MINUTES, DEFAULT_SLOT_STEP_MINUTES, computeMatchWindow, intervalsOverlap } from "../../scheduling/match-slot.js";
import { localTimeKey, parseLocalDate, zonedWallClock, zonedWallTimeToUtc } from "../../util/timezone.js";

/**
 * Disponibilité des gymnases pour une demande de dérogation interne (retour
 * du club, 2026-10-01). Fonctions PURES : toute la règle métier est ici,
 * testable sans Supabase ; les routes ne font que charger les données.
 *
 * Créneau et chevauchement : EXCLUSIVEMENT `src/scheduling/match-slot.ts`
 * (même définition que les Tables de marque) — [start ; start + 120 min),
 * conflit si `aStart < bEnd && bStart < aEnd`.
 */

/** Plage d'heures de DÉPART autorisées un jour donné ("HH:MM", bornes incluses). */
export interface PlanningRule {
  earliestStart: string;
  latestStart: string;
}

/** Règles par jour de semaine (0 = dimanche … 6 = samedi) ; jour absent = aucune restriction horaire. */
export type PlanningRules = Partial<Record<number, PlanningRule>>;

/**
 * Grille d'AFFICHAGE quand aucune règle n'est configurée pour ce jour (ex. en
 * semaine en V1) : ce ne sont que des suggestions, jamais une restriction —
 * l'heure personnalisée reste libre (seules la durée et les collisions
 * comptent).
 */
export const UNRULED_DISPLAY_GRID: PlanningRule = { earliestStart: "09:00", latestStart: "21:00" };

export interface VenueRef {
  id: string;
  name: string;
  address: string | null;
}

/** Match déjà programmé (officiel) — HARD conflict. */
export interface ScheduledMatch {
  id: string;
  startAt: Date;
  /** Gymnase du club (null : extérieur ou salle non rattachée). */
  clubVenueId: string | null;
  teamId: string | null;
  teamName: string | null;
  opponentName: string | null;
  isHome: boolean | null;
}

/** Autre demande de dérogation ACTIVE visant un créneau — SOFT warning. */
export interface PendingProposal {
  requestId: string;
  matchId: string;
  startAt: Date;
  clubVenueId: string | null;
  teamName: string | null;
  opponentName: string | null;
}

export type SlotConflict =
  | { type: "VENUE_MATCH"; match: ScheduledMatch; window: { start: Date; end: Date } }
  | { type: "TEAM_MATCH"; match: ScheduledMatch; window: { start: Date; end: Date } };

export interface SlotWarning {
  type: "PENDING_REQUEST";
  proposal: PendingProposal;
}

export interface CandidateSlot {
  startAt: Date;
  endAt: Date;
  localStart: string;
  localEnd: string;
  available: boolean;
  conflicts: SlotConflict[];
  warnings: SlotWarning[];
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function ruleForDate(date: string, rules: PlanningRules): PlanningRule | null {
  const parsed = parseLocalDate(date);
  if (!parsed) return null;
  return rules[parsed.weekday] ?? null;
}

/** Instant UTC d'une heure murale "HH:MM" à la date "YYYY-MM-DD" dans `timezone` (DST-safe). */
export function localSlotStart(date: string, time: string, timezone: string): Date {
  const parsed = parseLocalDate(date);
  if (!parsed) throw new Error(`Date invalide : ${date}`);
  const total = minutesOf(time);
  return zonedWallTimeToUtc(parsed.year, parsed.month, parsed.day, Math.floor(total / 60), total % 60, 0, timezone);
}

/** Heures de départ candidates (pas `stepMinutes`) d'une journée, bornes incluses. */
export function candidateStartTimes(rule: PlanningRule, stepMinutes: number = DEFAULT_SLOT_STEP_MINUTES): string[] {
  const out: string[] = [];
  for (let m = minutesOf(rule.earliestStart); m <= minutesOf(rule.latestStart); m += stepMinutes) out.push(hhmm(m));
  return out;
}

export interface ConflictInput {
  startAt: Date;
  clubVenueId: string | null;
  isHome: boolean;
  targetMatchId: string;
  targetTeamId: string | null;
  matches: readonly ScheduledMatch[];
  pending: readonly PendingProposal[];
  durationMinutes?: number;
}

/**
 * Conflits d'un créneau candidat :
 *  - HARD `VENUE_MATCH` : un match programmé dans le MÊME gymnase chevauche
 *    (match à domicile uniquement) ;
 *  - HARD `TEAM_MATCH` : l'équipe concernée a déjà un autre match qui
 *    chevauche (domicile ou extérieur) ;
 *  - SOFT `PENDING_REQUEST` : une AUTRE demande active vise le même gymnase
 *    sur un créneau qui chevauche.
 * Le match cible lui-même est TOUJOURS exclu (sinon il se bloquerait).
 */
export function evaluateSlot(input: ConflictInput): { conflicts: SlotConflict[]; warnings: SlotWarning[] } {
  const duration = input.durationMinutes ?? DEFAULT_MATCH_DURATION_MINUTES;
  const candidate = computeMatchWindow(input.startAt, duration);
  const conflicts: SlotConflict[] = [];
  const warnings: SlotWarning[] = [];

  for (const match of input.matches) {
    if (match.id === input.targetMatchId) continue;
    const window = computeMatchWindow(match.startAt, duration);
    if (!intervalsOverlap(candidate.start, candidate.end, window.start, window.end)) continue;
    if (input.isHome && input.clubVenueId && match.clubVenueId === input.clubVenueId) {
      conflicts.push({ type: "VENUE_MATCH", match, window });
    } else if (input.targetTeamId && match.teamId === input.targetTeamId) {
      conflicts.push({ type: "TEAM_MATCH", match, window });
    }
  }

  if (input.isHome && input.clubVenueId) {
    for (const proposal of input.pending) {
      if (proposal.matchId === input.targetMatchId || proposal.clubVenueId !== input.clubVenueId) continue;
      const window = computeMatchWindow(proposal.startAt, duration);
      if (intervalsOverlap(candidate.start, candidate.end, window.start, window.end)) warnings.push({ type: "PENDING_REQUEST", proposal });
    }
  }

  return { conflicts, warnings };
}

export interface VenueAvailability {
  venue: VenueRef;
  existingMatches: { match: ScheduledMatch; start: Date; end: Date }[];
  pendingRequests: { proposal: PendingProposal; start: Date; end: Date }[];
  candidates: CandidateSlot[];
}

export interface AvailabilityInput {
  date: string;
  timezone: string;
  rules: PlanningRules;
  isHome: boolean;
  venues: readonly VenueRef[];
  matches: readonly ScheduledMatch[];
  pending: readonly PendingProposal[];
  targetMatchId: string;
  targetTeamId: string | null;
  now: Date;
  stepMinutes?: number;
  durationMinutes?: number;
}

export interface AvailabilityResult {
  date: string;
  rule: PlanningRule | null;
  /** Grille effectivement proposée (règle du jour, sinon grille d'affichage). */
  grid: PlanningRule;
  durationMinutes: number;
  stepMinutes: number;
  venues: VenueAvailability[];
  /** Match extérieur : créneaux sans gymnase (seul le conflit d'équipe compte). */
  awayCandidates: CandidateSlot[];
}

/** Vue complète d'une journée : par gymnase, matchs programmés + demandes en cours + créneaux candidats. */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const duration = input.durationMinutes ?? DEFAULT_MATCH_DURATION_MINUTES;
  const step = input.stepMinutes ?? DEFAULT_SLOT_STEP_MINUTES;
  const rule = ruleForDate(input.date, input.rules);
  const grid = rule ?? UNRULED_DISPLAY_GRID;
  const starts = candidateStartTimes(grid, step).map((time) => localSlotStart(input.date, time, input.timezone));

  const toCandidate = (startAt: Date, clubVenueId: string | null): CandidateSlot => {
    const { conflicts, warnings } = evaluateSlot({ startAt, clubVenueId, isHome: input.isHome, targetMatchId: input.targetMatchId, targetTeamId: input.targetTeamId, matches: input.matches, pending: input.pending, durationMinutes: duration });
    const endAt = new Date(startAt.getTime() + duration * 60_000);
    return {
      startAt,
      endAt,
      localStart: localTimeKey(startAt, input.timezone),
      localEnd: localTimeKey(endAt, input.timezone),
      available: conflicts.length === 0 && startAt > input.now,
      conflicts,
      warnings,
    };
  };

  const dayKey = input.date;
  const sameDay = (d: Date) => {
    const { year, month, day } = zonedWallClock(d, input.timezone);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` === dayKey;
  };

  const venues: VenueAvailability[] = input.isHome
    ? input.venues.map((venue) => ({
        venue,
        existingMatches: input.matches
          .filter((m) => m.id !== input.targetMatchId && m.clubVenueId === venue.id && sameDay(m.startAt))
          .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
          .map((match) => ({ match, ...computeMatchWindow(match.startAt, duration) })),
        pendingRequests: input.pending
          .filter((p) => p.matchId !== input.targetMatchId && p.clubVenueId === venue.id && sameDay(p.startAt))
          .map((proposal) => ({ proposal, ...computeMatchWindow(proposal.startAt, duration) })),
        candidates: starts.map((startAt) => toCandidate(startAt, venue.id)),
      }))
    : [];

  return {
    date: input.date,
    rule,
    grid,
    durationMinutes: duration,
    stepMinutes: step,
    venues,
    awayCandidates: input.isHome ? [] : starts.map((startAt) => toCandidate(startAt, null)),
  };
}

export type SlotValidation =
  | { ok: true; warnings: SlotWarning[]; isCustomWeekday: boolean }
  | { ok: false; code: "DEROGATION_SLOT_IN_PAST" | "DEROGATION_SLOT_OUT_OF_RANGE" | "DEROGATION_VENUE_REQUIRED"; message: string }
  | { ok: false; code: "DEROGATION_SLOT_CONFLICT"; message: string; conflicts: SlotConflict[] };

export interface ValidateSlotInput extends ConflictInput {
  timezone: string;
  rules: PlanningRules;
  now: Date;
  /** Noms de gymnases pour le message d'erreur. */
  venueNames?: ReadonlyMap<string, string>;
}

/**
 * Validation AUTORITAIRE d'un créneau demandé (création / nouvelle
 * proposition) — toujours recalculée côté serveur, jamais confiée au front.
 */
export function validateRequestedSlot(input: ValidateSlotInput): SlotValidation {
  if (input.startAt <= input.now) return { ok: false, code: "DEROGATION_SLOT_IN_PAST", message: "Le créneau demandé doit être dans le futur." };
  if (input.isHome && !input.clubVenueId) return { ok: false, code: "DEROGATION_VENUE_REQUIRED", message: "Choisis un gymnase pour un match à domicile." };

  const wall = zonedWallClock(input.startAt, input.timezone);
  const rule = input.rules[wall.weekday] ?? null;
  if (input.isHome && rule) {
    const minutes = wall.hour * 60 + wall.minute;
    if (minutes < minutesOf(rule.earliestStart) || minutes > minutesOf(rule.latestStart)) {
      return { ok: false, code: "DEROGATION_SLOT_OUT_OF_RANGE", message: `Ce jour-là, un match peut commencer entre ${rule.earliestStart} et ${rule.latestStart}.` };
    }
  }

  const { conflicts, warnings } = evaluateSlot(input);
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    const who = [first.match.teamName, first.match.opponentName ? `vs ${first.match.opponentName}` : null].filter(Boolean).join(" ") || "Un match";
    const when = `${localTimeKey(first.window.start, input.timezone)} → ${localTimeKey(first.window.end, input.timezone)}`;
    const where = first.type === "VENUE_MATCH" && first.match.clubVenueId ? ` — ${input.venueNames?.get(first.match.clubVenueId) ?? "même gymnase"}` : "";
    const reason = first.type === "VENUE_MATCH" ? "Un match est déjà programmé dans ce gymnase" : "L'équipe a déjà un match sur ce créneau";
    return { ok: false, code: "DEROGATION_SLOT_CONFLICT", message: `Créneau impossible. ${reason} : ${who}, ${when}${where}.`, conflicts };
  }

  return { ok: true, warnings, isCustomWeekday: wall.weekday >= 1 && wall.weekday <= 5 };
}
