import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "./openapi.js";

/**
 * §26 de la demande : garantit que toute route/DTO nouvellement ajoutée
 * est RÉELLEMENT présente dans le document généré — jamais un endpoint qui
 * existe côté handler mais pas dans le contrat que SCSB génère avec
 * `npm run api:generate`.
 */
describe("generateOpenApiDocument", () => {
  const doc = generateOpenApiDocument();

  it("expose les 8 routes/champs des gaps résolus dans cette phase", () => {
    expect(doc.paths).toHaveProperty("/v1/clubs/{clubId}");
    expect(doc.paths["/v1/clubs/{clubId}"]).toHaveProperty("patch"); // gap 1

    expect(doc.paths).toHaveProperty(["/v1/clubs/{clubId}/integrations/ffbb"]);
    expect(doc.paths["/v1/clubs/{clubId}/integrations/ffbb"]).toHaveProperty("patch"); // gap 2

    expect(doc.paths["/v1/me"]!.get!.responses["200"].content["application/json"].schema.$ref).toContain("MeDto"); // gap 3

    expect(doc.paths["/v1/clubs/{clubId}/integrations/fbi"]).toHaveProperty("patch"); // gap 4

    expect(doc.paths).toHaveProperty("/v1/clubs/{clubId}/emarque-imports"); // gap 5

    expect(doc.components?.schemas).toHaveProperty("MatchDocumentDto"); // documents (mimeType/discoveredAt)

    expect(doc.components?.schemas).toHaveProperty("IssueDto"); // gap 6

    expect(doc.paths["/v1/clubs/{clubId}/matches"]!.get!.parameters?.length).toBeGreaterThan(0); // gap 7 (query params documentés)

    expect(doc.components?.schemas).toHaveProperty("FbiIntegrationStatusDto"); // gap 8 (username)
  });

  it("documente le username FBI dans le schéma, jamais password/ciphertext", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = (doc.components?.schemas as any).FbiIntegrationStatusDto;
    expect(schema.properties).toHaveProperty("username");
    expect(schema.properties).not.toHaveProperty("password");
    expect(JSON.stringify(schema)).not.toMatch(/ciphertext|password/i);
  });

  it("documente les query params de GET /v1/clubs/:clubId/matches (period/from/to/teamId/homeAway/status/limit/offset)", () => {
    const params = doc.paths["/v1/clubs/{clubId}/matches"]!.get!.parameters ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = params.filter((p: any) => p.in === "query").map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(["period", "from", "to", "teamId", "homeAway", "status", "limit", "offset"]));
  });

  it("expose les 4 routes du module Tables de marque (demande du club, 2026-09-28)", () => {
    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-suggestions"]).toHaveProperty("get");
    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}"]).toHaveProperty("put");
    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}"]).toHaveProperty("delete");
    expect(doc.paths["/v1/clubs/{clubId}/table-assignments"]).toHaveProperty("get");

    expect(doc.components?.schemas).toHaveProperty("TableSuggestionsDto");
    expect(doc.components?.schemas).toHaveProperty("TableAssignmentsListDto");

    // ?role= obligatoire (§37 : contrat le plus propre, une seule route couvre les rôles).
    const suggestionsParams = doc.paths["/v1/clubs/{clubId}/matches/{matchId}/table-suggestions"]!.get!.parameters ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roleParam = suggestionsParams.find((p: any) => p.in === "query" && p.name === "role") as any;
    expect(roleParam).toBeDefined();
    expect(roleParam.required).toBe(true);
  });

  it("expose REFEREE comme 4e rôle et la route de bascule 'pas besoin d'arbitre' (retour du club, 2026-09-28)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roleSchema = (doc.components?.schemas as any).TableAssignmentRole;
    expect(roleSchema.enum).toEqual(expect.arrayContaining(["SCORER", "TIMEKEEPER", "CLUB_DELEGATE", "REFEREE"]));

    expect(doc.paths["/v1/clubs/{clubId}/matches/{matchId}/referee-status"]).toHaveProperty("put");
    expect(doc.components?.schemas).toHaveProperty("PutRefereeStatusDto");
    expect(doc.components?.schemas).toHaveProperty("RefereeStatusResultDto");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const forMatchSchema = (doc.components?.schemas as any).TableAssignmentsForMatchDto;
    expect(forMatchSchema.properties).toHaveProperty("refereeNotNeeded");
  });

  it("génère un document valide (openapi 3.0.0, titre, au moins 15 routes)", () => {
    expect(doc.openapi).toBe("3.0.0");
    expect(doc.info.title).toBe("club-manager-api");
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(15);
  });
});
