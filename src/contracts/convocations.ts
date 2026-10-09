import { z } from "./zod.js";

/**
 * Vie d'équipe — Lot 2 : disponibilités des matchs et convocations. Voir
 * docs/TEAM_LIFE.md. DISPONIBLE (« je peux venir »), CONVOQUÉ (« le coach
 * m'a choisi ») et CONFIRMÉ (« je confirme ») sont trois notions distinctes.
 */

export const MatchAvailabilityValueSchema = z.enum(["AVAILABLE", "UNAVAILABLE", "UNCERTAIN"]).openapi("MatchAvailabilityValue");
export type MatchAvailabilityValue = z.infer<typeof MatchAvailabilityValueSchema>;

export const ConvocationResponseValueSchema = z.enum(["PENDING", "CONFIRMED", "DECLINED"]).openapi("ConvocationResponseValue");
export type ConvocationResponseValue = z.infer<typeof ConvocationResponseValueSchema>;

/** Match vu par la Vie d'équipe (lu dans `matches`, source FFBB). */
export const TeamLifeMatchDtoSchema = z
  .object({
    id: z.string(),
    team: z.object({ id: z.string(), name: z.string() }),
    startsAt: z.string().nullable(),
    isHome: z.boolean().nullable(),
    opponent: z.string().nullable(),
    venueName: z.string().nullable(),
    venueAddress: z.string().nullable(),
    status: z.string(),
  })
  .openapi("TeamLifeMatchDto");
export type TeamLifeMatchDto = z.infer<typeof TeamLifeMatchDtoSchema>;

/** Photo du match au moment de l'envoi de la convocation. */
export const MatchSnapshotDtoSchema = z
  .object({ startsAt: z.string(), isHome: z.boolean().nullable(), opponent: z.string().nullable(), venueName: z.string().nullable(), venueAddress: z.string().nullable(), teamName: z.string() })
  .openapi("MatchSnapshotDto");
export type MatchSnapshotDto = z.infer<typeof MatchSnapshotDtoSchema>;

const LicencieRef = z.object({ id: z.string(), firstName: z.string(), lastName: z.string(), photoUrl: z.string().nullable() });

export const AvailabilityCountsDtoSchema = z
  .object({ available: z.number(), unavailable: z.number(), uncertain: z.number(), noResponse: z.number(), total: z.number() })
  .openapi("AvailabilityCountsDto");
export type AvailabilityCountsDto = z.infer<typeof AvailabilityCountsDtoSchema>;

export const ConvocationCountsDtoSchema = z.object({ convoked: z.number(), confirmed: z.number(), declined: z.number(), pending: z.number() }).openapi("ConvocationCountsDto");
export type ConvocationCountsDto = z.infer<typeof ConvocationCountsDtoSchema>;

export const ConvocationDraftDtoSchema = z
  .object({
    licencieIds: z.array(z.string()),
    meetingAt: z.string().nullable(),
    meetingPoint: z.string().nullable(),
    meetingVenueId: z.string().nullable(),
    coachMessage: z.string().nullable(),
  })
  .openapi("ConvocationDraftDto");

/** Écran coach d'un match : disponibilités puis convocation (brouillon et version envoyée). */
export const MatchTeamLifeDtoSchema = z
  .object({
    match: TeamLifeMatchDtoSchema,
    canManage: z.boolean(),
    /** Match annulé / reporté / passé : plus de demande ni de confirmation. */
    matchClosed: z.boolean(),
    availability: z.object({
      openedAt: z.string().nullable(),
      counts: AvailabilityCountsDtoSchema,
      roster: z.array(z.object({ licencie: LicencieRef, response: MatchAvailabilityValueSchema.nullable(), respondedAt: z.string().nullable() })),
    }),
    convocation: z
      .object({
        id: z.string(),
        revision: z.number(),
        sentAt: z.string().nullable(),
        draft: ConvocationDraftDtoSchema,
        sent: z.object({ meetingAt: z.string().nullable(), meetingPoint: z.string().nullable(), coachMessage: z.string().nullable(), matchSnapshot: MatchSnapshotDtoSchema }).nullable(),
        /** Le brouillon diffère de ce qui a été envoyé (« Envoyer la mise à jour »). */
        hasUnsentChanges: z.boolean(),
        /** Le match FFBB a changé depuis l'envoi (date / heure, lieu) : jamais corrigé en silence. */
        matchChanges: z.array(z.enum(["DATE", "VENUE", "STATUS"])),
        counts: ConvocationCountsDtoSchema,
        recipients: z.array(z.object({ licencie: LicencieRef, response: ConvocationResponseValueSchema, respondedAt: z.string().nullable() })),
      })
      .nullable(),
  })
  .openapi("MatchTeamLifeDto");
