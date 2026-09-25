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

/**
 * Extrait un numéro de licence d'une cellule OCR ISOLÉE censée ne contenir
 * QUE ce numéro (jamais un texte libre mélangé, voir `findLicenseMatch`
 * pour ce cas) — colonne "numéro" du document "feuillematch".
 *
 * Corrige la confusion "O"/"0" PAR POSITION plutôt qu'une substitution
 * aveugle : un numéro de licence FFBB fait toujours EXACTEMENT 2 lettres
 * puis 6 chiffres (ex: VT010167, OH954244) — la même lettre "O" doit donc
 * être comprise comme un "0" en position 3-8 (chiffre), mais un vrai "O"
 * en position 1-2 (préfixe, ex: le "O" de "OH954244"). Constaté en
 * production (rencontre n°1481, § "Trente-quatrième déclenchement",
 * docs/FBI.md) : sur 15 licences réelles, l'OCR confondait "0"/"O" dans
 * LES DEUX SENS selon la position ("VTO10167" au lieu de "VT010167" ET
 * "0H954244" au lieu de "OH954244") — une substitution aveugle "O"->"0"
 * (comme `extractSingleInteger`) aurait cassé le second cas. Validé sur
 * l'échantillon complet : 15/15 après cette correction positionnelle,
 * contre 6/15 sans elle.
 *
 * Exige EXACTEMENT 8 caractères après suppression des espaces (jamais de
 * tolérance sur la longueur) : un caractère en trop ou manquant décale la
 * correspondance position->rôle (lettre/chiffre) de façon indétectable —
 * mieux vaut `null` qu'une correction appliquée au mauvais caractère.
 */
export function extractIsolatedLicenseNumber(rawText: string): string | null {
  const stripped = rawText.replace(/\s/g, "").toUpperCase();
  if (stripped.length !== 8) return null;

  const corrected = stripped
    .split("")
    .map((char, index) => {
      if (index < 2) return char === "0" ? "O" : char;
      return char === "O" ? "0" : char;
    })
    .join("");

  const match = corrected.match(/^([A-Z]{2})(\d{6})$/);
  return match ? corrected : null;
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
 *
 * Conservé pour un usage éventuel sur un texte multi-colonnes, mais
 * `parse-resume.ts` ne l'utilise plus pour les statistiques par joueur —
 * voir `extractSingleInteger`.
 */
export function extractTrailingIntegers(text: string, count: number): number[] | null {
  const matches = [...text.matchAll(/\d{1,3}/g)].map((m) => Number(m[0]));
  if (matches.length < count) return null;
  return matches.slice(-count);
}

/**
 * Extrait UN SEUL nombre entier (0 à 3 chiffres) d'un texte OCR — pour une
 * cellule de tableau isolée (une colonne, une ligne), jamais une ligne
 * entière. `null` si aucun nombre trouvé : jamais 0 par défaut (0 est une
 * vraie valeur statistique, voir ARCHITECTURE.md §22).
 *
 * Constaté en production (rencontre n°1481, § "Trente-et-unième
 * déclenchement", docs/FBI.md) : `extractTrailingIntegers` sur la ligne
 * ENTIÈRE (nom + temps + 7 statistiques) se décale dès qu'UN SEUL chiffre
 * est mal lu n'importe où dans la ligne (le numéro de maillot ou "23:35"
 * contribuent déjà des entiers parasites avant même les vraies
 * statistiques) — toutes les valeurs de la ligne deviennent alors fausses
 * silencieusement. Une cellule OCR isolée et étroite n'a pas ce problème :
 * un chiffre mal lu n'affecte plus que CETTE cellule.
 *
 * Substitution "O"/"o" isolé -> "0" AVANT la recherche de chiffres :
 * confusion OCR connue et quasi systématique sur un "0" statistique isolé
 * (14 occurrences sur 14 dans l'échantillon réel qui a servi à calibrer ce
 * correctif) — jamais risquée dans du texte libre (un nom de famille peut
 * légitimement contenir un vrai "O"), donc réservée à cette fonction,
 * jamais appliquée en amont dans le texte brut d'une cellule non numérique.
 */
export function extractSingleInteger(text: string): number | null {
  const normalized = text.replace(/\bO\b/g, "0").replace(/\bo\b/g, "0");
  const match = normalized.match(/\d{1,3}/);
  return match ? Number(match[0]) : null;
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
