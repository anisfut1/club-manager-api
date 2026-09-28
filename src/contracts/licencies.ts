import { z } from "./zod.js";

/**
 * Un·e licencié·e du club (joueur/joueuse, coach...) — distinct d'un compte
 * Supabase Auth (voir supabase/migrations/20260921083010_licencies.sql).
 * `photoUrl` suit la même convention que `ClubDto.logoUrl` : une simple URL,
 * jamais un fichier stocké par ce backend (voir modules/clubs/routes.ts).
 */
export const LicencieDtoSchema = z
  .object({
    id: z.string().uuid(),
    clubId: z.string().uuid(),
    firstName: z.string(),
    lastName: z.string(),
    licenseNumber: z.string().nullable(),
    birthDate: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    photoUrl: z.string().nullable(),
    /** Équipe de ce·tte licencié·e (demande du club, docs/TEAMS.md) — `null` si non rattaché·e. Admin-only en écriture (voir UpdateLicencieProfileDtoSchema). */
    teamId: z.string().uuid().nullable(),
    active: z.boolean(),
    /** "N° national" FFBB (export rechercherLicence.fbi) — clé de dédoublonnage des imports, `null` pour un licencié auto-provisionné avant l'import (voir docs/LICENCIES.md). */
    ffbbLicenceId: z.string().nullable(),
    /** Catégorie FFBB au moment du dernier import — affichage seulement (aide au glisser-déposer vers la bonne équipe), jamais une source de vérité pour teamId. */
    categoryLabel: z.string().nullable(),
    /** Sexe FFBB — affichage seulement, même donnée que TeamDto.sexe (désambiguïse un nom d'équipe/catégorie ambigu). */
    sexe: z.enum(["M", "F"]).nullable(),
  })
  .openapi("LicencieDto");

export type LicencieDto = z.infer<typeof LicencieDtoSchema>;

/** GET /v1/clubs/:clubId/licencies — liste des licencié·e·s du club (tri par nom). */
export const LicenciesListDtoSchema = z
  .object({
    licencies: z.array(LicencieDtoSchema),
  })
  .openapi("LicenciesListDto");

export type LicenciesListDto = z.infer<typeof LicenciesListDtoSchema>;

/**
 * Une ligne "match" de la fiche joueur : identité du match + le rôle qu'y a
 * tenu ce·tte licencié·e (maillot, capitanat, titulaire) + ses statistiques
 * SI le document "résumé" e-Marque les a lues (`stats: null` sinon — jamais
 * une valeur devinée, voir `parser/merge.ts`).
 */
export const LicencieMatchDtoSchema = z
  .object({
    matchId: z.string().uuid(),
    numero: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    /** Domicile/extérieur DU CLUB pour ce match (jamais de l'équipe adverse) — voir MatchListItemDto. */
    isHome: z.boolean().nullable(),
    opponentName: z.string().nullable(),
    scoreHome: z.number().nullable(),
    scoreAway: z.number().nullable(),
    status: z.enum(["scheduled", "played", "postponed", "cancelled", "forfeit"]),
    jerseyNumber: z.string().nullable(),
    isCaptain: z.boolean(),
    isStarter: z.boolean().nullable(),
    stats: z
      .object({
        secondsPlayed: z.number().nullable(),
        points: z.number().nullable(),
        threePointsMade: z.number().nullable(),
        twoPointsInteriorMade: z.number().nullable(),
        twoPointsExteriorMade: z.number().nullable(),
        freeThrowsMade: z.number().nullable(),
        foulsCommitted: z.number().nullable(),
      })
      .nullable(),
  })
  .openapi("LicencieMatchDto");

export type LicencieMatchDto = z.infer<typeof LicencieMatchDtoSchema>;

/**
 * GET /v1/clubs/:clubId/licencies/:licencieId — la "fiche joueur" : identité,
 * historique des matchs et statistiques par match (demande du club). `matches`
 * est trié du plus récent au plus ancien. `canEdit` reflète EXACTEMENT ce que
 * `PATCH .../profile` acceptera pour l'appelant courant (club_admin = tous les
 * champs, licencié lui-même via son rattachement = champs de contact/photo
 * uniquement, voir `UpdateLicencieProfileDtoSchema`) — le frontend n'a jamais
 * à redériver cette règle.
 */
export const LicencieProfileDtoSchema = z
  .object({
    licencie: LicencieDtoSchema,
    canEdit: z.boolean(),
    isSelf: z.boolean(),
    matches: z.array(LicencieMatchDtoSchema),
  })
  .openapi("LicencieProfileDto");

export type LicencieProfileDto = z.infer<typeof LicencieProfileDtoSchema>;

