import { z } from "./zod.js";

/**
 * Vie d'équipe — entraînements (Lot 1, retour du club 2026-10-09). Voir
 * docs/TEAM_LIFE.md. Mêmes schémas pour les routes de l'espace club
 * (comptes) et de l'espace public (lien personnel).
 */

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure au format HH:MM.");
const DATE = z.string().date("Date au format AAAA-MM-JJ.");

export const TrainingResponseValueSchema = z.enum(["PRESENT", "ABSENT", "UNCERTAIN"]).openapi("TrainingResponseValue");
export type TrainingResponseValue = z.infer<typeof TrainingResponseValueSchema>;

/** Lieu : un gymnase du club OU un lieu libre (jamais un gymnase codé en dur). */
export const TrainingLocationDtoSchema = z
  .object({ clubVenueId: z.string().uuid().nullable(), label: z.string().nullable(), address: z.string().nullable() })
  .openapi("TrainingLocationDto");

export const TrainingSlotInputSchema = z
  .object({
    weekday: z.number().int().min(0).max(6).openapi({ description: "0 = dimanche … 6 = samedi" }),
    startTime: TIME,
    endTime: TIME,
    clubVenueId: z.string().uuid().nullable().optional(),
    locationLabel: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .refine((s) => s.endTime > s.startTime, { message: "L'heure de fin doit être après l'heure de début." })
  .openapi("TrainingSlotInput");

/** Toute la semaine d'une équipe en un envoi : un créneau = une série. */
export const CreateTrainingSeriesDtoSchema = z
  .object({ slots: z.array(TrainingSlotInputSchema).min(1, "Ajoute au moins un créneau.").max(7), startsOn: DATE, endsOn: DATE })
  .refine((b) => b.endsOn >= b.startsOn, { message: "La date de fin doit être après la date de début." })
  .openapi("CreateTrainingSeriesDto");

/** Modifier un créneau à partir d'une date : les séances passées ne bougent jamais. */
export const UpdateTrainingSeriesDtoSchema = z
  .object({
    fromDate: DATE,
    weekday: z.number().int().min(0).max(6).optional(),
    startTime: TIME.optional(),
    endTime: TIME.optional(),
    clubVenueId: z.string().uuid().nullable().optional(),
    locationLabel: z.string().trim().min(1).max(120).nullable().optional(),
    endsOn: DATE.optional(),
  })
  .openapi("UpdateTrainingSeriesDto");

export const TrainingSeriesDtoSchema = z
  .object({
    id: z.string(),
    teamId: z.string(),
    weekday: z.number(),
    startTime: z.string(),
    endTime: z.string(),
    location: TrainingLocationDtoSchema,
    startsOn: z.string(),
    endsOn: z.string(),
    upcomingCount: z.number(),
  })
  .openapi("TrainingSeriesDto");
export type TrainingSeriesDto = z.infer<typeof TrainingSeriesDtoSchema>;

export const TrainingSeriesListDtoSchema = z.object({ series: z.array(TrainingSeriesDtoSchema) }).openapi("TrainingSeriesListDto");

export const TrainingCountsDtoSchema = z
  .object({ present: z.number(), absent: z.number(), uncertain: z.number(), noResponse: z.number(), total: z.number() })
  .openapi("TrainingCountsDto");
export type TrainingCountsDto = z.infer<typeof TrainingCountsDtoSchema>;

export const TrainingOccurrenceDtoSchema = z
  .object({
    id: z.string(),
    seriesId: z.string().nullable(),
    team: z.object({ id: z.string(), name: z.string() }),
    startsAt: z.string(),
    endsAt: z.string(),
    location: TrainingLocationDtoSchema,
    status: z.enum(["scheduled", "cancelled"]),
    cancelReason: z.string().nullable(),
    isModified: z.boolean(),
    /** Réponses de l'équipe : coachs / admins seulement (jamais visible d'un parent). */
    counts: TrainingCountsDtoSchema.nullable(),
    canManage: z.boolean(),
  })
  .openapi("TrainingOccurrenceDto");
export type TrainingOccurrenceDto = z.infer<typeof TrainingOccurrenceDtoSchema>;

export const TrainingOccurrenceListDtoSchema = z.object({ trainings: z.array(TrainingOccurrenceDtoSchema) }).openapi("TrainingOccurrenceListDto");

export const TrainingRosterEntryDtoSchema = z
  .object({
    licencie: z.object({ id: z.string(), firstName: z.string(), lastName: z.string(), photoUrl: z.string().nullable() }),
    response: TrainingResponseValueSchema.nullable(),
    respondedAt: z.string().nullable(),
  })
  .openapi("TrainingRosterEntryDto");

export const TrainingOccurrenceDetailDtoSchema = z
  .object({ training: TrainingOccurrenceDtoSchema, roster: z.array(TrainingRosterEntryDtoSchema) })
  .openapi("TrainingOccurrenceDetailDto");

/** Modifier UNE séance (la série ne change pas). */
export const UpdateTrainingOccurrenceDtoSchema = z
  .object({ date: DATE, startTime: TIME, endTime: TIME, clubVenueId: z.string().uuid().nullable().optional(), locationLabel: z.string().trim().min(1).max(120).nullable().optional() })
  .refine((b) => b.endTime > b.startTime, { message: "L'heure de fin doit être après l'heure de début." })
  .openapi("UpdateTrainingOccurrenceDto");

export const CancelTrainingOccurrenceDtoSchema = z.object({ reason: z.string().trim().max(200).nullable().optional() }).openapi("CancelTrainingOccurrenceDto");

export const PutTrainingResponseDtoSchema = z.object({ response: TrainingResponseValueSchema }).openapi("PutTrainingResponseDto");

export const TrainingResponseResultDtoSchema = z
  .object({ occurrenceId: z.string(), licencieId: z.string(), response: TrainingResponseValueSchema, respondedAt: z.string() })
  .openapi("TrainingResponseResultDto");

/** Planning : matchs FFBB (table `matches`, jamais recopiés) + entraînements, dans une seule liste. */
export const PlanningEventDtoSchema = z
  .object({
    kind: z.enum(["MATCH", "TRAINING"]),
    id: z.string(),
    team: z.object({ id: z.string(), name: z.string() }).nullable(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    title: z.string(),
    isHome: z.boolean().nullable(),
    location: z.string().nullable(),
    status: z.string(),
  })
  .openapi("PlanningEventDto");
export type PlanningEventDto = z.infer<typeof PlanningEventDtoSchema>;

export const PlanningDtoSchema = z.object({ from: z.string(), to: z.string(), events: z.array(PlanningEventDtoSchema) }).openapi("PlanningDto");

/** Home « À faire » de l'espace public : plusieurs liens personnels (ex. deux enfants sur le même téléphone). */
export const ActionCenterRequestDtoSchema = z.object({ tokens: z.array(z.string().min(1)).min(1).max(8) }).openapi("ActionCenterRequestDto");

export const ActionCenterPersonDtoSchema = z
  .object({ tokenIndex: z.number().openapi({ description: "Position du lien de cette personne dans `tokens` (pour répondre avec le bon lien)" }), licencieId: z.string(), firstName: z.string(), lastName: z.string(), team: z.object({ id: z.string(), name: z.string() }).nullable(), coachTeams: z.array(z.object({ id: z.string(), name: z.string() })) })
  .openapi("ActionCenterPersonDto");

export const ActionCenterActionDtoSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("TRAINING_RESPONSE"),
      licencieId: z.string(),
      firstName: z.string(),
      training: TrainingOccurrenceDtoSchema,
      currentResponse: TrainingResponseValueSchema.nullable(),
    }),
    z.object({
      type: z.literal("COACH_TRAINING_SUMMARY"),
      coachLicencieId: z.string(),
      training: TrainingOccurrenceDtoSchema,
    }),
  ])
  .openapi("ActionCenterActionDto");

export const ActionCenterDtoSchema = z
  .object({
    people: z.array(ActionCenterPersonDtoSchema),
    /** Liens invalides ou révoqués (à oublier sur cet appareil). */
    invalidTokenIndexes: z.array(z.number()),
    actions: z.array(ActionCenterActionDtoSchema),
    upcoming: z.array(PlanningEventDtoSchema.extend({ forFirstNames: z.array(z.string()) })),
  })
  .openapi("ActionCenterDto");
export type ActionCenterDto = z.infer<typeof ActionCenterDtoSchema>;
