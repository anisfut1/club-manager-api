/**
 * Fuseau horaire — validation IANA sérieuse (§2 de la demande) et calcul de
 * fenêtres de dates dans le fuseau d'UN club (§10/§11 de la demande :
 * "la timezone métier vient du club"), jamais approximées en UTC pur.
 */

let cachedValidTimeZones: ReadonlySet<string> | null = null;

function validTimeZones(): ReadonlySet<string> {
  if (!cachedValidTimeZones) {
    // Intl.supportedValuesOf est disponible depuis Node 18 (V8/ICU) — pas de
    // dépendance externe pour une simple validation de nom de fuseau IANA.
    cachedValidTimeZones = new Set(Intl.supportedValuesOf("timeZone"));
  }
  return cachedValidTimeZones;
}

export function isValidTimeZone(timezone: string): boolean {
  if (validTimeZones().has(timezone)) return true;

  // `Intl.supportedValuesOf` peut ne pas lister tous les alias valides
  // (ex: "UTC") selon la version d'ICU embarquée — un fuseau qu'`Intl`
  // accepte à la construction est accepté ici aussi, en repli.
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Convertit une date/heure "murale" (Y-M-D HH:mm:ss) EXPRIMÉE DANS `timezone` en instant UTC réel — tient compte du DST à cette date précise (double conversion, technique standard sans dépendance). */
export function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcGuess);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const readAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));

  const offsetMs = utcGuess.getTime() - readAsUtc;
  return new Date(utcGuess.getTime() + offsetMs);
}

/** Y/M/D "muraux" d'un instant donné, tels que lus dans `timezone`. */
function zonedDateParts(instant: Date, timezone: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday: WEEKDAY_INDEX[get("weekday")] ?? 0 };
}

export type MatchesPeriod = "weekend" | "upcoming" | "past";

/**
 * Fenêtre `[from, to)` en UTC pour un `period` donné, calculée DANS le
 * fuseau du club — §11 de la demande : "priorité à un contrat simple" côté
 * frontend (qui n'a plus besoin de connaître le fuseau du club), la
 * robustesse du calcul DST reste côté backend, seul endroit qui connaît
 * déjà `club.timezone`.
 */
export function computePeriodRange(period: MatchesPeriod, timezone: string, now: Date = new Date()): { from: string | null; to: string | null } {
  if (period === "upcoming") return { from: now.toISOString(), to: null };
  if (period === "past") return { from: null, to: now.toISOString() };

  // "weekend" : samedi 00:00 -> lundi 00:00, dans le fuseau du club.
  const { year, month, day, weekday } = zonedDateParts(now, timezone);
  const daysUntilSaturday = (6 - weekday) % 7;

  // Simple arithmétique calendaire (jamais d'heure murale ici) : Date.UTC
  // gère nativement le débordement de jour/mois, aucun risque DST à ce stade.
  const saturday = new Date(Date.UTC(year, month - 1, day + daysUntilSaturday));
  const monday = new Date(Date.UTC(year, month - 1, day + daysUntilSaturday + 2));

  // `to` calculé INDÉPENDAMMENT de `start` (jamais `start + 48h`) : si le
  // changement d'heure tombe pendant le week-end, 48h réelles ne valent pas
  // "lundi 00:00 heure locale" — chaque borne repasse par la même double
  // conversion, à SA propre date calendaire.
  const start = zonedWallTimeToUtc(saturday.getUTCFullYear(), saturday.getUTCMonth() + 1, saturday.getUTCDate(), 0, 0, 0, timezone);
  const end = zonedWallTimeToUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, 0, timezone);

  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * Fenêtre `[from, to)` en UTC du JOUR CALENDAIRE (dans le fuseau du club)
 * contenant `instant` — ex: 00:00→24:00 heure de Paris. Utilisé par le
 * module Tables de marque (`modules/tables/load-suggestion-data.ts`) pour
 * borner "les matchs/affectations DU MÊME JOUR que le match cible" (§12 de
 * la demande "Tables de marque" : les exemples d'enchaînement d'équipes à
 * domicile sont toujours au sein d'une même journée) — même raisonnement
 * DST-safe que `computePeriodRange` ci-dessus (chaque borne recalculée
 * indépendamment depuis SA propre date calendaire, jamais `start + 24h`).
 */
export function computeDayRange(instant: Date, timezone: string): { from: string; to: string } {
  const { year, month, day } = zonedDateParts(instant, timezone);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));

  const start = zonedWallTimeToUtc(year, month, day, 0, 0, 0, timezone);
  const end = zonedWallTimeToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0, 0, timezone);

  return { from: start.toISOString(), to: end.toISOString() };
}

/** Horloge murale d'un instant dans `timezone` (date, heure, minute, jour de semaine 0=dimanche). */
export function zonedWallClock(instant: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday: WEEKDAY_INDEX[get("weekday")] ?? 0 };
}

/** "YYYY-MM-DD" (date calendaire, sans fuseau) → composantes, `null` si invalide. */
export function parseLocalDate(value: string): { year: number; month: number; day: number; weekday: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day, weekday: probe.getUTCDay() };
}

/** "YYYY-MM-DD" de l'instant, lu dans `timezone`. */
export function localDateKey(instant: Date, timezone: string): string {
  const { year, month, day } = zonedWallClock(instant, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "HH:MM" de l'instant, lu dans `timezone`. */
export function localTimeKey(instant: Date, timezone: string): string {
  const { hour, minute } = zonedWallClock(instant, timezone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
