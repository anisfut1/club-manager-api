import { z } from "zod";

/**
 * Variables d'environnement — un seul schéma (pas de séparation
 * public/serveur : ce backend n'a pas de bundle navigateur, tout tourne
 * côté Vercel Function). Voir .env.example.
 */
const envSchema = z.object({
  SUPABASE_URL: z.string().url({ message: "SUPABASE_URL doit être une URL valide (ex: https://xxxx.supabase.co)" }),
  SUPABASE_ANON_KEY: z.string().min(1, { message: "SUPABASE_ANON_KEY est requis" }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, { message: "SUPABASE_SERVICE_ROLE_KEY est requis" }),
  FBI_CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .min(1, { message: "FBI_CREDENTIALS_ENCRYPTION_KEY est requis pour chiffrer les identifiants FBI" })
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "FBI_CREDENTIALS_ENCRYPTION_KEY doit être 32 octets encodés en base64 (clé AES-256)",
    }),
  CRON_SECRET: z.string().min(16, { message: "CRON_SECRET est requis (au moins 16 caractères) pour protéger /internal/*" }),
  FRONTEND_ORIGINS: z.string().min(1, { message: "FRONTEND_ORIGINS est requis (liste d'origines séparées par des virgules)" }),
  BROWSER_FBI_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  FBI_BASE_URL: z.string().url().optional().default("https://extranet.ffbb.com/fbi"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Partial<Record<string, string | undefined>> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(
      `Variables d'environnement invalides ou manquantes.\n${details}\n` +
        "Vérifie ton fichier .env (voir .env.example). Ne jamais commiter ces clés.",
    );
  }

  return result.data;
}

let cached: Env | null = null;

/** Chargé paresseusement : évite de faire planter un import (ex: en test) avant que l'environnement soit prêt. */
export function getEnv(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}

/** Réservé aux tests : force un rechargement avec un nouvel environnement simulé. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
