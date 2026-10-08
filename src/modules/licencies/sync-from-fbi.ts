import type { DbClient } from "../../db/client.js";
import type { FbiLicenceRow } from "./fbi-licence-export.js";

/**
 * Met la liste des joueurs du club à jour depuis l'export FBI des licences
 * validées (retour du club, 2026-10-08 : import automatique « pour les
 * nuls »). Même règle de dédoublonnage que l'ancien import collé
 * (`ffbb_licence_id`, « N° national »), avec en plus :
 *
 * - fiche déjà connue : catégorie, sexe et numéro de licence suivent FBI
 *   (ils changent chaque saison) ; date de naissance seulement si absente ;
 *   nom, prénom, email, téléphone, photo, équipe et rôles ne sont JAMAIS
 *   touchés (un admin a pu les corriger à la main) ;
 * - fiche sans N° national mais au même numéro de licence (créée depuis un
 *   e-Marque ou à la main) : rattachée plutôt que dupliquée ;
 * - fiche désactivée qui réapparaît dans FBI : réactivée ;
 * - fiche absente de l'export : comptée (« plus dans FBI »), jamais
 *   désactivée automatiquement — un export partiel ou fait trop tôt dans la
 *   saison ne doit jamais faire disparaître des joueurs.
 */
export interface LicenceSyncResult {
  total: number;
  inserted: number;
  updated: number;
  reactivated: number;
  unchanged: number;
  /** Fiches actives rattachées à FBI (N° national) absentes de cet export. */
  notInExport: number;
}

interface ExistingRow {
  id: string;
  ffbb_licence_id: string | null;
  license_number: string | null;
  birth_date: string | null;
  category_label: string | null;
  sexe: "M" | "F" | null;
  active: boolean;
}

type Patch = Partial<Pick<ExistingRow, "ffbb_licence_id" | "license_number" | "birth_date" | "category_label" | "sexe" | "active">>;

const CHUNK = 10;

export async function syncLicenciesFromFbi(db: DbClient, clubId: string, rows: FbiLicenceRow[]): Promise<LicenceSyncResult> {
  const { data, error } = await db.from("licencies").select("id, ffbb_licence_id, license_number, birth_date, category_label, sexe, active").eq("club_id", clubId);
  if (error) throw new Error(`Lecture des licenciés du club échouée : ${error.message}`);
  const existing = (data ?? []) as ExistingRow[];

  const byFfbbId = new Map(existing.filter((r) => r.ffbb_licence_id).map((r) => [r.ffbb_licence_id!, r]));
  const byLicense = new Map(existing.filter((r) => r.license_number).map((r) => [r.license_number!.toUpperCase(), r]));
  const licenseOwner = new Map(existing.filter((r) => r.license_number).map((r) => [r.license_number!.toUpperCase(), r.id]));

  const seen = new Set<string>();
  const matchedIds = new Set<string>();
  const inserts: Record<string, unknown>[] = [];
  const updates: { id: string; patch: Patch; reactivated: boolean }[] = [];
  let unchanged = 0;

  for (const row of rows) {
    if (seen.has(row.ffbbLicenceId)) continue;
    seen.add(row.ffbbLicenceId);
    const license = row.licenseNumber?.toUpperCase() ?? null;

    let match = byFfbbId.get(row.ffbbLicenceId);
    if (!match && license) {
      const candidate = byLicense.get(license);
      if (candidate && !candidate.ffbb_licence_id && !matchedIds.has(candidate.id)) match = candidate;
    }

    if (!match) {
      // Numéro de licence déjà porté par une autre fiche (unicité par club) : on crée sans numéro plutôt que d'échouer.
      const licenseFree = license && !licenseOwner.has(license);
      if (license && licenseFree) licenseOwner.set(license, "new");
      inserts.push({
        club_id: clubId,
        first_name: row.firstName,
        last_name: row.lastName,
        license_number: licenseFree ? row.licenseNumber : null,
        birth_date: row.birthDate,
        ffbb_licence_id: row.ffbbLicenceId,
        category_label: row.categoryLabel,
        sexe: row.sexe,
      });
      continue;
    }

    matchedIds.add(match.id);
    const patch: Patch = {};
    if (!match.ffbb_licence_id) patch.ffbb_licence_id = row.ffbbLicenceId;
    if (row.categoryLabel && row.categoryLabel !== match.category_label) patch.category_label = row.categoryLabel;
    if (row.sexe && row.sexe !== match.sexe) patch.sexe = row.sexe;
    if (row.birthDate && !match.birth_date) patch.birth_date = row.birthDate;
    if (row.licenseNumber && license !== match.license_number?.toUpperCase()) {
      const owner = licenseOwner.get(license!);
      if (!owner || owner === match.id) {
        patch.license_number = row.licenseNumber;
        if (match.license_number) licenseOwner.delete(match.license_number.toUpperCase());
        licenseOwner.set(license!, match.id);
      }
    }
    const reactivated = !match.active;
    if (reactivated) patch.active = true;

    if (Object.keys(patch).length === 0) unchanged += 1;
    else updates.push({ id: match.id, patch, reactivated });
  }

  for (let i = 0; i < updates.length; i += CHUNK) {
    await Promise.all(
      updates.slice(i, i + CHUNK).map(async ({ id, patch }) => {
        const { error: updateError } = await db.from("licencies").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).eq("club_id", clubId);
        if (updateError) throw new Error(`Mise à jour d'un licencié échouée : ${updateError.message}`);
      }),
    );
  }

  if (inserts.length > 0) {
    const { error: insertError } = await db.from("licencies").insert(inserts as never);
    if (insertError) throw new Error(`Ajout des nouveaux licenciés échoué : ${insertError.message}`);
  }

  const notInExport = existing.filter((r) => r.active && r.ffbb_licence_id && !seen.has(r.ffbb_licence_id)).length;
  const reactivated = updates.filter((u) => u.reactivated).length;

  return {
    total: seen.size,
    inserted: inserts.length,
    updated: updates.length - reactivated,
    reactivated,
    unchanged,
    notInExport,
  };
}

/** Trace de l'import (compteurs seulement) pour « Dernière mise à jour » côté admin. */
export async function recordLicenceImportRun(db: DbClient, clubId: string, source: "fbi" | "file", result: LicenceSyncResult, createdBy: string | null): Promise<void> {
  await db.from("licence_import_runs").insert({
    club_id: clubId,
    source,
    created_by: createdBy,
    total: result.total,
    inserted: result.inserted,
    updated: result.updated,
    reactivated: result.reactivated,
    unchanged: result.unchanged,
    not_in_export: result.notInExport,
  });
}
