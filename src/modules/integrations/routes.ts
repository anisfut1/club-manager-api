import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { badRequest, conflict } from "../../api-error.js";
import { getFbiCredentials, getFbiUsername, saveFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { HttpFbiClient } from "../../integrations/fbi/http-client.js";
import { FbiError, type FbiErrorCode } from "../../integrations/fbi/errors.js";
import { FfbbPublicProvider } from "../../integrations/ffbb/public-provider.js";
import { syncFfbb } from "../../integrations/ffbb/sync.js";
import { getEnv } from "../../config/env.js";
import { logError } from "../../logger.js";
import {
  PatchFbiIntegrationDtoSchema,
  PatchFfbbIntegrationDtoSchema,
  type FbiIntegrationStatusDto,
  type IntegrationStatusDto,
  type SyncRunDto,
} from "../../contracts/integrations.js";
import type { DbClient } from "../../db/client.js";

export const integrationsRouter = new Hono<AppEnv>();

integrationsRouter.use("*", requireAuth);
integrationsRouter.use("*", requireClubMembership);

function messageForFbiErrorCode(code: FbiErrorCode): string {
  switch (code) {
    case "LOGIN_FAILED":
      return "Connexion FBI impossible : identifiant ou mot de passe incorrect.";
    case "LOGIN_PAGE_UNREACHABLE":
      return "Connexion FBI impossible : le site FBI est injoignable pour le moment. Réessaie plus tard.";
    case "LOGIN_FORM_NOT_RECOGNIZED":
      return "Connexion FBI impossible : la page de connexion FBI a changé de structure.";
    case "EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED":
      return "Connecté à FBI, mais la récupération des documents e-Marque n'est pas encore confirmée techniquement.";
    default:
      return "Connexion FBI impossible.";
  }
}

/**
 * Construit le statut FBI exposé à l'API (gap 8 de la demande) : lit
 * `fbi_integration_status` via le client passé (RLS pour une lecture,
 * service role pour rester cohérent juste après une écriture service
 * role) ET `fbi_credentials.username` — JAMAIS le mot de passe/ciphertext,
 * voir `credentials-store.ts#getFbiUsername`.
 */
async function buildFbiStatusDto(supabase: DbClient, clubId: string): Promise<FbiIntegrationStatusDto> {
  const [{ data: fbiStatus }, username] = await Promise.all([
    supabase.from("fbi_integration_status").select("configured, last_login_success, last_login_at, auto_import_emarque, last_error").eq("club_id", clubId).maybeSingle(),
    getFbiUsername(supabase, clubId),
  ]);

  return {
    configured: fbiStatus?.configured ?? false,
    username,
    connected: fbiStatus?.last_login_success ?? false,
    lastLoginAt: fbiStatus?.last_login_at ?? null,
    autoImportEmarque: fbiStatus?.auto_import_emarque ?? false,
    lastError: fbiStatus?.last_error ?? null,
  };
}

/** GET /v1/clubs/:clubId/integrations */
integrationsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const [{ data: lastFfbbRun }, fbi] = await Promise.all([
    supabase.from("sync_runs").select("started_at, status").eq("club_id", club.id).eq("provider", "ffbb").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    buildFbiStatusDto(supabase, club.id),
  ]);

  const dto: IntegrationStatusDto = {
    ffbb: {
      enabled: club.ffbbEnabled,
      lastSyncAt: lastFfbbRun?.started_at ?? null,
      lastSyncStatus: lastFfbbRun?.status ?? null,
    },
    fbi,
  };

  return c.json(dto);
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi — enregistre les identifiants
 * (chiffrés, AAD=club_id, §34 de la demande). `fbi_credentials` n'a AUCUNE
 * policy RLS pour `authenticated` (voir supabase/migrations) : le client
 * service role est utilisé ICI, seulement après que `requireClubRole`
 * a vérifié le rôle via LA RLS. Réponse enrichie (§14 de la demande) —
 * jamais le mot de passe, jamais le ciphertext.
 */
integrationsRouter.post("/fbi", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}) as { username?: string; password?: string });

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";

  if (!username) throw badRequest("L'identifiant est requis.");

  const serviceSupabase = createServiceSupabaseClient();

  if (password) {
    await saveFbiCredentials(serviceSupabase, club.id, { username, password }, user.id);
  } else {
    const existing = await getFbiCredentials(serviceSupabase, club.id);
    if (!existing) throw badRequest("Un mot de passe est requis lors du premier enregistrement.");
    await saveFbiCredentials(serviceSupabase, club.id, { username, password: existing.password }, user.id);
  }

  const fbi = await buildFbiStatusDto(serviceSupabase, club.id);
  return c.json({ saved: true as const, fbi });
});

