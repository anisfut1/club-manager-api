/**
 * Erreur HTTP typée, traduite par le middleware d'erreur central
 * (src/app.ts) en réponse JSON uniforme `{ error: { code, message } }`
 * (voir docs/API.md). Ne jamais laisser fuiter une stack trace en
 * production — voir le handler d'erreur.
 *
 * `ApiErrorKind` fixe le statut HTTP (petit ensemble fermé). `code` (dans
 * la réponse JSON) peut en revanche être un identifiant métier plus précis
 * — ex: `conflict("...", "FBI_NOT_CONFIGURED")` — toujours à statut 409,
 * mais distinguable côté frontend d'un autre conflit. Sans code explicite,
 * `code` retombe sur le nom du statut générique (comportement inchangé).
 */
export type ApiErrorKind = "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" | "INTERNAL_ERROR";

const STATUS_BY_KIND: Record<ApiErrorKind, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(kind: ApiErrorKind, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code ?? kind;
    this.status = STATUS_BY_KIND[kind];
  }
}

export function unauthorized(message = "Authentification requise."): ApiError {
  return new ApiError("UNAUTHORIZED", message);
}

export function forbidden(message = "Accès refusé."): ApiError {
  return new ApiError("FORBIDDEN", message);
}

export function notFound(message = "Ressource introuvable."): ApiError {
  return new ApiError("NOT_FOUND", message);
}

export function badRequest(message: string, code?: string): ApiError {
  return new ApiError("BAD_REQUEST", message, code);
}

export function conflict(message: string, code?: string): ApiError {
  return new ApiError("CONFLICT", message, code);
}
