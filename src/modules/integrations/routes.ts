import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { requireAuth, requireClubMembership, requireClubRole } from "@/auth/middleware";
import { createServiceSupabaseClient } from "@/db/client";
import { badRequest } from "@/api-error";
import { getFbiCredentials, saveFbiCredentials } from "@/integrations/fbi/credentials-store";
import { HttpFbiClient } from "@/integrations/fbi/http-client";
import { FbiError, type FbiErrorCode } from "@/integrations/fbi/errors";
import { FfbbPublicProvider } from "@/integrations/ffbb/public-provider";
import { syncFfbb } from "@/integrations/ffbb/sync";
import { getEnv } from "@/config/env";
import { logError } from "@/logger";
import type { IntegrationStatusDto, SyncRunDto } from "@/contracts/integrations";

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

/** GET /v1/clubs/:clubId/integrations */
integrationsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const [{ data: lastFfbbRun }, { data: fbiStatus }] = await Promise.all([
    supabase.from("sync_runs").select("started_at, status").eq("club_id", club.id).eq("provider", "ffbb").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("fbi_integration_status").select("configured, last_login_success, last_login_at, auto_import_emarque, last_error").eq("club_id", club.id).maybeSingle(),
  ]);

  const dto: IntegrationStatusDto = {
    ffbb: {
      enabled: true,
      lastSyncAt: lastFfbbRun?.started_at ?? null,
      lastSyncStatus: lastFfbbRun?.status ?? null,
    },
    fbi: {
      configured: fbiStatus?.configured ?? false,
      connected: fbiStatus?.last_login_success ?? false,
      lastLoginAt: fbiStatus?.last_login_at ?? null,
      autoImportEmarque: fbiStatus?.auto_import_emarque ?? false,
      lastError: fbiStatus?.last_error ?? null,
    },
  };

  return c.json(dto);
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi — enregistre les identifiants
 * (chiffrés, AAD=club_id, §34 de la demande). `fbi_credentials` n'a AUCUNE
 * policy RLS pour `authenticated` (voir supabase/migrations) : le client
 * service role est utilisé ICI, seulement après que `requireClubRole`
 * a vérifié le rôle via LA RLS.
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

  return c.json({ saved: true });
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
