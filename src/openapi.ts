import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "./contracts/zod.js";
import { ClubDtoSchema, TeamDtoSchema, UpdateClubDtoSchema } from "./contracts/clubs.js";
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
import { IssueDtoSchema } from "./contracts/issues.js";
import { JobStatusDtoSchema } from "./contracts/jobs.js";
import { PlatformClubDtoSchema, CreateClubDtoSchema } from "./contracts/platform.js";
import { ClubCapabilitiesSchema, ErrorEnvelopeSchema } from "./contracts/common.js";
import { EmarqueImportDtoSchema, EmarqueImportsQueryDtoSchema } from "./contracts/emarque.js";
import { MeDtoSchema } from "./contracts/me.js";

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
const clubAndJobParams = z.object({ jobId: z.string().uuid() });
const clubAndMatchIssueParams = clubIdParam.extend({ matchId: z.string().uuid() });

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
  responses: { 200: jsonResponse("Équipes du club", z.object({ teams: z.array(TeamDtoSchema) })), ...errorResponses },
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
    200: jsonResponse("Résultat du test (HttpFbiClient)", z.object({ success: z.boolean(), message: z.string() })),
    202: jsonResponse("Job navigateur empilé en secours", z.object({ success: z.literal(false), message: z.string(), jobId: z.string().uuid() })),
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