/**
 * PATCH /v1/clubs/:clubId/integrations/fbi (gap 4 de la demande) — active/
 * désactive l'intégration ou l'auto-import e-Marque SANS redemander les
 * identifiants. `enabled` pilote `fbi_integration_status.configured`
 * (§16 de la demande : réutilise la colonne existante plutôt que d'en
 * ajouter une redondante) — le désactiver ne supprime jamais les
 * identifiants déjà enregistrés, seulement l'exposition de la capability
 * (voir `tenancy/club-capabilities.ts`).
 *
 * `autoImportEmarque=true` sans identifiants configurés est une erreur
 * métier explicite (`FBI_NOT_CONFIGURED`, §6 de la demande), pas un 400
 * générique.
 */
integrationsRouter.patch("/fbi", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const body = await c.req.json().catch(() => ({}));
  const parsed = PatchFbiIntegrationDtoSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));
  }

  const serviceSupabase = createServiceSupabaseClient();

  // Seule une valeur `true` a une précondition (des identifiants doivent
  // déjà exister) — désactiver l'un ou l'autre réglage est toujours permis,
  // sans condition (§6 de la demande).
  const requiresCredentials = parsed.data.enabled === true || parsed.data.autoImportEmarque === true;
  if (requiresCredentials) {
    const existing = await getFbiCredentials(serviceSupabase, club.id);
    if (!existing) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant d'activer cette intégration.", "FBI_NOT_CONFIGURED");
  }

  const patch: { club_id: string; updated_at: string; configured?: boolean; auto_import_emarque?: boolean } = {
    club_id: club.id,
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.enabled !== undefined) patch.configured = parsed.data.enabled;
  if (parsed.data.autoImportEmarque !== undefined) patch.auto_import_emarque = parsed.data.autoImportEmarque;

  const { error } = await serviceSupabase.from("fbi_integration_status").upsert(patch, { onConflict: "club_id" });
  if (error) throw new Error(`Mise à jour des réglages FBI échouée : ${error.message}`);

  const fbi = await buildFbiStatusDto(serviceSupabase, club.id);
  return c.json({ fbi });
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi/test — teste réellement la
 * stratégie principale (`HttpFbiClient`, §35 de la demande). Chemin
 * synchrone : le login HTTP est rapide, pas besoin du pattern 202+jobId ici.
 * Si l'échec est `LOGIN_FORM_NOT_RECOGNIZED` et que
 * `BROWSER_FBI_ENABLED=true`, un job `test_connection` (navigateur) est
 * empilé en secours et son id renvoyé pour suivi via `GET /v1/jobs/:jobId`.
 */
integrationsRouter.post("/fbi/test", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();
  const credentials = await getFbiCredentials(serviceSupabase, club.id);

  if (!credentials) {
    return c.json({ success: false, message: "Aucun identifiant FBI enregistré pour l'instant." }, 200);
  }

  const testedAt = new Date().toISOString();
  const client = new HttpFbiClient({ baseUrl: getEnv().FBI_BASE_URL });

  try {
    await client.login(credentials);

    await serviceSupabase.from("fbi_integration_status").upsert(
      { club_id: club.id, configured: true, last_test_at: testedAt, last_test_success: true, last_test_message: "Connexion réussie.", last_login_at: testedAt, last_login_success: true, updated_at: testedAt },
      { onConflict: "club_id" },
    );

    return c.json({ success: true, message: "FBI connecté ✅" });
  } catch (error) {
    const message = error instanceof FbiError ? messageForFbiErrorCode(error.code) : "Connexion FBI impossible.";

    await serviceSupabase.from("fbi_integration_status").upsert(
      { club_id: club.id, configured: true, last_test_at: testedAt, last_test_success: false, last_test_message: message, last_login_success: false, last_error: message, updated_at: testedAt },
      { onConflict: "club_id" },
    );

    logError("Test de connexion FBI échoué", error, { clubId: club.id });

    if (error instanceof FbiError && error.code === "LOGIN_FORM_NOT_RECOGNIZED" && getEnv().BROWSER_FBI_ENABLED) {
      const { data: job } = await serviceSupabase.from("fbi_jobs").insert({ club_id: club.id, type: "test_connection" }).select("id").single();
      if (job) return c.json({ success: false, message, jobId: job.id }, 202);
    }

    return c.json({ success: false, message });
  }
});

