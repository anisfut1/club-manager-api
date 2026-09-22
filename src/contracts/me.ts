import { z } from "./zod";

/**
 * GET /v1/me (gap 3 de la demande) — identité de session UNIQUEMENT.
 * `displayName` vient de `profiles.display_name` (jamais d'un licencié,
 * §5 de la demande : "conserver la séparation auth user ≠ licencié") avec
 * un repli explicite sur l'email plutôt que d'inventer une identité.
 * `isPlatformAdmin` (gap 24) évite un aller-retour dédié au frontend pour
 * une information déjà bon marché à calculer ici (même RPC que la RLS) —
 * jamais la liste des clubs, qui reste `GET /v1/clubs` (payload déjà
 * dédié, plus riche).
 */
export const MeDtoSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
    isPlatformAdmin: z.boolean(),
  })
  .openapi("MeDto");

export type MeDto = z.infer<typeof MeDtoSchema>;
