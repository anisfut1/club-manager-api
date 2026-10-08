import { Hono } from "hono";
import { z } from "../../contracts/zod.js";
import { badRequest } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { sendPasswordReset } from "../../auth/account-invites.js";
import { logError } from "../../logger.js";

/**
 * Compte sans session (retour du club, 2026-10-08 : « une expérience claire
 * de A à Z ») : mot de passe oublié. La réponse est TOUJOURS la même, que
 * l'adresse ait un compte ou non — jamais un moyen de savoir qui est inscrit.
 */
export const accountRouter = new Hono();

export const PasswordResetDtoSchema = z.object({ email: z.string().trim().email("Adresse email invalide.") }).strict().openapi("PasswordResetDto");

/** Une demande par adresse et par minute, par instance (anti-rafale, sans dépendance externe). */
const RESET_COOLDOWN_MS = 60_000;
const lastResetAt = new Map<string, number>();

/** POST /v1/account/password-reset — envoie (si le compte existe) un email « Choisir un nouveau mot de passe ». */
accountRouter.post("/password-reset", async (c) => {
  const body = PasswordResetDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const email = body.data.email.toLowerCase();

  const now = Date.now();
  const last = lastResetAt.get(email);
  if (!last || now - last >= RESET_COOLDOWN_MS) {
    lastResetAt.set(email, now);
    try {
      await sendPasswordReset(createServiceSupabaseClient(), email);
    } catch (error) {
      // Jamais l'adresse dans les journaux (dépôt public, voir docs/SECURITY.md).
      logError("Envoi du lien de réinitialisation échoué", error, {});
    }
  }
  return c.json({ sent: true as const });
});