/**
 * PATCH /v1/clubs/:clubId/licencies/:licencieId/profile — deux populations
 * distinctes de champs, appliquées côté serveur selon l'appelant (jamais une
 * distinction faite ici dans le contrat, un seul schéma pour les deux cas) :
 * - `club_admin` : tous les champs.
 * - le licencié lui-même (rattaché via `club_memberships.licencie_id`) :
 *   UNIQUEMENT `photoUrl`/`email`/`phone` — jamais son propre nom, sa date de
 *   naissance, son numéro de licence ou son statut actif/inactif (identité
 *   admin-contrôlée, voir `routes.ts`). Un champ hors de la population
 *   autorisée pour l'appelant est REJETÉ (400), jamais silencieusement
 *   ignoré — évite qu'un appelant croie avoir modifié un champ qui ne l'a
 *   pas été.
 */
export const UpdateLicencieProfileDtoSchema = z
  .object({
    photoUrl: z.string().url("photoUrl doit être une URL valide.").nullable().optional(),
    email: z.string().email("email doit être une adresse valide.").nullable().optional(),
    phone: z.string().trim().min(1).nullable().optional(),
    firstName: z.string().trim().min(1, "Le prénom ne peut pas être vide.").optional(),
    lastName: z.string().trim().min(1, "Le nom ne peut pas être vide.").optional(),
    birthDate: z.string().date("birthDate doit être au format AAAA-MM-JJ.").nullable().optional(),
    licenseNumber: z.string().trim().min(1).nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .openapi("UpdateLicencieProfileDto");

export type UpdateLicencieProfileDto = z.infer<typeof UpdateLicencieProfileDtoSchema>;

/**
 * POST /v1/clubs/:clubId/licencies/import (club_admin) — import en masse
 * depuis un export FBI ("rechercherLicence.fbi", critère "Validé"), demande
 * du club, 2026-09-28 : "Voici la liste des licenciés, ajoute les tous
 * stp, a lavenir yen aura dautres, faudra ignorer les doublons dans les
 * exports". Une ligne = une personne physique de l'export — jamais
 * transformée ici (le parsing du fichier XLSX/CSV réel se fait côté
 * SCSB, ce backend ne reçoit que du JSON déjà normalisé).
 *
 * `ffbbLicenceId` ("N° national") obligatoire : LA clé de dédoublonnage
 * (voir migration `20260928020000_licencies_ffbb_import.sql`) — sans elle,
 * un import répété créerait des doublons à chaque exécution, exactement ce
 * que le club a demandé d'éviter.
 */
export const ImportLicencieRowDtoSchema = z.object({
  ffbbLicenceId: z.string().trim().min(1, "ffbbLicenceId (N° national) est obligatoire."),
  licenseNumber: z.string().trim().min(1).nullable().optional(),
  firstName: z.string().trim().min(1, "Le prénom est obligatoire."),
  lastName: z.string().trim().min(1, "Le nom est obligatoire."),
  birthDate: z.string().date("birthDate doit être au format AAAA-MM-JJ.").nullable().optional(),
  categoryLabel: z.string().trim().min(1).nullable().optional(),
  sexe: z.enum(["M", "F"]).nullable().optional(),
});

export type ImportLicencieRowDto = z.infer<typeof ImportLicencieRowDtoSchema>;

export const ImportLicenciesDtoSchema = z
  .object({
    // Bornée : un import est un geste ponctuel déclenché par un admin, un
    // fichier de plusieurs milliers de lignes évoque une erreur (mauvais
    // fichier, export non filtré) plutôt qu'un roster de club réel.
    licencies: z.array(ImportLicencieRowDtoSchema).min(1, "Au moins un licencié à importer.").max(2000, "2000 licenciés maximum par import."),
  })
  .openapi("ImportLicenciesDto");

export type ImportLicenciesDto = z.infer<typeof ImportLicenciesDtoSchema>;

/** Résultat de l'import — `skipped` (doublons, déjà connus par `ffbbLicenceId`) jamais traité comme une erreur, voir la demande du club ci-dessus. */
export const ImportLicenciesResultDtoSchema = z
  .object({
    total: z.number(),
    inserted: z.number(),
    skipped: z.number(),
  })
  .openapi("ImportLicenciesResultDto");

export type ImportLicenciesResultDto = z.infer<typeof ImportLicenciesResultDtoSchema>;

/**
 * POST /v1/clubs/:clubId/licencies/auto-assign-teams (club_admin) —
 * répartition automatique best-effort des licenciés SANS équipe vers une
 * équipe du club, à partir de la catégorie/du sexe FFBB connus (voir
 * `modules/licencies/auto-assign-teams.ts`). Demande du club, 2026-09-28 :
 * "ils sont tous sans équipe, alors qu'on a une info pour commencer déjà a
 * les mettre dans les équipes, si ya 2 equipes pour 1 catégorie, met tous
 * dans 1 seule pour linstant". Aucun corps de requête — agit sur TOUS les
 * licenciés sans équipe du club en un seul appel.
 */
export const AutoAssignTeamsResultDtoSchema = z
  .object({
    total: z.number(),
    assigned: z.number(),
    skipped: z.number(),
  })
  .openapi("AutoAssignTeamsResultDto");

export type AutoAssignTeamsResultDto = z.infer<typeof AutoAssignTeamsResultDtoSchema>;
