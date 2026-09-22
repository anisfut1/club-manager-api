import type { MiddlewareHandler } from "hono";
import { createUserSupabaseClient } from "../db/client.js";
import { badRequest, forbidden } from "../api-error.js";
import { extractBearerToken, verifyAccessToken } from "./jwt.js";
import { requireClubContext } from "../tenancy/club-context.js";
import { hasRole, type ClubRole } from "../tenancy/roles.js";
import type { AppEnv } from "./context.js";

/**
 * Flux d'authentification (§9 de la demande) :
 * Supabase Auth (frontend) → JWT → `Authorization: Bearer <JWT>` →
 * `requireAuth()` (valide le JWT, construit un client Supabase RLS-bound
 * "au nom de l'utilisateur") → `requireClubMembership()` (vérifie
 * l'appartenance via LA RLS, jamais en faisant confiance à `clubId` seul)
 * → `requireClubRole()` (vérifie le rôle) selon la route.
 */

/** Doit être le PREMIER middleware de toute route protégée. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"));
  const user = await verifyAccessToken(token);

  c.set("user", user);
  c.set("supabase", createUserSupabaseClient(token));

  await next();
};

/**
 * Nécessite `requireAuth` en amont et un paramètre de route `:clubId`
 * (UUID ou slug, voir src/tenancy/club-context.ts). Lève 404 (jamais 403)
 * si le club n'existe pas OU si l'utilisateur n'en est pas membre — ne
 * révèle jamais l'existence d'un club à un non-membre.
 */
export const requireClubMembership: MiddlewareHandler<AppEnv> = async (c, next) => {
  const clubIdOrSlug = c.req.param("clubId");
  if (!clubIdOrSlug) throw badRequest("Paramètre de route :clubId manquant.");

  const context = await requireClubContext(c.get("supabase"), clubIdOrSlug, c.get("user").id);

  c.set("club", context);

  await next();
};

/** Nécessite `requireClubMembership` en amont. Lève 403 si le rôle est absent. */
export function requireClubRole(role: ClubRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const club = c.get("club");
    if (!hasRole(club.roles, role)) {
      throw forbidden(`Ce rôle (${role}) est requis sur ce club.`);
    }
    await next();
  };
}

/** Nécessite `requireAuth` en amont. Vérifie `platform_admins` via la fonction RPC `is_platform_admin` (SECURITY DEFINER, voir supabase/migrations). */
export const requirePlatformAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { data, error } = await c.get("supabase").rpc("is_platform_admin");

  if (error || !data) {
    throw forbidden("Réservé aux administrateurs de la plateforme.");
  }

  c.set("isPlatformAdmin", true);

  await next();
};
