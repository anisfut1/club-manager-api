import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "./contracts/zod.js";
import { ClubDtoSchema, TeamDtoSchema, UpdateClubDtoSchema, CreateTeamDtoSchema, UpdateTeamDtoSchema } from "./contracts/clubs.js";
import { MatchListItemDtoSchema, MatchDetailsDtoSchema, MatchesQueryDtoSchema, MatchesPaginationDtoSchema } from "./contracts/matches.js";
import {
  IntegrationStatusDtoSchema,
  FbiIntegrationStatusDtoSchema,
  SyncRunDtoSchema,
  SaveFbiCredentialsDtoSchema,
  SaveFbiCredentialsResponseDtoSchema,
  PatchFbiIntegrationDtoSchema,
  PatchFfbbIntegrationDtoSchema,
} from "./contracts/integrations.js";
import { MatchDocumentDtoSchema } from "./contracts/documents.js";
import {
  DerogationStatusDtoSchema,
  DerogationListItemDtoSchema,
  RespondToDerogationDtoSchema,
  RespondToDerogationResultDtoSchema,
  CreateDerogationDtoSchema,
  CreateDerogationResultDtoSchema,
} from "./contracts/derogations.js";
import { IssueDtoSchema } from "./contracts/issues.js";
import { JobStatusDtoSchema } from "./contracts/jobs.js";
import { PlatformClubDtoSchema, CreateClubDtoSchema } from "./contracts/platform.js";
import {
  PurgeEmarqueDocumentsResultDtoSchema,
  DeleteOldSeasonsDtoSchema,
  DeleteOldSeasonsResultDtoSchema,
  RetryFailedEmarqueImportsResultDtoSchema,
} from "./contracts/maintenance.js";
import { ClubCapabilitiesSchema, ErrorEnvelopeSchema } from "./contracts/common.js";
import { EmarqueImportDtoSchema, EmarqueImportsQueryDtoSchema } from "./contracts/emarque.js";
import { MeDtoSchema } from "./contracts/me.js";
import {
  LicenciesListDtoSchema,
  LicencieDtoSchema,
  LicencieProfileDtoSchema,
  UpdateLicencieProfileDtoSchema,
  ImportLicenciesDtoSchema,
  ImportLicenciesResultDtoSchema,
  AutoAssignTeamsResultDtoSchema,
  DeleteLicencieResultDtoSchema,
} from "./contracts/licencies.js";
import {
  TableAssignmentRoleSchema,
  TableSuggestionsQueryDtoSchema,
  TableSuggestionsDtoSchema,
  TableAssignmentsQueryDtoSchema,
  TableAssignmentsListDtoSchema,
  PutTableAssignmentDtoSchema,
  TableAssignmentResultDtoSchema,
  PutRefereeStatusDtoSchema,
  RefereeStatusResultDtoSchema,
} from "./contracts/tables.js";
import {
  PublicClubDtoSchema,
  PublicLicenciesListDtoSchema,
  PublicMeDtoSchema,
  RequestPersonalLinkDtoSchema,
  RequestPersonalLinkResultDtoSchema,
  PublicTableAssignmentsListDtoSchema,
  PublicTableAssignmentsQueryDtoSchema,
  PublicTokenQueryDtoSchema,
  PublicAssignResultDtoSchema,
  PublicAccessListDtoSchema,
  PublicAccessResetResultDtoSchema,
} from "./contracts/public-tables.js";
import {
  CreateDerogationRequestDtoSchema,
  DerogationActionDtoSchema,
  DerogationAvailabilityDtoSchema,
  DerogationAvailabilityQueryDtoSchema,
  DerogationContextDtoSchema,
  DerogationRequestDetailDtoSchema,
  DerogationRequestListDtoSchema,
  DerogationRequestListQueryDtoSchema,
  DerogationSlotCheckDtoSchema,
  DerogationSlotCheckQueryDtoSchema,
  PostDerogationMessageDtoSchema,
  ProposeDerogationSlotDtoSchema,
} from "./contracts/derogation-requests.js";
import { ClubMemberListDtoSchema, InviteMemberDtoSchema, SetMemberRolesDtoSchema } from "./contracts/members.js";
import { PoolStandingsListDtoSchema } from "./contracts/standings.js";

