import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/types.js";
import { decryptSecret, encryptSecret } from "../../security/crypto.js";
import type { FbiCredentialsInput } from "./types.js";

type Client = SupabaseClient<Database>;

export type { FbiCredentialsInput };

/**
 * Enregistre les identifiants FBI, chiffrés (voir src/lib/security/crypto.ts).
 * Le mot de passe en clair ne transite ici qu'en mémoire serveur, jamais en
 * base ni renvoyé au client.
 */
export async function saveFbiCredentials(
  supabase: Client,
  clubId: string,
  credentials: FbiCredentialsInput,
  updatedByUserId: string | null,
): Promise<void> {
  // club_id comme AAD (§21 du brief SaaS) : un ciphertext déplacé par erreur
  // vers un autre club ne pourra jamais être déchiffré comme si c'était le
  // sien — voir src/lib/security/crypto.ts.
  const encrypted = encryptSecret(credentials.password, clubId);

  const { error } = await supabase.from("fbi_credentials").upsert(
    {
      club_id: clubId,
      username: credentials.username,
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
      updated_by: updatedByUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "club_id" },
  );

  if (error) {
    throw new Error(`Enregistrement des identifiants FBI échoué : ${error.message}`);
  }

  await supabase
    .from("fbi_integration_status")
    .upsert({ club_id: clubId, configured: true, updated_at: new Date().toISOString() }, { onConflict: "club_id" });
}

/** Lecture des identifiants déchiffrés — usage serveur uniquement (FBIProvider). */
export async function getFbiCredentials(supabase: Client, clubId: string): Promise<FbiCredentialsInput | null> {
  const { data, error } = await supabase
    .from("fbi_credentials")
    .select("username, password_ciphertext, password_iv, password_auth_tag")
    .eq("club_id", clubId)
    .maybeSingle();

  if (error) {
    throw new Error(`Lecture des identifiants FBI échouée : ${error.message}`);
  }

  if (!data) return null;

  const password = decryptSecret(
    {
      ciphertext: data.password_ciphertext,
      iv: data.password_iv,
      authTag: data.password_auth_tag,
    },
    clubId,
  );

  return { username: data.username, password };
}

/** Identifiant seul (pas un secret), pour affichage dans /admin/integrations/fbi. */
export async function getFbiUsername(supabase: Client, clubId: string): Promise<string | null> {
  const { data, error } = await supabase.from("fbi_credentials").select("username").eq("club_id", clubId).maybeSingle();

  if (error) {
    throw new Error(`Lecture de l'identifiant FBI échouée : ${error.message}`);
  }

  return data?.username ?? null;
}
