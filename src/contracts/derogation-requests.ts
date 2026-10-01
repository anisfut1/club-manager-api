import { z } from "./zod.js";

/**
 * DEMANDES DE DÉROGATION INTERNES (coach → coordinateur), retour du club
 * 2026-10-01. Distinctes des dérogations OFFICIELLES FBI (`contracts/
 * derogations.ts`) : rien ici n'écrit sur FFBB/FBI ni ne modifie un match.
 */

export const DerogationRequestStatusSchema = z.enum(["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE", "COMPLETED", "CANCELLED"]).openapi("DerogationRequestStatus");
export const DerogationActionSchema = z.enum(["TAKE_IN_CHARGE", "REQUEST_CHANGE", "COMPLETE", "CANCEL"]).openapi("DerogationAction");

export const ClubVenueDtoSchema = z.object({ id: z.string().uuid(), name: z.string(), address: z.string().nullable() }).openapi("ClubVenueDto");

export const DerogationMatchRefDtoSchema = z
  .object({
    id: z.string().uuid(),
    numero: z.string().nullable(),
    teamId: z.string().uuid().nullable(),
    teamName: z.string().nullable(),
    categoryLabel: z.string().nullable(),
    opponentName: z.string().nullable(),
    isHome: z.boolean().nullable(),
    matchDatetime: z.string().nullable(),
    venueName: z.string().nullable(),
    status: z.string(),
  })
  .openapi("DerogationMatchRefDto");

export const DerogationProposalDtoSchema = z
  .object({
    id: z.string().uuid(),
    requestedStartAt: z.string(),
    requestedEndAt: z.string(),
    venue: ClubVenueDtoSchema.nullable(),
    isCustomWeekday: z.boolean(),
    proposedByDisplayName: z.string(),
    createdAt: z.string(),
  })
  .openapi("DerogationProposalDto");

export const DerogationMessageDtoSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["USER", "SYSTEM"]),
    event: z.string().nullable(),
    body: z.string(),
    authorDisplayName: z.string(),
    authorRoleLabel: z.string().nullable(),
    isMine: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("DerogationMessageDto");

export const DerogationRequestSummaryDtoSchema = z
  .object({
    id: z.string().uuid(),
    status: DerogationRequestStatusSchema,
    match: DerogationMatchRefDtoSchema,
    requesterDisplayName: z.string(),
    createdByMe: z.boolean(),
    originalScheduledAt: z.string().nullable(),
    requestedStartAt: z.string(),
    requestedEndAt: z.string(),
    requestedVenue: ClubVenueDtoSchema.nullable(),
    isCustomWeekday: z.boolean(),
    /** Demande envoyée ou reproposée, pas encore prise en charge — met en tête l'inbox coordinateur. */
    needsCoordinatorAttention: z.boolean(),
    lastMessage: z.object({ type: z.enum(["USER", "SYSTEM"]), authorDisplayName: z.string(), excerpt: z.string(), createdAt: z.string() }).nullable(),
    lastMessageAt: z.string(),
    createdAt: z.string(),
  })
  .openapi("DerogationRequestSummaryDto");

export const DerogationRequestDetailDtoSchema = DerogationRequestSummaryDtoSchema.extend({
  proposals: z.array(DerogationProposalDtoSchema),
  messages: z.array(DerogationMessageDtoSchema),
  permissions: z.object({
    canMessage: z.boolean(),
    canPropose: z.boolean(),
    actions: z.array(DerogationActionSchema),
    /** Coordinateur, demande « En cours » : peut envoyer la dérogation OFFICIELLE (FBI) depuis la demande. */
    canSubmitOfficial: z.boolean(),
  }),
  /**
   * Calendrier OFFICIEL actuel (FFBB, synchronisé) comparé à la demande —
   * information seulement, jamais une modification automatique du statut.
   */
  officialSchedule: z.object({
    currentScheduledAt: z.string().nullable(),
    changedSinceRequest: z.boolean(),
    matchesCurrentProposal: z.boolean(),
  }),
}).openapi("DerogationRequestDetailDto");

export const DerogationRequestListDtoSchema = z
  .object({
    requests: z.array(DerogationRequestSummaryDtoSchema),
    pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
  })
  .openapi("DerogationRequestListDto");

