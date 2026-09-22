import type { DbClient } from "../db/client.js";

export const EMARQUE_BUCKET = "emarque";

/** Courte durée de validité (§32 de la demande) : jamais d'URL publique/permanente vers un document e-Marque. */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Convention de chemin pour les documents e-Marque, tenant-scopée :
 * private/emarque/{clubId}/{season}/{matchId}/{fileName}. `clubId` en
 * premier segment rend une fuite cross-tenant immédiatement visible dans
 * les logs/audits Storage (bucket privé, accès service role uniquement,
 * voir la migration de création du bucket).
 */
export function emarqueStoragePath(clubId: string, season: string, matchId: string, fileName: string): string {
  return `private/emarque/${clubId}/${season}/${matchId}/${fileName}`;
}

/** Pas de saison FFBB exposée de façon fiable sur `matches` à ce stade : dérivée de la date du match (juillet à juin, convention basket FR). */
export function resolveSeasonLabel(matchDatetime: string | null): string {
  const date = matchDatetime ? new Date(matchDatetime) : new Date();
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month >= 7 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

/**
 * Dépose un fichier dans le bucket privé `emarque`. Le client passé doit
 * être le client service role (voir src/db/client.ts) : aucune policy RLS
 * n'accorde d'accès à ce bucket depuis un rôle authenticated.
 */
export async function uploadEmarqueFile(supabase: DbClient, path: string, content: Buffer, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(EMARQUE_BUCKET).upload(path, content, { contentType, upsert: true });

  if (error) {
    throw new Error(`Dépôt Storage échoué (${path}) : ${error.message}`);
  }
}

export async function downloadEmarqueFile(supabase: DbClient, path: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(EMARQUE_BUCKET).download(path);

  if (error || !data) {
    throw new Error(`Téléchargement Storage échoué (${path}) : ${error?.message}`);
  }

  return Buffer.from(await data.arrayBuffer());
}

/**
 * URL signée courte (§32/§33/§34 de la demande) pour un téléchargement
 * ponctuel depuis l'API (`GET /v1/clubs/:clubId/matches/:matchId/documents`)
 * — jamais une URL publique. Le client appelant DOIT avoir déjà vérifié
 * membership/rôle avant d'appeler cette fonction (elle ne le fait pas
 * elle-même, voir src/modules/documents).
 */
export async function createEmarqueSignedUrl(supabase: DbClient, path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(EMARQUE_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error || !data) {
    throw new Error(`Génération d'URL signée échouée (${path}) : ${error?.message}`);
  }

  return data.signedUrl;
}