export type MatchTeamLifeDto = z.infer<typeof MatchTeamLifeDtoSchema>;

const NULLABLE_TEXT = (max: number) => z.string().trim().max(max).nullable().optional();

export const PutConvocationDraftDtoSchema = z
  .object({
    licencieIds: z.array(z.string().uuid()).max(40).optional(),
    meetingAt: z.string().datetime({ offset: true }).nullable().optional(),
    meetingPoint: NULLABLE_TEXT(160),
    meetingVenueId: z.string().uuid().nullable().optional(),
    coachMessage: NULLABLE_TEXT(1000),
  })
  .openapi("PutConvocationDraftDto");

export const ConvocationPreviewDtoSchema = z
  .object({
    recipientsCount: z.number(),
    /** Exemples de ce que recevront un parent et un joueur majeur (selon la sélection). */
    samples: z.array(z.object({ audience: z.enum(["GUARDIAN", "ADULT"]), firstName: z.string(), text: z.string() })),
    /** Personnes sélectionnées qui ont répondu « Indisponible » (alerte, jamais bloquant). */
    unavailableSelected: z.array(z.string()),
    /** Ce qui empêche l'envoi (lieu de rendez-vous manquant à l'extérieur…). */
    blockers: z.array(z.string()),
  })
  .openapi("ConvocationPreviewDto");

export const PutAvailabilityResponseDtoSchema = z.object({ response: MatchAvailabilityValueSchema }).openapi("PutAvailabilityResponseDto");
export const PutConvocationResponseDtoSchema = z.object({ response: z.enum(["CONFIRMED", "DECLINED"]) }).openapi("PutConvocationResponseDto");

export const AvailabilityResponseResultDtoSchema = z.object({ matchId: z.string(), licencieId: z.string(), response: MatchAvailabilityValueSchema, respondedAt: z.string() }).openapi("AvailabilityResponseResultDto");
export const ConvocationResponseResultDtoSchema = z.object({ matchId: z.string(), licencieId: z.string(), response: ConvocationResponseValueSchema, respondedAt: z.string() }).openapi("ConvocationResponseResultDto");

/** Actions « Vie d'équipe » des matchs pour la Home (ajoutées à l'action center). */
export const MatchAvailabilityActionSchema = z.object({
  type: z.literal("MATCH_AVAILABILITY"),
  licencieId: z.string(),
  firstName: z.string(),
  match: TeamLifeMatchDtoSchema,
  currentResponse: MatchAvailabilityValueSchema.nullable(),
});

export const ConvocationResponseActionSchema = z.object({
  type: z.literal("CONVOCATION_RESPONSE"),
  licencieId: z.string(),
  firstName: z.string(),
  match: TeamLifeMatchDtoSchema,
  convocation: z.object({
    revision: z.number(),
    meetingAt: z.string().nullable(),
    meetingPoint: z.string().nullable(),
    coachMessage: z.string().nullable(),
    matchSnapshot: MatchSnapshotDtoSchema,
    /** Le message personnalisé tel qu'envoyé. */
    message: z.string(),
  }),
  currentResponse: ConvocationResponseValueSchema,
  /** Match annulé / reporté : plus de confirmation possible. */
  matchClosed: z.boolean(),
});

export const CoachMatchActionSchema = z.object({
  type: z.literal("COACH_MATCH"),
  coachLicencieId: z.string(),
  match: TeamLifeMatchDtoSchema,
  /** Où en est le coach : demander les disponibilités, préparer la convocation, suivre les confirmations. */
  stage: z.enum(["ASK_AVAILABILITY", "PREPARE_CONVOCATION", "CONVOCATION_SENT"]),
  availabilityCounts: AvailabilityCountsDtoSchema.nullable(),
  convocationCounts: ConvocationCountsDtoSchema.nullable(),
  matchChanged: z.boolean(),
});