/**
 * Spec OpenAPI assemblée à partir des MÊMES schémas zod que les DTO utilisés
 * par les routes (§37/§38 de la demande) — pas une documentation écrite à
 * la main séparément qui pourrait diverger. Les handlers eux-mêmes restent
 * du Hono simple (voir src/modules/**), cette spec sert de contrat lisible
 * et de base pour générer un client frontend.
 */
const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Jeton Supabase Auth du frontend (voir docs/AUTH.md).",
});

const bearerAuth = [{ BearerAuth: [] }];

function jsonResponse(description: string, schema: z.ZodTypeAny) {
  return { description, content: { "application/json": { schema } } };
}

const clubIdParam = z.object({ clubId: z.string().openapi({ description: "UUID ou slug du club" }) });
const clubAndMatchIdParams = clubIdParam.extend({ matchId: z.string().uuid() });
const clubAndDerogationIdParams = clubIdParam.extend({ derogationId: z.string().uuid() });
const clubAndJobParams = z.object({ jobId: z.string().uuid() });
const clubAndMatchIssueParams = clubIdParam.extend({ matchId: z.string().uuid() });
const clubAndMatchAndRoleParams = clubAndMatchIdParams.extend({ role: TableAssignmentRoleSchema });
const clubAndLicencieIdParams = clubIdParam.extend({ licencieId: z.string().uuid() });

const clubSlugParam = z.object({ clubSlug: z.string().openapi({ description: "Slug du club (flux public sans compte)" }) });
const clubSlugAndLicencieIdParams = clubSlugParam.extend({ licencieId: z.string().uuid() });
const clubSlugAndMatchIdParams = clubSlugParam.extend({ matchId: z.string().uuid() });
const clubSlugAndMatchAndRoleParams = clubSlugAndMatchIdParams.extend({ role: TableAssignmentRoleSchema });

const errorResponses = {
  401: jsonResponse("Non authentifié", ErrorEnvelopeSchema),
  403: jsonResponse("Accès refusé", ErrorEnvelopeSchema),
  404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
};
/** Ajouté aux routes qui valident un payload/query (zod) ou une précondition métier (ex: FBI_NOT_CONFIGURED). */
const validationResponses = { 400: jsonResponse("Requête invalide", ErrorEnvelopeSchema), 409: jsonResponse("Conflit métier", ErrorEnvelopeSchema) };

