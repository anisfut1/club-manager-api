import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

/**
 * Un seul endroit où `.openapi()` est ajouté à zod — tous les modules de
 * `contracts/` importent `z` D'ICI, jamais directement de `"zod"`, sinon
 * `.openapi()` n'existe pas sur les schémas qu'ils construisent (§37/§38 de
 * la demande : les DTO zod sont la même source de vérité pour la
 * validation ET pour /openapi.json, voir src/openapi.ts).
 */
extendZodWithOpenApi(z);

export { z };
