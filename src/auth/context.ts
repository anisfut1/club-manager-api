import type { DbClient } from "../db/client.js";
import type { AuthUser } from "./jwt.js";
import type { ClubContext } from "../tenancy/club-context.js";

/**
 * Variables Hono peuplées par les middlewares de src/auth/middleware.ts —
 * un seul endroit typé plutôt que des `c.get("...")` non typés dispersés
 * dans les handlers (§10 de la demande : "éviter les contrôles dispersés").
 */
export interface AppVariables {
  user: AuthUser;
  /** Client Supabase "au nom de l'utilisateur" (RLS active, voir src/db/client.ts). */
  supabase: DbClient;
  /** Peuplé par `requireClubMembership()` — jamais avant, jamais sans avoir vérifié l'appartenance. */
  club: ClubContext;
  isPlatformAdmin: boolean;
}

export type AppEnv = { Variables: AppVariables };
