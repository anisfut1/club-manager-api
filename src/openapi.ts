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
} from "./contracts/tables.js";

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
  responses: { 200: jsonResponse("Matchs à domicile du club, avec leurs 3 postes (affectés ou 'à attribuer')", TableAssignmentsListDtoSchema), ...errorResponses, ...validationResponses },
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
  method: "get",
  path: "/health",
  responses: { 200: jsonResponse("État du service", z.object({ status: z.literal("ok") })) },
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
