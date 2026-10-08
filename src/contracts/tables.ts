import { z } from "./zod.js";

/**
 * DTO du module Tables de marque (demande du club, 2026-09-28). Source de
 * vérité pour l'OpenAPI (§49) — mêmes schémas utilisés par les routes et
 * `src/openapi.ts`, jamais une doc écrite séparément.
 */

export const TableAssignmentRoleSchema = z.enum(["SCORER", "TIMEKEEPER", "CLUB_DELEGATE", "REFEREE"]).openapi("TableAssignmentRole");
export type TableAssignmentRoleDto = z.infer<typeof TableAssignmentRoleSchema>;

/** `photoUrl` : photo de la fiche joueur quand elle est connue (affectations, suggestions, classement) — absente ailleurs. */
export const LicencieRefDtoSchema = z
  .object({ id: z.string().uuid(), firstName: z.string(), lastName: z.string(), photoUrl: z.string().nullable().optional() })
  .openapi("TableLicencieRefDto");

export const TeamRefDtoSchema = z.object({ id: z.string().uuid(), name: z.string() }).openapi("TableTeamRefDto");

export const SuggestionReasonCodeSchema = z.enum(["NEXT_HOME_MATCH", "PREVIOUS_HOME_MATCH", "SAME_VENUE", "SEASON_DUTY_COUNT"]).openapi("SuggestionReasonCode");

const SuggestionReasonDtoSchema = z.object({ code: SuggestionReasonCodeSchema, label: z.string() }).openapi("SuggestionReasonDto");

export const UnavailableReasonCodeSchema = z.enum(["MATCH_CONFLICT", "TABLE_ASSIGNMENT_CONFLICT", "ALREADY_ASSIGNED_ON_MATCH"]).openapi("UnavailableReasonCode");

export const PriorityTierSchema = z.enum(["ADJACENT_NEXT_HOME", "ADJACENT_PREVIOUS_HOME", "AVAILABLE_OTHER"]).openapi("PriorityTier");

/**
 * §16/§17 de la demande : "potentiellement disponible" n'est JAMAIS
 * présenté comme "disponible confirmé" — le moteur ne connaît pas la vie
 * personnelle du licencié, seulement l'absence de conflit de calendrier
 * connu.
 */
export const RankedCandidateDtoSchema = z
  .object({
    licencie: LicencieRefDtoSchema,
    teams: z.array(TeamRefDtoSchema),
    eligibility: z.enum(["RECOMMENDED", "POTENTIALLY_AVAILABLE"]),
    priorityTier: PriorityTierSchema,
    /** Cosmétique (§22) — jamais la base du classement, voir l'ordre des tableaux `recommended`/`available`. */
    score: z.number(),
    reasons: z.array(SuggestionReasonDtoSchema),
    seasonAssignmentCount: z.number(),
    sameDayAssignmentCount: z.number(),
    /** Vrai si ce licencié occupe déjà le rôle demandé sur ce match (§77 : "Affecté actuellement"). */
    isCurrentHolder: z.boolean(),
  })
  .openapi("TableSuggestionCandidateDto");

export const UnavailableCandidateDtoSchema = z
  .object({
    licencie: LicencieRefDtoSchema,
    teams: z.array(TeamRefDtoSchema),
    eligibility: z.literal("UNAVAILABLE"),
    reasonCode: UnavailableReasonCodeSchema,
    reason: z.string(),
    conflictingMatchId: z.string().uuid().nullable(),
  })
  .openapi("TableUnavailableCandidateDto");

/**
 * GET .../matches/:matchId/table-suggestions?role=SCORER (§37/§39) —
 * STRICTEMENT en lecture, ne crée jamais d'affectation (voir docs/TABLE_ASSIGNMENTS.md).
 * `role` obligatoire : la vue "choisir un marqueur" du frontend n'a besoin
 * QUE des suggestions de ce rôle, jamais des 3 (contrat le plus propre,
 * évite un calcul inutile des 2 autres rôles).
 */
export const TableSuggestionsQueryDtoSchema = z.object({ role: TableAssignmentRoleSchema }).openapi("TableSuggestionsQueryDto");

export const TableSuggestionsDtoSchema = z
  .object({
    recommended: z.array(RankedCandidateDtoSchema),
    available: z.array(RankedCandidateDtoSchema),
    unavailable: z.array(UnavailableCandidateDtoSchema),
  })
  .openapi("TableSuggestionsDto");

