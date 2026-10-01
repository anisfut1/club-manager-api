import { z } from "./zod.js";
import { TableAssignmentRoleSchema, TableAssignmentSlotDtoSchema, MatchRefDtoSchema, LicencieRefDtoSchema } from "./tables.js";

/**
 * DTO du flux PUBLIC sans compte des Tables de marque (retour du club,
 * 2026-09-29 : "je vais envoyer le lien à tout le monde et ils se
 * positionneront... l'accès se fera sans création de compte"). Réutilise
 * les schémas du module Tables de marque authentifié plutôt que de les
 * redéfinir (même forme de match/poste des deux côtés).
 */

export const PublicClubDtoSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    accentColor: z.string().nullable(),
    timezone: z.string(),
  })
  .openapi("PublicClubDto");

/**
 * `claimed` : `true` si ce nom a déjà été choisi par quelqu'un (jamais QUI
 * — aucune donnée personnelle d'un tiers n'est exposée ici, voir §16 de la
 * demande "Tables de marque" appliqué par analogie à la vie privée).
 */
export const PublicLicencieDtoSchema = z
  .object({
    id: z.string().uuid(),
    firstName: z.string(),
    lastName: z.string(),
    claimed: z.boolean(),
  })
  .openapi("PublicLicencieDto");

export const PublicLicenciesListDtoSchema = z.object({ licencies: z.array(PublicLicencieDtoSchema) }).openapi("PublicLicenciesListDto");

/** Page du frontend public vers laquelle le bouton de l'email ramène (le lien porte toujours `?token=`). */
export const PublicLinkTargetSchema = z.enum(["matchs", "tables", "derogations"]).openapi("PublicLinkTarget");

/**
 * POST .../licencies/:licencieId/request-link (retour du club, 2026-10-01 :
 * "il va chercher son nom, il va mettre son mail... un bouton qui renvoie
 * vers son lien avec token"). Le lien n'est JAMAIS renvoyé dans la réponse,
 * uniquement envoyé par email. `email` n'est utilisé que si le licencié n'a
 * encore aucune adresse connue — sinon l'email part TOUJOURS à l'adresse
 * déjà enregistrée (le champ saisi est ignoré), ce qui sert aussi de
 * "lien perdu ?".
 */
export const RequestPersonalLinkDtoSchema = z
  .object({
    email: z.string().trim().email("Adresse email invalide.").max(254).nullable().optional(),
    returnTo: PublicLinkTargetSchema.optional(),
  })
  .openapi("RequestPersonalLinkDto");

/** `maskedEmail` (ex: `c***@gmail.com`) : jamais l'adresse complète renvoyée à un visiteur anonyme. */
export const RequestPersonalLinkResultDtoSchema = z.object({ sent: z.literal(true), maskedEmail: z.string() }).openapi("RequestPersonalLinkResultDto");

/** `isClubAdmin` : le licencié est rattaché à un compte club_admin actif de CE club — seul cas où la vue publique des dérogations s'ouvre. */
export const PublicMeDtoSchema = z.object({ licencie: LicencieRefDtoSchema, isClubAdmin: z.boolean() }).openapi("PublicMeDto");

export const PublicTableAssignmentsForMatchDtoSchema = z
  .object({
    match: MatchRefDtoSchema,
    assignments: z.object({
      scorer: TableAssignmentSlotDtoSchema.nullable(),
      timekeeper: TableAssignmentSlotDtoSchema.nullable(),
      clubDelegate: TableAssignmentSlotDtoSchema.nullable(),
      referee: TableAssignmentSlotDtoSchema.nullable(),
    }),
    refereeNotNeeded: z.boolean(),
    hasConflict: z.boolean(),
  })
  .openapi("PublicTableAssignmentsForMatchDto");

/** `me` permet au frontend de savoir "quel poste m'appartient" sans jamais faire confiance à une comparaison côté client seule (le retrait/l'affectation restent revalidés côté serveur à chaque écriture). */
export const PublicTableAssignmentsListDtoSchema = z
  .object({
    me: LicencieRefDtoSchema,
    matches: z.array(PublicTableAssignmentsForMatchDtoSchema),
  })
  .openapi("PublicTableAssignmentsListDto");

export const PublicTableAssignmentsQueryDtoSchema = z
  .object({
    token: z.string().min(1, "token manquant."),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .openapi("PublicTableAssignmentsQueryDto");

export const PublicTokenQueryDtoSchema = z.object({ token: z.string().min(1, "token manquant.") }).openapi("PublicTokenQueryDto");

export const PublicAssignRoleQueryDtoSchema = PublicTokenQueryDtoSchema.extend({ role: TableAssignmentRoleSchema });

/** Réutilise le même DTO de résultat que le flux admin (`{ assignment }}`) — même forme des deux côtés. */
export const PublicAssignResultDtoSchema = z.object({ assignment: TableAssignmentSlotDtoSchema }).openapi("PublicAssignResultDto");

/**
 * Gestion admin des accès publics — `GET .../table-assignments/public-access`
 * (liste, pour voir qui a déjà revendiqué son nom) et
 * `POST .../public-access/:licencieId/reset` (retour du club : "sauf si
 * admin remet à reset son profil").
 */
export const PublicAccessEntryDtoSchema = z
  .object({
    licencie: LicencieRefDtoSchema,
    claimed: z.boolean(),
    email: z.string().nullable(),
    claimedAt: z.string().nullable(),
  })
  .openapi("PublicAccessEntryDto");

export const PublicAccessListDtoSchema = z.object({ entries: z.array(PublicAccessEntryDtoSchema) }).openapi("PublicAccessListDto");

export const PublicAccessResetResultDtoSchema = z.object({ reset: z.literal(true) }).openapi("PublicAccessResetResultDto");
