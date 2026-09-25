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
    active: z.boolean(),
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
    active: z.boolean().optional(),
  })
  .openapi("UpdateLicencieProfileDto");

export type UpdateLicencieProfileDto = z.infer<typeof UpdateLicencieProfileDtoSchema>;

/** Champs modifiables par le licencié lui-même — jamais son identité (voir UpdateLicencieProfileDtoSchema). */
export const SELF_EDITABLE_LICENCIE_FIELDS = ["photoUrl", "email", "phone"] as const;