export const DerogationRequestListQueryDtoSchema = z
  .object({
    status: DerogationRequestStatusSchema.optional(),
    teamId: z.string().uuid().optional(),
    matchId: z.string().uuid().optional(),
    createdByMe: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("DerogationRequestListQueryDto");

export const DerogationContextDtoSchema = z
  .object({
    /** « Demande formulée par » — prénom du licencié rattaché, sinon nom d'affichage du compte. */
    requesterDisplayName: z.string(),
    requesterNameSource: z.enum(["LICENCIE", "PROFILE", "EMAIL"]),
    coordinatorsConfigured: z.boolean(),
    canCreate: z.boolean(),
    canManage: z.boolean(),
    timezone: z.string(),
    venues: z.array(ClubVenueDtoSchema),
    /** Matchs FUTURS pour lesquels l'utilisateur peut demander une dérogation (équipes encadrées). */
    eligibleMatches: z.array(DerogationMatchRefDtoSchema.extend({ activeRequestId: z.string().uuid().nullable() })),
  })
  .openapi("DerogationContextDto");

export const SlotConflictDtoSchema = z
  .object({
    type: z.enum(["VENUE_MATCH", "TEAM_MATCH"]),
    matchId: z.string(),
    teamName: z.string().nullable(),
    opponentName: z.string().nullable(),
    startAt: z.string(),
    endAt: z.string(),
    venueName: z.string().nullable(),
  })
  .openapi("SlotConflictDto");

export const SlotWarningDtoSchema = z
  .object({
    type: z.literal("PENDING_REQUEST"),
    requestId: z.string(),
    teamName: z.string().nullable(),
    opponentName: z.string().nullable(),
    startAt: z.string(),
    endAt: z.string(),
  })
  .openapi("SlotWarningDto");

export const CandidateSlotDtoSchema = z
  .object({
    startAt: z.string(),
    endAt: z.string(),
    localStart: z.string(),
    localEnd: z.string(),
    available: z.boolean(),
    conflicts: z.array(SlotConflictDtoSchema),
    warnings: z.array(SlotWarningDtoSchema),
  })
  .openapi("CandidateSlotDto");

export const DerogationAvailabilityDtoSchema = z
  .object({
    matchType: z.enum(["HOME", "AWAY"]),
    date: z.string(),
    timezone: z.string(),
    rules: z.object({
      durationMinutes: z.number().int(),
      slotStepMinutes: z.number().int(),
      /** `null` : aucune plage configurée pour ce jour (en semaine en V1) — aucune restriction horaire. */
      earliestStart: z.string().nullable(),
      latestStart: z.string().nullable(),
      gridStart: z.string(),
      gridEnd: z.string(),
    }),
    venues: z.array(
      z.object({
        venue: ClubVenueDtoSchema,
        existingMatches: z.array(z.object({ matchId: z.string(), teamName: z.string().nullable(), opponentName: z.string().nullable(), startAt: z.string(), endAt: z.string(), localStart: z.string(), localEnd: z.string() })),
        pendingRequests: z.array(z.object({ requestId: z.string(), teamName: z.string().nullable(), opponentName: z.string().nullable(), startAt: z.string(), endAt: z.string(), localStart: z.string(), localEnd: z.string() })),
        candidateStartTimes: z.array(CandidateSlotDtoSchema),
      }),
    ),
    awayCandidateStartTimes: z.array(CandidateSlotDtoSchema),
  })
  .openapi("DerogationAvailabilityDto");

export const DerogationAvailabilityQueryDtoSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date doit être au format AAAA-MM-JJ.") }).openapi("DerogationAvailabilityQueryDto");

export const DerogationSlotCheckQueryDtoSchema = z
  .object({
    startAt: z.string().datetime({ offset: true }),
    venueId: z.string().uuid().optional(),
  })
  .openapi("DerogationSlotCheckQueryDto");

export const DerogationSlotCheckDtoSchema = z
  .object({
    ok: z.boolean(),
    code: z.string().nullable(),
    message: z.string().nullable(),
    startAt: z.string(),
    endAt: z.string(),
    conflicts: z.array(SlotConflictDtoSchema),
    warnings: z.array(SlotWarningDtoSchema),
  })
  .openapi("DerogationSlotCheckDto");

const MessageText = z.string().trim().min(1, "Le message ne peut pas être vide.").max(3000, "Le message ne peut pas dépasser 3000 caractères.");

export const CreateDerogationRequestDtoSchema = z
  .object({
    matchId: z.string().uuid(),
    requestedStartAt: z.string().datetime({ offset: true }),
    requestedVenueId: z.string().uuid().nullable().optional(),
    comment: MessageText.nullable().optional(),
    /** Uniquement si aucun nom exploitable n'est connu (voir DerogationContextDto.requesterNameSource = EMAIL). */
    requesterDisplayName: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict()
  .openapi("CreateDerogationRequestDto");

export const ProposeDerogationSlotDtoSchema = z
  .object({
    requestedStartAt: z.string().datetime({ offset: true }),
    requestedVenueId: z.string().uuid().nullable().optional(),
    message: MessageText.nullable().optional(),
  })
  .strict()
  .openapi("ProposeDerogationSlotDto");

export const PostDerogationMessageDtoSchema = z.object({ message: MessageText }).strict().openapi("PostDerogationMessageDto");

export const DerogationActionDtoSchema = z
  .object({
    action: DerogationActionSchema,
    message: MessageText.nullable().optional(),
  })
  .strict()
  .openapi("DerogationActionDto");

/** Résultat de l'envoi OFFICIEL (FBI) depuis une demande interne : résultat FBI réel + demande à jour. */
export const SubmitOfficialDerogationResultDtoSchema = z
  .object({
    outcome: z.enum(["success", "error", "unknown"]),
    message: z.string().nullable(),
    request: DerogationRequestDetailDtoSchema,
  })
  .openapi("SubmitOfficialDerogationResultDto");
