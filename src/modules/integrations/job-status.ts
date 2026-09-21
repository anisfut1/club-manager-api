import { Hono } from "hono";
import type { AppEnv } from "@/auth/context";
import { requireAuth } from "@/auth/middleware";
import { badRequest, notFound } from "@/api-error";
import type { JobStatusDto } from "@/contracts/jobs";

export const jobStatusRouter = new Hono<AppEnv>();

jobStatusRouter.use("*", requireAuth);

/**
 * GET /v1/jobs/:jobId — §36 de la demande : suivi d'une opération
 * potentiellement longue lancée en 202 (ex: test_connection navigateur).
 * Pas de vérification de membership explicite ici : la policy RLS
 * `fbi_jobs_select_club_admin` (club_admin ou platform_admin DU CLUB de ce
 * job) s'applique déjà via le client "au nom de l'utilisateur" — un job
 * d'un autre club renvoie simplement `null` (jamais une fuite cross-tenant).
 */
jobStatusRouter.get("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  if (!jobId) throw badRequest("Paramètre de route :jobId manquant.");

  const { data: job, error } = await c
    .get("supabase")
    .from("fbi_jobs")
    .select("id, type, status, attempt_count, last_error, result, scheduled_at, finished_at")
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Lecture du job échouée : ${error.message}`);
  if (!job) throw notFound("Job introuvable.");

  const dto: JobStatusDto = {
    id: job.id,
    type: job.type,
    status: job.status,
    attemptCount: job.attempt_count,
    lastError: job.last_error,
    result: job.result,
    scheduledAt: job.scheduled_at,
    finishedAt: job.finished_at,
  };

  return c.json(dto);
});
