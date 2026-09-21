/**
 * Erreur HTTP typée, traduite par le middleware d'erreur central
 * (src/app.ts) en réponse JSON uniforme `{ error: { code, message } }`
 * (voir docs/API.md). Ne jamais laisser fuiter une stack trace en
 * production — voir le handler d'erreur.
 */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
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

export function badRequest(message: string): ApiError {
  return new ApiError("BAD_REQUEST", message);
}
