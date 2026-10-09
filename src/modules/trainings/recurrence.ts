import { parseLocalDate, zonedWallTimeToUtc } from "../../util/timezone.js";

/**
 * Séances d'un créneau récurrent (fonction pure) : chaque semaine, le jour
 * donné, entre deux dates incluses, à l'heure locale du club (gère les
 * changements d'heure été/hiver : 19:00 reste 19:00 à Paris toute l'année).
 */
export interface SeriesShape {
  weekday: number;
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string;
}

export interface GeneratedOccurrence {
  seriesDate: string;
  startsAt: string;
  endsAt: string;
}

function parseTime(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":");
  return { hour: Number(h), minute: Number(m) };
}

function addDays(date: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

function key(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Heure locale « HH:MM » d'une date → instant UTC (ISO). */
export function localToUtc(dateKey: string, time: string, timezone: string): string {
  const d = parseLocalDate(dateKey);
  if (!d) throw new Error(`Date invalide : ${dateKey}`);
  const t = parseTime(time);
  return zonedWallTimeToUtc(d.year, d.month, d.day, t.hour, t.minute, 0, timezone).toISOString();
}

export function generateOccurrences(series: SeriesShape, timezone: string): GeneratedOccurrence[] {
  const start = parseLocalDate(series.startsOn);
  const end = parseLocalDate(series.endsOn);
  if (!start || !end) return [];
  const offset = (series.weekday - start.weekday + 7) % 7;
  const out: GeneratedOccurrence[] = [];
  for (let current = addDays(start, offset); key(current) <= series.endsOn; current = addDays(current, 7)) {
    const date = key(current);
    out.push({ seriesDate: date, startsAt: localToUtc(date, series.startTime, timezone), endsAt: localToUtc(date, series.endTime, timezone) });
  }
  return out;
}
