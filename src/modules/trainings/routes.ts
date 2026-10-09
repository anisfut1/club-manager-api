import { Hono, type Context } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { badRequest } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import {
  CancelTrainingOccurrenceDtoSchema,
  PutTrainingAttendanceDtoSchema,
  CreateTrainingSeriesDtoSchema,
  UpdateTrainingOccurrenceDtoSchema,
  UpdateTrainingSeriesDtoSchema,
} from "../../contracts/trainings.js";
import { PutConvocationDraftDtoSchema } from "../../contracts/convocations.js";
import { matchTeamLife, openAvailability, previewConvocation, saveDraft, sendConvocation } from "../convocations/service.js";
import { actorFromAccount } from "./actor.js";
import { createSeries, markAttendance, listOccurrences, listSeries, occurrenceDetail, planning, setOccurrenceStatus, stopSeries, updateOccurrence, updateSeries, type TrainingCtx } from "./service.js";

/**
 * Entraînements — espace club (comptes connectés). Mêmes fonctions que
 * l'espace public (`public-routes.ts`). Voir docs/TEAM_LIFE.md.
 * Middlewares posés route par route : ce routeur est monté sur
 * `/clubs/:clubId` à côté d'autres routeurs.
 */
export const trainingsRouter = new Hono<AppEnv>();
const guard = [requireAuth, requireClubMembership] as const;

async function ctxOf(c: Context<AppEnv>): Promise<TrainingCtx> {
  const club = c.get("club");
  const db = createServiceSupabaseClient();
  return { db, clubId: club.club.id, timezone: club.club.timezone, actor: await actorFromAccount(db, club.membershipId, c.get("user").id, c.get("isPlatformAdmin") === true) };
}

export async function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, c: Context): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join(" "));
  return parsed.data;
}

/** Fenêtre de dates `from`/`to` (ISO), par défaut : 14 jours à partir de maintenant ; 120 jours max. */
export function rangeOf(query: Record<string, string | undefined>): { from: string; to: string } {
  const from = query.from ? new Date(query.from) : new Date();
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw badRequest("Période invalide (from / to).");
  if (to.getTime() - from.getTime() > 120 * 86_400_000) throw badRequest("Période trop longue (120 jours maximum).");
  return { from: from.toISOString(), to: to.toISOString() };
}

const param = (c: Context, name: string): string => {
  const value = c.req.param(name);
  if (!value) throw badRequest(`Paramètre :${name} manquant.`);
  return value;
};

trainingsRouter.get("/teams/:teamId/training-series", ...guard, async (c) => c.json({ series: await listSeries(await ctxOf(c), param(c, "teamId")) }));

trainingsRouter.post("/teams/:teamId/training-series", ...guard, async (c) => {
  const body = await parse(CreateTrainingSeriesDtoSchema, c);
  return c.json({ series: await createSeries(await ctxOf(c), param(c, "teamId"), body) }, 201);
});

trainingsRouter.patch("/training-series/:seriesId", ...guard, async (c) => {
  const body = await parse(UpdateTrainingSeriesDtoSchema, c);
  return c.json({ series: await updateSeries(await ctxOf(c), param(c, "seriesId"), body) });
});

trainingsRouter.delete("/training-series/:seriesId", ...guard, async (c) => c.json({ series: await stopSeries(await ctxOf(c), param(c, "seriesId"), c.req.query("from")) }));

trainingsRouter.get("/trainings", ...guard, async (c) => {
  const ctx = await ctxOf(c);
  const teamId = c.req.query("teamId");
  return c.json({ trainings: await listOccurrences(ctx, { teamIds: teamId ? [teamId] : "ALL", ...rangeOf(c.req.query()) }) });
});

trainingsRouter.get("/trainings/:occurrenceId", ...guard, async (c) => c.json(await occurrenceDetail(await ctxOf(c), param(c, "occurrenceId"))));

trainingsRouter.patch("/trainings/:occurrenceId", ...guard, async (c) => {
  const body = await parse(UpdateTrainingOccurrenceDtoSchema, c);
  return c.json(await updateOccurrence(await ctxOf(c), param(c, "occurrenceId"), body));
});

trainingsRouter.post("/trainings/:occurrenceId/cancel", ...guard, async (c) => {
  const body = await parse(CancelTrainingOccurrenceDtoSchema, c);
  return c.json(await setOccurrenceStatus(await ctxOf(c), param(c, "occurrenceId"), "cancelled", body.reason ?? null));
});

trainingsRouter.post("/trainings/:occurrenceId/restore", ...guard, async (c) => c.json(await setOccurrenceStatus(await ctxOf(c), param(c, "occurrenceId"), "scheduled", null)));

/** Planning du club : matchs FFBB + entraînements (toutes les équipes, ou une seule). */
trainingsRouter.get("/planning", ...guard, async (c) => {
  const ctx = await ctxOf(c);
  const teamId = c.req.query("teamId");
  const kind = c.req.query("kind");
  const range = rangeOf(c.req.query());
  const events = await planning(ctx, { teamIds: teamId ? [teamId] : "ALL", ...range, kinds: kind === "MATCH" || kind === "TRAINING" ? [kind] : undefined });
  return c.json({ ...range, events });
});

// ─── Lot 2 : disponibilités et convocation d'un match (coach / admin) ────────

trainingsRouter.get("/matches/:matchId", ...guard, async (c) => c.json(await matchTeamLife(await ctxOf(c), param(c, "matchId"))));
trainingsRouter.post("/matches/:matchId/availability/open", ...guard, async (c) => c.json(await openAvailability(await ctxOf(c), param(c, "matchId"))));
trainingsRouter.put("/matches/:matchId/convocation/draft", ...guard, async (c) => {
  const body = await parse(PutConvocationDraftDtoSchema, c);
  return c.json(await saveDraft(await ctxOf(c), param(c, "matchId"), body));
});
trainingsRouter.post("/matches/:matchId/convocation/preview", ...guard, async (c) => c.json(await previewConvocation(await ctxOf(c), param(c, "matchId"))));
trainingsRouter.post("/matches/:matchId/convocation/send", ...guard, async (c) => c.json(await sendConvocation(await ctxOf(c), param(c, "matchId"))));

/** Présence réelle (coach / admin, séance commencée) : PRESENT / LATE / ABSENT. */
trainingsRouter.put("/trainings/:occurrenceId/attendance/:licencieId", ...guard, async (c) => {
  const ctx = await ctxOf(c);
  const body = await parse(PutTrainingAttendanceDtoSchema, c);
  return c.json(await markAttendance(ctx, param(c, "occurrenceId"), param(c, "licencieId"), body.status));
});
