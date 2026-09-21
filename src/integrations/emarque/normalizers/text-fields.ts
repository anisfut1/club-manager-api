/**
 * Fonctions pures de normalisation d'un texte OCR bruité en champs
 * structurés. Séparées de toute logique d'extraction (PDF/OCR) pour rester
 * testables sans document réel — voir *.test.ts dans ce dossier.
 *
 * Principe directeur (ARCHITECTURE.md §22) : en cas de doute, retourner
 * `null` plutôt que de deviner une valeur. Une mauvaise valeur assignée à
 * la mauvaise colonne est pire qu'une absence de donnée.
 */

const LICENSE_PATTERN = /\b([A-Z]{2})\s?(\d{6})\b/;

export interface LicenseMatch {
  license: string;
  /** Le texte qui suit immédiatement le numéro de licence trouvé (nom probable). */
  remainder: string;
}

/**
 * Cherche un numéro de licence (ex: VT880543) dans un texte OCR bruité et
 * retourne aussi ce qui suit dans le texte ORIGINAL (jamais recalculé via
 * `indexOf` sur une version reconstruite : l'espace optionnel entre lettres
 * et chiffres rendrait cette recherche incorrecte).
 */
export function findLicenseMatch(rawText: string): LicenseMatch | null {
  const cleaned = rawText.toUpperCase().replace(/[|]/g, " ");
  const match = cleaned.match(LICENSE_PATTERN);
  if (!match?.[1] || !match[2] || match.index === undefined) return null;

  const license = `${match[1]}${match[2]}`;
  const remainder = cleaned.slice(match.index + match[0].length);
  return { license, remainder };
}

/** Extrait un numéro de licence (ex: VT880543) d'un texte OCR bruité. */
export function extractLicenseNumber(rawText: string): string | null {
  return findLicenseMatch(rawText)?.license ?? null;
}

/** "NOM, Prénom" -> { lastName: "NOM", firstName: "Prénom" } (format du document "résumé"). */
export function splitCommaSeparatedName(text: string): { lastName: string | null; firstName: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { lastName: null, firstName: null };

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex === -1) return { lastName: trimmed, firstName: null };

  const lastName = trimmed.slice(0, commaIndex).trim();
  const firstName = trimmed.slice(commaIndex + 1).trim();
  return { lastName: lastName || null, firstName: firstName || null };
}

/**
 * "NOM P." -> { lastName: "NOM", firstName: "P." } (format abrégé de la
 * feuille de marque : convention FFBB "NOM Prénom", nom en majuscules).
 */
export function splitUppercaseAbbreviatedName(text: string): { lastName: string | null; firstName: string | null } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { lastName: null, firstName: null };
  if (tokens.length === 1) return { lastName: tokens[0] ?? null, firstName: null };

  const firstName = tokens[tokens.length - 1] ?? null;
  const lastName = tokens.slice(0, -1).join(" ");
  return { lastName: lastName || null, firstName };
}

/** "12:52" -> 772 (secondes). Retourne null si le format n'est pas reconnu. */
export function parseMinutesSecondsToSeconds(text: string): number | null {
  const match = text.match(/(\d{1,3}):([0-5]\d)/);
  if (!match?.[1] || !match[2]) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;

  return minutes * 60 + seconds;
}

/**
 * Cherche EXACTEMENT `count` nombres entiers isolés (1 à 3 chiffres) dans le
 * texte et retourne les `count` DERNIERS (les colonnes numériques sont
 * toujours en fin de ligne sur ces documents). Retourne `null` (pas un
 * tableau de null) si moins de `count` nombres ont été trouvés : mieux vaut
 * abandonner toute la ligne que de risquer un décalage de colonne.
 */
export function extractTrailingIntegers(text: string, count: number): number[] | null {
  const matches = [...text.matchAll(/\d{1,3}/g)].map((m) => Number(m[0]));
  if (matches.length < count) return null;
  return matches.slice(-count);
}

/** Un jersey/numéro de maillot valide est 1 à 2 chiffres (0-99). */
export function extractJerseyNumber(text: string): string | null {
  const match = text.match(/\b(\d{1,2})\b/);
  return match?.[1] ?? null;
}

/** Détecte une case cochée ("X", "☒"...) en tête de ligne (titulaire / capitaine). */
export function hasCheckMark(text: string): boolean {
  return /[xX✕✗☒]/.test(text);
}
