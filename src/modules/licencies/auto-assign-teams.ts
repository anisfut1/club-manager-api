import type { DbClient } from "../../db/client.js";

/**
 * Répartition AUTOMATIQUE (best-effort) des licenciés SANS équipe vers une
 * équipe du club, à partir de la catégorie/du sexe FFBB connus depuis
 * l'import (voir `create-derogation`... non, voir `routes.ts#POST /import`) —
 * demande du club, 2026-09-28 : "ils sont tous sans équipe, alors qu'on a
 * une info pour commencer déjà a les mettre dans les équipes, si ya 2
 * equipes pour 1 catégorie, met tous dans 1 seule pour linstant".
 *
 * Fonction PURE (`resolveTeamForLicencie`), testable sans base — jamais un
 * identifiant d'équipe deviné/codé en dur : dérivée ENTIÈREMENT des champs
 * réels `teams.category`/`teams.sexe`/`teams.numero_equipe` (déjà utilisés
 * pour la synchro FFBB, voir `resolveTeamForEngagement`) et
 * `licencies.category_label`/`licencies.sexe` (voir migration
 * `20260928020000_licencies_ffbb_import.sql`). Reste un point de DÉPART
 * modifiable ensuite par glisser-déposer (`PATCH .../profile`) — jamais une
 * vérité absolue, une catégorie FFBB fine (ex. "U16") ne correspond pas
 * toujours à une équipe FFBB officielle distincte pour un petit club.
 */

export type ParsedCategory = { kind: "senior" } | { kind: "youth"; age: number };

/**
 * "SE"/"Senior(s)" (deux graphies réelles observées : `teams.category`
 * utilise "SE", l'export FBI utilise "Seniors" en toutes lettres) → même
 * catégorie logique. "U<n>" (ex. "U11", "U21") → catégorie jeune d'âge n.
 * Toute autre valeur (vide, format inattendu) → `null`, jamais une
 * catégorie devinée.
 */
export function parseCategoryCode(raw: string | null | undefined): ParsedCategory | null {
  if (!raw) return null;
  const normalized = raw.trim().toUpperCase();
  if (normalized === "SE" || normalized === "SENIOR" || normalized === "SENIORS") return { kind: "senior" };
  const match = /^U(\d{1,2})$/.exec(normalized);
  if (!match) return null;
  return { kind: "youth", age: Number(match[1]) };
}

function sameCategory(a: ParsedCategory, b: ParsedCategory): boolean {
  if (a.kind === "senior" && b.kind === "senior") return true;
  return a.kind === "youth" && b.kind === "youth" && a.age === b.age;
}

/**
 * "Surclassement" maximal toléré (en années) pour rattacher un·e jeune
 * licencié·e à l'équipe la plus proche par le HAUT (ex. U9 → équipe U11 la
 * plus proche, pratique courante d'un petit club sans équipe pour CHAQUE
 * catégorie d'âge) — au-delà, jamais deviné (ex. U5/U7 restent SANS
 * équipe, bien trop jeunes pour une équipe U11, plutôt qu'un rattachement
 * trompeur).
 */
const YOUTH_SURCLASSEMENT_MAX_YEARS = 2;

/**
 * Détermine la catégorie D'ÉQUIPE (parmi celles réellement actives du club)
 * la plus proche pour un·e licencié·e de `playerCategory` — jamais un
 * identifiant d'équipe ici, seulement la CATÉGORIE cible (le choix entre
 * plusieurs équipes DE CETTE catégorie est fait par `resolveTeamForLicencie`).
 *
 * - Senior·e (FFBB "Seniors", ou U19/U20/U21 sans équipe jeune assez âgée
 *   pour les accueillir) → équipe Seniors si le club en a une.
 * - Jeune d'âge N → l'équipe jeune existante d'âge le plus proche PAR LE
 *   HAUT (jamais par le bas — jouer "en avance" dans une catégorie plus
 *   âgée est la pratique réelle, jamais l'inverse), dans la limite de
 *   `YOUTH_SURCLASSEMENT_MAX_YEARS`.
 */
export function resolveTargetCategory(playerCategory: ParsedCategory, availableTeamCategories: ParsedCategory[]): ParsedCategory | null {
  if (playerCategory.kind === "senior") {
    return availableTeamCategories.some((c) => c.kind === "senior") ? { kind: "senior" } : null;
  }

  const youthAges = availableTeamCategories.filter((c): c is { kind: "youth"; age: number } => c.kind === "youth").map((c) => c.age);
  const ceilingCandidates = youthAges.filter((age) => age >= playerCategory.age && age - playerCategory.age <= YOUTH_SURCLASSEMENT_MAX_YEARS);
  if (ceilingCandidates.length > 0) return { kind: "youth", age: Math.min(...ceilingCandidates) };

  // Trop âgé pour TOUTE équipe jeune existante (ex. U19/U20/U21 alors que
  // la plus âgée disponible est U18) → bascule Seniors si l'équipe existe.
  const maxYouthAge = youthAges.length > 0 ? Math.max(...youthAges) : null;
  if (maxYouthAge !== null && playerCategory.age > maxYouthAge && availableTeamCategories.some((c) => c.kind === "senior")) {
    return { kind: "senior" };
  }

  return null;
}

export interface TeamCandidate {
  id: string;
  category: string | null;
  sexe: "M" | "F" | null;
  numeroEquipe: string | null;
  active: boolean;
}