/** GET /v1/clubs/:clubId/sync-runs */
integrationsRouter.get("/sync-runs", async (c) => {
  const { club } = c.get("club");
  const { data, error } = await c
    .get("supabase")
    .from("sync_runs")
    .select("id, provider, status, started_at, finished_at, error_log")
    .eq("club_id", club.id)
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(`Lecture des synchronisations échouée : ${error.message}`);

  const syncRuns: SyncRunDto[] = (data ?? []).map((run) => ({
    id: run.id,
    provider: run.provider,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    errorLog: run.error_log,
  }));

  return c.json({ syncRuns });
});

/** POST /v1/clubs/:clubId/integrations/ffbb/sync — diagnostic admin (§18 de la demande), le cron fait déjà tourner ce même service automatiquement. */
integrationsRouter.post("/ffbb/sync", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();

  try {
    const result = await syncFfbb(serviceSupabase, new FfbbPublicProvider(), { id: club.id, ffbbClubId: club.ffbbClubId });
    return c.json({ syncRunId: result.syncRunId, status: result.status, stats: result.stats });
  } catch (error) {
    logError("Synchronisation FFBB manuelle échouée", error, { clubId: club.id });
    throw error;
  }
});

/**
 * PATCH /v1/clubs/:clubId/integrations/ffbb (gap 2 de la demande) — change
 * la source FFBB (`clubCode`) et/ou active/désactive la synchro
 * (`enabled`). `ffbb_club_id`/`ffbb_enabled`/`ffbb_next_sync_at` ne sont
 * PAS dans le privilège de colonne `authenticated` sur `clubs` (voir
 * `PATCH /v1/clubs/:clubId` plus haut) : cette route utilise volontairement
 * la service role, seulement après `requireClubRole("club_admin")`, même
 * schéma que `POST .../fbi`.
 *
 * Change de source de données SANS jamais supprimer l'historique déjà
 * synchronisé (§4 de la demande) — un `UPDATE` sur `clubs`, jamais un
 * `DELETE` sur `matches`. Un changement de code valide replanifie
 * immédiatement une resynchronisation (`ffbb_next_sync_at = now()`)
 * plutôt que d'attendre jusqu'à `FFBB_SYNC_INTERVAL_MINUTES`.
 */
integrationsRouter.patch("/ffbb", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const body = await c.req.json().catch(() => ({}));
  const parsed = PatchFfbbIntegrationDtoSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));
  }

  if (parsed.data.clubCode === undefined && parsed.data.enabled === undefined) {
    throw badRequest("Au moins un champ (clubCode ou enabled) est requis.");
  }

  const patch: { ffbb_club_id?: string; ffbb_next_sync_at?: string; ffbb_enabled?: boolean } = {};
  if (parsed.data.clubCode !== undefined) {
    patch.ffbb_club_id = parsed.data.clubCode;
    patch.ffbb_next_sync_at = new Date().toISOString();
  }
  if (parsed.data.enabled !== undefined) patch.ffbb_enabled = parsed.data.enabled;

  const serviceSupabase = createServiceSupabaseClient();
  const { data, error } = await serviceSupabase.from("clubs").update(patch).eq("id", club.id).select("ffbb_club_id, ffbb_enabled, ffbb_next_sync_at").single();

  if (error) throw new Error(`Mise à jour de l'intégration FFBB échouée : ${error.message}`);

  return c.json({
    clubCode: data.ffbb_club_id,
    enabled: data.ffbb_enabled,
    nextSyncAt: data.ffbb_next_sync_at,
  });
});
