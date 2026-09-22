import type { SanitizedErrorDto } from "@/contracts/emarque";

/**
 * §5/§29 de la demande ("lastError sanitized") : `emarque_imports.last_error`
 * et `match_documents.last_error` peuvent contenir un message d'exception
 * brut (ex: erreur Postgres/Storage) — jamais garanti sûr à renvoyer tel
 * quel à un club_admin. On expose uniquement la PRÉSENCE d'une erreur et
 * une classification générique, jamais le texte stocké en base.
 */
export function sanitizeEmarqueError(rawError: string | null): SanitizedErrorDto | null {
  if (!rawError) return null;

  return {
    code: "EMARQUE_PROCESSING_ERROR",
    message: "Une erreur technique est survenue lors du traitement de ce document. L'équipe technique peut consulter le détail dans les journaux internes.",
  };
}
