import type { UpdateLicencieProfileDto } from "../../contracts/licencies.js";

/**
 * Fonction pure (aucune IO) : quelles clés de `UpdateLicencieProfileDto`
 * peuvent être soumises par CET appelant. Séparée de `routes.ts` pour être
 * testable sans fake Supabase — même esprit que les normalizers e-Marque
 * (voir `integrations/emarque/normalizers/`).
 *
 * `club_admin` : tout (voir supabase/migrations/20260921100090_rls_
 * multitenant_rewrite.sql, "licencies_all_club_admin" — cette route en est
 * le PENDANT applicatif, écrit avec le rôle service pour appliquer la
 * MÊME restriction de champs au licencié lui-même, qu'aucune policy RLS ne
 * couvre, voir routes.ts).
 *
 * Le licencié lui-même (`isSelf`) : uniquement contact/photo — jamais son
 * propre nom, sa date de naissance, son numéro de licence ou son statut
 * actif/inactif (identité admin-contrôlée, ARCHITECTURE.md §22/§26 :
 * l'identité d'un licencié est ce qui relie ses statistiques à travers les
 * matchs, jamais laissée à la merci d'une auto-modification).
 */
const ADMIN_EDITABLE_FIELDS = ["firstName", "lastName", "birthDate", "licenseNumber", "active", "photoUrl", "email", "phone"] as const;
const SELF_EDITABLE_FIELDS = ["photoUrl", "email", "phone"] as const;

export interface EditPermission {
  canEdit: boolean;
  allowedFields: readonly string[];
}

export function resolveLicencieEditPermission(isAdmin: boolean, isSelf: boolean): EditPermission {
  if (isAdmin) return { canEdit: true, allowedFields: ADMIN_EDITABLE_FIELDS };
  if (isSelf) return { canEdit: true, allowedFields: SELF_EDITABLE_FIELDS };
  return { canEdit: false, allowedFields: [] };
}

/** Les clés du payload qui ne sont PAS dans `allowedFields` — jamais silencieusement ignorées, voir routes.ts (rejet 400). */
export function rejectedFieldsFor(patch: UpdateLicencieProfileDto, allowedFields: readonly string[]): string[] {
  return Object.keys(patch).filter((key) => !allowedFields.includes(key));
}