registry.registerPath({
  method: "get",
  path: "/v1/me",
  security: bearerAuth,
  responses: { 200: jsonResponse("Utilisateur courant", MeDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs",
  security: bearerAuth,
  responses: { 200: jsonResponse("Clubs dont l'utilisateur est membre", z.object({ clubs: z.array(ClubDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Détail du club", ClubDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: UpdateClubDtoSchema } } } },
  responses: { 200: jsonResponse("Club mis à jour (branding uniquement)", ClubDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/capabilities",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Capacités du club (FBI facultatif)", ClubCapabilitiesSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/teams",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Équipes du club (y compris sans engagement FFBB, voir docs/TEAMS.md)", z.object({ teams: z.array(TeamDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/teams",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: CreateTeamDtoSchema } } } },
  responses: { 201: jsonResponse("Équipe créée", TeamDtoSchema), ...errorResponses, ...validationResponses },
});

const clubAndTeamParams = clubIdParam.extend({ teamId: z.string().uuid() });

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/teams/{teamId}",
  security: bearerAuth,
  request: { params: clubAndTeamParams, body: { content: { "application/json": { schema: UpdateTeamDtoSchema } } } },
  responses: { 200: jsonResponse("Équipe mise à jour", TeamDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches",
  security: bearerAuth,
  request: { params: clubIdParam, query: MatchesQueryDtoSchema },
  responses: {
    200: jsonResponse("Matchs du club (filtrés, paginés)", z.object({ matches: z.array(MatchListItemDtoSchema), pagination: MatchesPaginationDtoSchema })),
    ...errorResponses,
    ...validationResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: { 200: jsonResponse("Détail du match", MatchDetailsDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/documents",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: { 200: jsonResponse("Documents e-Marque du match", z.object({ documents: z.array(MatchDocumentDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: {
    200: jsonResponse("Dernier état connu de la dérogation de ce match (null si aucune)", z.object({ derogation: DerogationStatusDtoSchema.nullable() })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation/check",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: {
    // Synchrone depuis 2026-09-28 (voir checkDerogationForMatchSync) —
    // jamais plus un job fbi_jobs à espérer voir traité par un clic futur.
    200: jsonResponse("Résultat immédiat de la vérification FBI de ce match", z.object({ found: z.boolean() })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/emarque-imports",
  security: bearerAuth,
  request: { params: clubIdParam, query: EmarqueImportsQueryDtoSchema },
  responses: {
    200: jsonResponse("Imports e-Marque du club (filtrés, paginés)", z.object({ imports: z.array(EmarqueImportDtoSchema), pagination: MatchesPaginationDtoSchema })),
    ...errorResponses,
    ...validationResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/integrations",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Statut des intégrations", IntegrationStatusDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: SaveFbiCredentialsDtoSchema } } } },
  responses: { 200: jsonResponse("Identifiants enregistrés (jamais le mot de passe)", SaveFbiCredentialsResponseDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/integrations/fbi",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: PatchFbiIntegrationDtoSchema } } } },
  responses: {
    200: jsonResponse("Réglages FBI mis à jour", z.object({ fbi: FbiIntegrationStatusDtoSchema })),
    ...errorResponses,
    ...validationResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/test",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    // Réponse toujours synchrone depuis le 2026-09-24 (voir docs/FBI.md) :
    // le repli navigateur (BROWSER_FBI_ENABLED) tourne DANS cette requête,
    // plus de pattern 202+jobId.
    200: jsonResponse("Résultat du test (HttpFbiClient, ou BrowserFbiClient en repli)", z.object({ success: z.boolean(), message: z.string() })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/process-jobs",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    200: jsonResponse(
      "Lot de jobs FBI du club traité (discover_emarque/test_connection en attente)",
      z.object({ claimed: z.number(), succeeded: z.number(), failed: z.number() }),
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/reconcile-schedule",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    // 200 (job empilé) plutôt que 202+jobId — même modèle qu'un `discover_emarque`
    // enqueue, consommé ensuite par POST .../fbi/process-jobs (ou le cron).
    200: jsonResponse("Job de rapprochement calendrier FFBB/FBI empilé (un seul par club à la fois)", z.object({ queued: z.literal(true) })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/check-all-derogations",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    // Synchrone depuis 2026-09-28 (voir checkAllDerogationsForClubSync).
    200: jsonResponse(
      "Résultat immédiat de la vérification globale FBI",
      z.object({ derogationsFound: z.number(), matched: z.number(), unmatched: z.number() }),
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogations",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Toutes les dérogations connues du club", z.object({ derogations: z.array(DerogationListItemDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogations/{derogationId}/respond",
  security: bearerAuth,
  // ÉCRIT réellement sur FBI/FFBB (accepter/refuser) — demande du club,
  // 2026-09-27 : "je veux le faire via loutil". Synchrone (jamais via
  // fbi_jobs), voir la doc de `respondToDerogationForClub`.
  request: { params: clubAndDerogationIdParams, body: { content: { "application/json": { schema: RespondToDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat RÉEL renvoyé par FBI (success/error/unknown)", RespondToDerogationResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation/respond",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams, body: { content: { "application/json": { schema: RespondToDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat RÉEL renvoyé par FBI (success/error/unknown)", RespondToDerogationResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/table-suggestions",
  security: bearerAuth,
  // STRICTEMENT en lecture (§37 de la demande "Tables de marque") — ne crée jamais d'affectation, voir computeTableSuggestions (fonction pure).
  request: { params: clubAndMatchIdParams, query: TableSuggestionsQueryDtoSchema },
  responses: { 200: jsonResponse("Candidats classés (recommandés/disponibles/indisponibles) pour ce rôle sur ce match", TableSuggestionsDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "put",
  path: "/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}",
  security: bearerAuth,
  // SEULE route qui transforme une suggestion en affectation réelle — recalcule toujours les conflits au moment de l'écriture (§42), jamais de force/override en V1 (§43).
  request: { params: clubAndMatchAndRoleParams, body: { content: { "application/json": { schema: PutTableAssignmentDtoSchema } } } },
  responses: { 200: jsonResponse("Affectation enregistrée", TableAssignmentResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "delete",
  path: "/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}",
  security: bearerAuth,
  request: { params: clubAndMatchAndRoleParams },
  responses: { 200: jsonResponse("Affectation retirée (poste remis à 'À attribuer')", z.object({ removed: z.literal(true) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/table-assignments",
  security: bearerAuth,
  // Matchs à DOMICILE uniquement (§4 de la demande "Tables de marque") — un match extérieur n'apparaît jamais dans cette liste.
  request: { params: clubIdParam, query: TableAssignmentsQueryDtoSchema },
  responses: { 200: jsonResponse("Matchs à domicile du club, avec leurs 4 postes (affectés ou 'à attribuer')", TableAssignmentsListDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "put",
  path: "/v1/clubs/{clubId}/matches/{matchId}/referee-status",
  security: bearerAuth,
  // Bascule "pas besoin d'arbitre" (retour du club, 2026-09-28) — n'affecte jamais table_assignments, voir match_referee_overrides.
  request: { params: clubAndMatchIdParams, body: { content: { "application/json": { schema: PutRefereeStatusDtoSchema } } } },
  responses: { 200: jsonResponse("Statut arbitre enregistré", RefereeStatusResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/table-assignments/public-access",
  security: bearerAuth,
  // club_admin uniquement (retour du club, 2026-09-29 : gestion d'accès/identité sans compte) — qui a revendiqué son lien personnel.
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("État des accès publics par licencié (revendiqué ou non)", PublicAccessListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/table-assignments/public-access/{licencieId}/reset",
  security: bearerAuth,
  // Révoque le jeton actif du licencié (lien perdu, etc.) — le nom redevient choisissable, les affectations existantes ne sont jamais touchées.
  request: { params: clubAndLicencieIdParams },
  responses: { 200: jsonResponse("Accès public réinitialisé", PublicAccessResetResultDtoSchema), ...errorResponses },
});

/**
 * Flux PUBLIC sans compte (retour du club, 2026-09-29) — AUCUNE de ces
 * routes ne porte `security: bearerAuth` : il n'y a pas de session
 * Supabase, l'identité vient du `token` (query string), voir
 * modules/public-tables/routes.ts.
 */
registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}",
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Infos club minimales (aucune donnée membre/rôle)", PublicClubDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/licencies",
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Roster pour choisir son nom (`claimed` seulement, jamais qui)", PublicLicenciesListDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "post",
  path: "/v1/public/clubs/{clubSlug}/licencies/{licencieId}/request-link",
  // Le jeton n'est JAMAIS dans la réponse : uniquement envoyé par email (Resend) — retour du club, 2026-10-01.
  request: { params: clubSlugAndLicencieIdParams, body: { content: { "application/json": { schema: RequestPersonalLinkDtoSchema } } } },
  responses: {
    200: jsonResponse("Lien personnel envoyé par email (adresse masquée)", RequestPersonalLinkResultDtoSchema),
    400: jsonResponse("Requête invalide ou email requis (EMAIL_REQUIRED)", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
    409: jsonResponse("Nom déjà choisi sans adresse email connue (ALREADY_CLAIMED)", ErrorEnvelopeSchema),
    429: jsonResponse("Lien envoyé il y a moins d'une minute (LINK_RECENTLY_SENT)", ErrorEnvelopeSchema),
    502: jsonResponse("Envoi refusé par le service d'email (EMAIL_SEND_FAILED)", ErrorEnvelopeSchema),
    503: jsonResponse("Envoi d'email non configuré (EMAIL_NOT_CONFIGURED)", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/derogations",
  // Lecture seule, réservée aux licenciés rattachés à un compte club_admin actif — retour du club, 2026-10-01.
  request: { params: clubSlugParam, query: PublicTokenQueryDtoSchema },
  responses: {
    200: jsonResponse("Dérogations connues du club (lecture seule)", z.object({ derogations: z.array(DerogationListItemDtoSchema) })),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Licencié non administrateur du club (CLUB_ADMIN_REQUIRED)", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/me",
  request: { params: clubSlugParam, query: PublicTokenQueryDtoSchema },
  responses: { 200: jsonResponse("Identité résolue depuis le jeton", PublicMeDtoSchema), 401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/table-assignments",
  request: { params: clubSlugParam, query: PublicTableAssignmentsQueryDtoSchema },
  responses: { 200: jsonResponse("Même contenu que la vue admin, avec `me`", PublicTableAssignmentsListDtoSchema), 401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "put",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}",
  // Auto-affectation UNIQUEMENT (licencieId vient du jeton, jamais du body) — ne remplace jamais un·e titulaire différent·e (retour du club, 2026-09-29).
  request: { params: clubSlugAndMatchAndRoleParams, query: PublicTokenQueryDtoSchema },
  responses: {
    200: jsonResponse("Auto-affectation enregistrée", PublicAssignResultDtoSchema),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
    409: jsonResponse("Conflit métier ou poste déjà occupé par quelqu'un d'autre", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}",
  // Retrait de SA PROPRE affectation uniquement — 403 si le poste appartient à quelqu'un d'autre (retour du club, 2026-09-29).
  request: { params: clubSlugAndMatchAndRoleParams, query: PublicTokenQueryDtoSchema },
  responses: {
    200: jsonResponse("Affectation retirée", z.object({ removed: z.literal(true) })),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Ce poste appartient à quelqu'un d'autre", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

/**
 * Vue PUBLIQUE en lecture seule des matchs (retour du club, 2026-09-29 :
 * "je veux une vue publique avec toutes les infos en vue directe... sans
 * compte, en libre service") — jamais de `security` ici, contrairement aux
 * routes `/v1/clubs/{clubId}/matches...` équivalentes ci-dessus : aucune
 * session Supabase requise. Mêmes DTOs de réponse (réutilisés tels quels,
 * voir `modules/matches/shared.ts`), sauf `documents[].downloadUrl` toujours
 * `null` ici (jamais d'URL signée pour un visiteur anonyme) et aucune route
 * d'écriture (dérogation créer/répondre, vérifier sur FBI — `club_admin`
 * uniquement, jamais exposées publiquement).
 */
registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/standings",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Classements FFBB des poules où le club est engagé", PoolStandingsListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/standings",
  // Classements FFBB des poules où le club est engagé — retour du club, 2026-10-01.
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Classements FFBB (copiés à chaque synchronisation)", PoolStandingsListDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/teams",
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Équipes du club (pour le filtre de la liste des matchs)", z.object({ teams: z.array(TeamDtoSchema) })), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches",
  request: { params: clubSlugParam, query: MatchesQueryDtoSchema },
  responses: {
    200: jsonResponse("Matchs du club (filtrés, paginés) — mêmes filtres que la route authentifiée", z.object({ matches: z.array(MatchListItemDtoSchema), pagination: MatchesPaginationDtoSchema })),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
    ...validationResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}",
  request: { params: clubSlugAndMatchIdParams },
  responses: { 200: jsonResponse("Détail du match (composition, statistiques, officiels, e-Marque)", MatchDetailsDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/documents",
  request: { params: clubSlugAndMatchIdParams },
  responses: {
    200: jsonResponse("Documents e-Marque du match — `downloadUrl` toujours `null` (jamais d'URL signée en public)", z.object({ documents: z.array(MatchDocumentDtoSchema) })),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/derogation",
  request: { params: clubSlugAndMatchIdParams },
  responses: {
    200: jsonResponse("Dernier état connu de la dérogation de ce match (null si aucune)", z.object({ derogation: DerogationStatusDtoSchema.nullable() })),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation/create",
  security: bearerAuth,
  // ÉCRIT réellement sur FBI/FFBB (crée une nouvelle dérogation) — demande
  // du club, 2026-09-28 : "mtn faut en créer une". Synchrone, voir la doc
  // de `createDerogationForClub`.
  request: { params: clubAndMatchIdParams, body: { content: { "application/json": { schema: CreateDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat RÉEL renvoyé par FBI (success/error/unknown)", CreateDerogationResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/parse-documents",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    200: jsonResponse(
      "Lot de documents e-Marque téléchargés du club parsés (OCR/PDF, jamais de navigateur)",
      z.object({ candidatesExamined: z.number(), imported: z.number(), errors: z.number() }),
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/sync-runs",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Historique des synchronisations", z.object({ syncRuns: z.array(SyncRunDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/ffbb/sync",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Résultat de la synchronisation", z.object({ syncRunId: z.string().uuid(), status: z.string(), stats: z.record(z.string(), z.number()) })), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/integrations/ffbb",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: PatchFfbbIntegrationDtoSchema } } } },
  responses: {
    200: jsonResponse(
      "Intégration FFBB mise à jour (jamais de suppression de l'historique déjà synchronisé)",
      z.object({ clubCode: z.string(), enabled: z.boolean(), nextSyncAt: z.string().nullable() }),
    ),
    ...errorResponses,
    ...validationResponses,
  },
});

const clubAndLicencieParams = clubIdParam.extend({ licencieId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/licencies",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Roster du club", LicenciesListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}",
  security: bearerAuth,
  request: { params: clubAndLicencieParams },
  responses: { 200: jsonResponse("Fiche joueur : identité, historique des matchs, statistiques par match", LicencieProfileDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}/profile",
  security: bearerAuth,
  request: { params: clubAndLicencieParams, body: { content: { "application/json": { schema: UpdateLicencieProfileDtoSchema } } } },
  responses: {
    200: jsonResponse("Profil mis à jour (champs admin, ou contact/photo si le licencié lui-même)", LicencieDtoSchema),
    ...errorResponses,
    ...validationResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies/import",
  security: bearerAuth,
  // Import en masse depuis un export FBI, club_admin uniquement — voir la
  // doc de la route (routes.ts) pour le dédoublonnage par ffbbLicenceId.
  request: { params: clubIdParam, body: { content: { "application/json": { schema: ImportLicenciesDtoSchema } } } },
  responses: { 200: jsonResponse("Import terminé (total/inserted/skipped)", ImportLicenciesResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies/auto-assign-teams",
  security: bearerAuth,
  // Répartition automatique best-effort des licenciés sans équipe,
  // club_admin uniquement — voir auto-assign-teams.ts pour l'algorithme.
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Répartition terminée (total/assigned/skipped)", AutoAssignTeamsResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "delete",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}",
  security: bearerAuth,
  // Suppression définitive, club_admin uniquement — voir la doc de
  // DeleteLicencieResultDtoSchema (sûre sans condition, jamais de perte
  // d'historique de match).
  request: { params: clubAndLicencieParams },
  responses: { 200: jsonResponse("Licencié supprimé", DeleteLicencieResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/issues",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Anomalies e-Marque à vérifier", z.object({ issues: z.array(IssueDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/issues/{matchId}/resolve",
  security: bearerAuth,
  request: { params: clubAndMatchIssueParams },
  responses: { 200: jsonResponse("Anomalie résolue", z.object({ resolved: z.literal(true) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/jobs/{jobId}",
  security: bearerAuth,
  request: { params: clubAndJobParams },
  responses: { 200: jsonResponse("Statut du job", JobStatusDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/platform/clubs",
  security: bearerAuth,
  responses: { 200: jsonResponse("Clubs de la plateforme (platform_admin)", z.object({ clubs: z.array(PlatformClubDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/clubs",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateClubDtoSchema } } } },
  responses: { 201: jsonResponse("Club créé", z.object({ clubId: z.string().uuid(), slug: z.string(), adminInviteError: z.string().nullable() })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/maintenance/purge-emarque-documents",
  security: bearerAuth,
  // Retour du club, 2026-09-29 : purge RÉTROACTIVE de tout document e-Marque encore présent en Storage — les nouveaux sont déjà purgés automatiquement après parsing.
  responses: { 200: jsonResponse("Purge terminée (idempotente, jamais destructive pour les stats déjà en base)", PurgeEmarqueDocumentsResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/maintenance/delete-old-seasons",
  security: bearerAuth,
  // IRRÉVERSIBLE — retour du club, 2026-09-29 : "focus saison 2026-2027". `clubId` obligatoire, jamais un défaut "tous les clubs".
  request: { body: { content: { "application/json": { schema: DeleteOldSeasonsDtoSchema } } } },
  responses: { 200: jsonResponse("Matchs des saisons précédentes supprimés (cascade FK sur toutes les données liées)", DeleteOldSeasonsResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/maintenance/retry-failed-emarque-imports",
  security: bearerAuth,
  // Retour du club, 2026-09-29 : relance les matchs `error` en réutilisant le fichier déjà téléchargé — jamais `needs_review` (fichier déjà purgé sur le chemin de succès).
  responses: { 200: jsonResponse("Nouvelle tentative terminée (réutilise le fichier déjà en Storage, jamais un nouveau téléchargement FBI)", RetryFailedEmarqueImportsResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/health",
  responses: { 200: jsonResponse("État du service", z.object({ status: z.literal("ok") })) },
});

/**
 * DEMANDES DE DÉROGATION INTERNES (coach → coordinateur) — retour du club,
 * 2026-10-01. Aucune de ces routes n'écrit sur FFBB/FBI ni ne modifie un
 * match : workflow interne (demande + statut + conversation).
 */
const clubAndRequestParams = clubIdParam.extend({ requestId: z.string().uuid() });
const unprocessable = { 422: jsonResponse("Règle métier non respectée (ex. MESSAGE_REQUIRED)", ErrorEnvelopeSchema) };

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogation-requests/context",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Demandeur, coordinateur configuré, gymnases, matchs éligibles", DerogationContextDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogation-requests",
  security: bearerAuth,
  request: { params: clubIdParam, query: DerogationRequestListQueryDtoSchema },
  responses: { 200: jsonResponse("Inbox coordinateur / demandes du coach", DerogationRequestListDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: CreateDerogationRequestDtoSchema } } } },
  responses: {
    201: jsonResponse("Demande créée (créneau revalidé côté serveur)", DerogationRequestDetailDtoSchema),
    ...errorResponses,
    400: jsonResponse("Requête invalide, créneau hors plage/passé, gymnase requis", ErrorEnvelopeSchema),
    409: jsonResponse("DEROGATION_SLOT_CONFLICT (avec details.conflicts), NO_COORDINATOR, DEROGATION_REQUEST_ALREADY_ACTIVE, MATCH_NOT_UPCOMING", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}",
  security: bearerAuth,
  request: { params: clubAndRequestParams },
  responses: { 200: jsonResponse("Demande, match, propositions, conversation, permissions", DerogationRequestDetailDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}/messages",
  security: bearerAuth,
  request: { params: clubAndRequestParams, body: { content: { "application/json": { schema: PostDerogationMessageDtoSchema } } } },
  responses: { 200: jsonResponse("Message ajouté (demande à jour)", DerogationRequestDetailDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}/actions",
  security: bearerAuth,
  request: { params: clubAndRequestParams, body: { content: { "application/json": { schema: DerogationActionDtoSchema } } } },
  responses: { 200: jsonResponse("Statut mis à jour + événement système", DerogationRequestDetailDtoSchema), ...errorResponses, ...validationResponses, ...unprocessable },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}/proposals",
  security: bearerAuth,
  request: { params: clubAndRequestParams, body: { content: { "application/json": { schema: ProposeDerogationSlotDtoSchema } } } },
  responses: { 200: jsonResponse("Nouveau créneau proposé (historique conservé)", DerogationRequestDetailDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation-availability",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams, query: DerogationAvailabilityQueryDtoSchema },
  responses: { 200: jsonResponse("Occupation des gymnases + créneaux candidats (match cible exclu)", DerogationAvailabilityDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation-slot-check",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams, query: DerogationSlotCheckQueryDtoSchema },
  responses: { 200: jsonResponse("Vérification serveur d'une heure personnalisée", DerogationSlotCheckDtoSchema), ...errorResponses, ...validationResponses },
});

/** Membres & rôles (club_admin) — désignation des coachs et du coordinateur. */
const clubAndMembershipParams = clubIdParam.extend({ membershipId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/members",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Membres du club et leurs rôles", ClubMemberListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/members",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: InviteMemberDtoSchema } } } },
  responses: { 201: jsonResponse("Membre invité/rattaché", ClubMemberListDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "put",
  path: "/v1/clubs/{clubId}/members/{membershipId}/roles",
  security: bearerAuth,
  request: { params: clubAndMembershipParams, body: { content: { "application/json": { schema: SetMemberRolesDtoSchema } } } },
  responses: { 200: jsonResponse("Rôles remplacés", ClubMemberListDtoSchema), ...errorResponses, ...validationResponses },
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "club-manager-api",
      version: "0.2.0",
      description: "Backend REST du SaaS multi-clubs (FFBB/FBI/e-Marque). Voir docs/API.md.",
    },
    servers: [{ url: "/", description: "Ce déploiement" }],
  });
}