/** Un poste affecté (ou non) sur un match, pour la vue liste (§36/§45/§79). */
export const TableAssignmentSlotDtoSchema = z
  .object({
    id: z.string().uuid(),
    licencie: LicencieRefDtoSchema,
    teams: z.array(TeamRefDtoSchema),
    /** Recalculé à chaque lecture (§45) — jamais supprimé/remplacé automatiquement si un conflit apparaît après coup (ex: FFBB déplace le match de l'équipe de ce licencié). */
    hasConflict: z.boolean(),
    conflictReason: z.string().nullable(),
  })
  .openapi("TableAssignmentSlotDto");

export const MatchRefDtoSchema = z
  .object({
    id: z.string().uuid(),
    numero: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    teamName: z.string().nullable(),
    opponentName: z.string().nullable(),
    venueLabel: z.string().nullable(),
  })
  .openapi("TableMatchRefDto");

export const TableAssignmentsForMatchDtoSchema = z
  .object({
    match: MatchRefDtoSchema,
    assignments: z.object({
      scorer: TableAssignmentSlotDtoSchema.nullable(),
      timekeeper: TableAssignmentSlotDtoSchema.nullable(),
      clubDelegate: TableAssignmentSlotDtoSchema.nullable(),
      referee: TableAssignmentSlotDtoSchema.nullable(),
    }),
    /**
     * Retour du club, 2026-09-28 : "il est possible qu'un arbitre officiel
     * soit désigné [par la FFBB], donc avoir la possibilité de cocher un
     * truc style pas besoin d'arbitre". `true` -> le poste `referee`
     * ci-dessus n'est PAS compté comme "à attribuer" côté frontend, même
     * s'il vaut `null`. Ne concerne QUE ce poste (les 3 autres restent
     * toujours requis).
     */
    refereeNotNeeded: z.boolean(),
    /** Vrai si AU MOINS un des postes affectés a un conflit détecté (§79 — résumé pratique pour la card match). */
    hasConflict: z.boolean(),
  })
  .openapi("TableAssignmentsForMatchDto");

/** GET /v1/clubs/:clubId/table-assignments?from=&to= (§36) — matchs À DOMICILE uniquement (§4), un match extérieur n'apparaît jamais ici. */
export const TableAssignmentsQueryDtoSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .openapi("TableAssignmentsQueryDto");

export const TableAssignmentsListDtoSchema = z.object({ matches: z.array(TableAssignmentsForMatchDtoSchema) }).openapi("TableAssignmentsListDto");

/** PUT .../table-assignments/:role (§40) — la SEULE action qui transforme une suggestion en affectation réelle. */
export const PutTableAssignmentDtoSchema = z
  .object({
    licencieId: z.string().uuid(),
    /** Affecter quand même alors que son équipe joue sur ce créneau (seul MATCH_CONFLICT est levé). */
    ignoreMatchConflict: z.boolean().optional(),
  })
  .openapi("PutTableAssignmentDto");

export const TableAssignmentResultDtoSchema = z.object({ assignment: TableAssignmentSlotDtoSchema }).openapi("TableAssignmentResultDto");

/**
 * PUT .../matches/:matchId/referee-status (retour du club, 2026-09-28) —
 * bascule "pas besoin d'arbitre" quand un arbitre officiel FFBB est déjà
 * désigné. N'affecte JAMAIS aucun licencié (voir `match_referee_overrides`,
 * distincte de `table_assignments`) : ce n'est pas une affectation.
 */
export const PutRefereeStatusDtoSchema = z.object({ noRefereeNeeded: z.boolean() }).openapi("PutRefereeStatusDto");

export const RefereeStatusResultDtoSchema = z.object({ refereeNotNeeded: z.boolean() }).openapi("RefereeStatusResultDto");

/**
 * Classement des tables de marque de la saison (retour du club,
 * 2026-10-08 : « le tableau classement des tables visible de tous, top 3 en
 * surbrillance avec leur tête »). Tables TENUES (match passé) uniquement ;
 * ex æquo = même rang.
 */
export const TableLeaderboardEntryDtoSchema = z
  .object({
    rank: z.number().int(),
    licencie: LicencieRefDtoSchema,
    done: z.number().int(),
    upcoming: z.number().int(),
    byRole: z.array(z.object({ role: TableAssignmentRoleSchema, count: z.number().int() })),
  })
  .openapi("TableLeaderboardEntryDto");

export const TableLeaderboardDtoSchema = z
  .object({
    seasonStart: z.string(),
    totalDone: z.number().int(),
    entries: z.array(TableLeaderboardEntryDtoSchema),
  })
  .openapi("TableLeaderboardDto");

export type TableLeaderboardDto = z.infer<typeof TableLeaderboardDtoSchema>;