/**
 * "si ya 2 equipes pour 1 catégorie, met tous dans 1 seule pour linstant"
 * (demande du club) — parmi les équipes ACTIVES de la catégorie cible :
 * 1. Préfère celles du MÊME sexe que le·la licencié·e si au moins une
 *    existe (jamais un mélange aveugle — un club a régulièrement une
 *    équipe M ET une équipe F pour la même catégorie/le même numéro, voir
 *    `util/team-name.ts` côté application), sinon toutes les équipes de la
 *    catégorie (sexe du·de la licencié·e inconnu, ou aucune équipe de ce
 *    sexe précis).
 * 2. Choisit ensuite l'équipe au plus petit `numeroEquipe` (ex. "1" avant
 *    "2") — déterministe, jamais un tirage arbitraire d'une exécution à
 *    l'autre.
 */
export function resolveTeamForLicencie(categoryLabel: string | null, sexe: "M" | "F" | null, teams: TeamCandidate[]): string | null {
  const playerCategory = parseCategoryCode(categoryLabel);
  if (!playerCategory) return null;

  const activeTeams = teams.filter((t) => t.active);
  const parsedTeams = activeTeams
    .map((team) => ({ team, parsed: parseCategoryCode(team.category) }))
    .filter((x): x is { team: TeamCandidate; parsed: ParsedCategory } => x.parsed !== null);

  const target = resolveTargetCategory(playerCategory, parsedTeams.map((x) => x.parsed));
  if (!target) return null;

  const matching = parsedTeams.filter((x) => sameCategory(x.parsed, target)).map((x) => x.team);
  if (matching.length === 0) return null;

  const bySexe = sexe ? matching.filter((t) => t.sexe === sexe) : [];
  const pool = bySexe.length > 0 ? bySexe : matching;

  const sorted = [...pool].sort((a, b) => {
    const an = a.numeroEquipe !== null ? Number(a.numeroEquipe) : NaN;
    const bn = b.numeroEquipe !== null ? Number(b.numeroEquipe) : NaN;
    const aValid = Number.isFinite(an);
    const bValid = Number.isFinite(bn);
    if (aValid && bValid && an !== bn) return an - bn;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return (a.numeroEquipe ?? "").localeCompare(b.numeroEquipe ?? "") || a.id.localeCompare(b.id);
  });

  return sorted[0]?.id ?? null;
}

export interface AutoAssignTeamsResult {
  /** Licenciés SANS équipe ET avec une catégorie FFBB connue — seuls candidats considérés (voir `resolveTeamForLicencie`). */
  total: number;
  assigned: number;
  skipped: number;
}

/**
 * `POST /v1/clubs/:clubId/licencies/auto-assign-teams` — traite TOUS les
 * licenciés sans équipe (`team_id is null`) du club, best-effort (voir
 * `resolveTeamForLicencie`). Groupé PAR ÉQUIPE CIBLE (une seule requête
 * `update ... where id in (...)` par équipe distincte) plutôt qu'une
 * requête par licencié — jusqu'à quelques centaines de lignes en une
 * poignée de requêtes, jamais un aller-retour par personne.
 *
 * Jamais appliqué à un licencié qui a DÉJÀ une équipe (même approximative)
 * — un geste manuel antérieur (glisser-déposer, import précédent) ne doit
 * jamais être écrasé par ce best-effort.
 */
export async function autoAssignTeamsForClub(supabase: DbClient, params: { clubId: string }): Promise<AutoAssignTeamsResult> {
  const { clubId } = params;

  const { data: licencieRows, error: licenciesError } = await supabase.from("licencies").select("id, category_label, sexe").eq("club_id", clubId).is("team_id", null);
  if (licenciesError) throw new Error(`Lecture des licenciés sans équipe échouée : ${licenciesError.message}`);

  const candidates = (licencieRows ?? []).filter((row) => row.category_label !== null);
  if (candidates.length === 0) return { total: 0, assigned: 0, skipped: 0 };

  const { data: teamRows, error: teamsError } = await supabase.from("teams").select("id, category, sexe, numero_equipe, active").eq("club_id", clubId);
  if (teamsError) throw new Error(`Lecture des équipes échouée : ${teamsError.message}`);

  const teams: TeamCandidate[] = (teamRows ?? []).map((t) => ({ id: t.id, category: t.category, sexe: t.sexe, numeroEquipe: t.numero_equipe, active: t.active }));

  const licencieIdsByTeamId = new Map<string, string[]>();
  for (const licencie of candidates) {
    const teamId = resolveTeamForLicencie(licencie.category_label, licencie.sexe, teams);
    if (!teamId) continue;
    const ids = licencieIdsByTeamId.get(teamId) ?? [];
    ids.push(licencie.id);
    licencieIdsByTeamId.set(teamId, ids);
  }

  let assigned = 0;
  for (const [teamId, licencieIds] of licencieIdsByTeamId) {
    const { error } = await supabase.from("licencies").update({ team_id: teamId }).in("id", licencieIds).eq("club_id", clubId);
    if (error) throw new Error(`Affectation automatique échouée pour l'équipe ${teamId} : ${error.message}`);
    assigned += licencieIds.length;
  }

  return { total: candidates.length, assigned, skipped: candidates.length - assigned };
}
