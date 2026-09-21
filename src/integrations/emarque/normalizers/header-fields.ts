/**
 * Analyse de la ligne d'en-tête "Rencontre N° ... Date ... Heure ... Lieu ..."
 * et de la ligne "Poule ...". Voir docs/FBI_AUTHENTICATED_SPIKE.md pour la
 * validation OCR réelle de ces zones.
 */

export interface ParsedRencontreHeader {
  rencontreNumero: string | null;
  date: string | null;
  heure: string | null;
  lieu: string | null;
}

export function parseRencontreHeaderLine(text: string): ParsedRencontreHeader {
  const numeroMatch = text.match(/Rencontre\s*N[°o0]?\s*(\d{2,6})/i);
  const dateMatch = text.match(/Date\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  const heureMatch = text.match(/Heure\s*(\d{1,2})[:h.](\d{2})/i);
  const lieuMatch = text.match(/Lieu\s+([A-ZÀ-Ÿ][\wÀ-ÿ' -]*)/);

  return {
    rencontreNumero: numeroMatch?.[1] ?? null,
    date: dateMatch?.[1] ?? null,
    heure: heureMatch ? `${heureMatch[1]?.padStart(2, "0")}:${heureMatch[2]}` : null,
    lieu: lieuMatch?.[1]?.trim() ?? null,
  };
}

export function parsePouleLabel(text: string): string | null {
  const match = text.match(/Poule\s+([A-Z0-9-]+)/i);
  return match?.[1] ?? null;
}

export interface ParsedFinalResult {
  scoreHome: number | null;
  scoreAway: number | null;
}

/** "RÉSULTAT FINAL : Équipe A 69 Équipe B 101 ..." */
export function parseFinalResultLine(text: string): ParsedFinalResult {
  const match = text.match(/quipe\s*A\D{0,10}(\d{1,3})[\s\S]{0,40}quipe\s*B\D{0,10}(\d{1,3})/i);
  if (!match?.[1] || !match[2]) return { scoreHome: null, scoreAway: null };

  return { scoreHome: Number(match[1]), scoreAway: Number(match[2]) };
}

/** "27/09/25" + "21:00" -> "2025-09-27T21:00:00" (heure locale, sans fuseau). */
export function toIsoLocalDateTime(date: string | null, heure: string | null): string | null {
  if (!date) return null;

  const dateMatch = date.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!dateMatch?.[1] || !dateMatch[2] || !dateMatch[3]) return null;

  const [, day, month, rawYear] = dateMatch;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const time = heure && /^\d{2}:\d{2}$/.test(heure) ? heure : "00:00";

  return `${year}-${month}-${day}T${time}:00`;
}
