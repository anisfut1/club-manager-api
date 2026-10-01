import type { MiddlewareHandler } from "hono";
import type { DbClient } from "../../db/client.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { badRequest, notFound } from "../../api-error.js";

/**
 * Club minimal exposé aux flux publics (sans compte) — jamais de données
 * membres/rôles/FFBB ici, seulement ce qu'un visiteur anonyme peut voir.
 * Partagé par tous les modules `public-*` (Tables de marque, matchs...) :
 * même résolution, même prudence RLS (voir la doc de `resolvePublicClub`
 * ci-dessous).
 */
export interface PublicClub {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  accentColor: string | null;
  timezone: string;
}

/**
 * Middleware générique : résout le club via son slug (jamais son UUID — le
 * slug seul est distribué dans les liens publics) et bascule sur le client
 * service role (RLS bypass). Toute route d'un module public DOIT filtrer
 * manuellement par `publicClub.id` sur chacune de ses requêtes — c'est CE
 * CODE, pas la RLS, qui garantit l'isolation multi-tenant ici (même
 * raisonnement que `fbi_credentials`, voir docs/MULTI_TENANCY.md).
 *
 * Générique sur `Env` pour être réutilisable par plusieurs routeurs Hono
 * distincts montés sous `/v1/public/clubs/:clubSlug` (voir
 * `src/api/v1/index.ts`), chacun avec son propre type d'environnement tant
 * qu'il expose au moins `supabase`/`publicClub` dans ses `Variables`.
 */
export function resolvePublicClub<Env extends { Variables: { supabase: DbClient; publicClub: PublicClub } }>(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const slug = c.req.param("clubSlug");
    if (!slug) throw badRequest("Paramètre de route :clubSlug manquant.");

    const supabase = createServiceSupabaseClient();
    const { data: club } = await supabase.from("clubs").select("id, slug, name, logo_url, accent_color, timezone, status").eq("slug", slug).maybeSingle();

    // 404 générique, jamais de distinction "club inexistant" vs "club suspendu" — même prudence que requireClubContext côté admin.
    if (!club || club.status !== "active") throw notFound("Club introuvable.");

    c.set("supabase", supabase);
    c.set("publicClub", { id: club.id, slug: club.slug, name: club.name, logoUrl: club.logo_url, accentColor: club.accent_color, timezone: club.timezone });

    await next();
  };
}
