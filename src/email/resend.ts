import { getEnv } from "../config/env.js";
import { badGateway, serviceUnavailable } from "../api-error.js";

/**
 * Envoi d'email transactionnel via l'API HTTP de Resend
 * (https://resend.com/docs/api-reference/emails/send-email) — `fetch`
 * direct, sans SDK : un seul appel, aucune dépendance supplémentaire.
 *
 * Sans domaine vérifié sur Resend, l'expéditeur par défaut
 * `onboarding@resend.dev` ne livre QU'À l'adresse du propriétaire du
 * compte Resend ; toute autre adresse est refusée par Resend (403), ce que
 * `sendEmail` remonte en 502 explicite plutôt qu'en erreur interne opaque.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const DEFAULT_RESEND_FROM = "SCSB <onboarding@resend.dev>";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Nom d'expéditeur affiché (ex: le club) — l'adresse reste celle de RESEND_FROM. */
  fromName?: string;
  /** Adresse de réponse propre à ce message (sinon RESEND_REPLY_TO). */
  replyTo?: string;
}

export function isEmailConfigured(): boolean {
  return Boolean(getEnv().RESEND_API_KEY);
}

/** Adresse email seule, quels que soient les caractères autour (chevrons typographiques ‹ › ＜ ＞, guillemets, `&lt;`…). */
export function extractEmailAddress(value: string): string | null {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(value)?.[0] ?? null;
}

/**
 * `"Nom <adresse>"` — remplace le nom affiché de RESEND_FROM par `fromName`, garde l'adresse.
 * L'adresse est extraite par motif email (pas par chevrons) : une valeur saisie
 * dans Vercel avec des chevrons « lookalike » donnait `Nom <Ball Manager ‹x@y›>`,
 * refusé par Resend (422 validation_error sur `from`).
 */
export function formatFrom(configuredFrom: string, fromName?: string): string {
  if (!fromName) return configuredFrom;
  const address = extractEmailAddress(configuredFrom) ?? configuredFrom.trim();
  const safeName = fromName.replace(/[<>"\r\n]/g, "").trim();
  return safeName ? `${safeName} <${address}>` : configuredFrom;
}

export async function sendEmail(message: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<{ id: string | null }> {
  const env = getEnv();
  if (!env.RESEND_API_KEY) throw serviceUnavailable("L'envoi d'email n'est pas encore configuré pour ce club. Contacte un·e responsable.", "EMAIL_NOT_CONFIGURED");

  let response: Response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: formatFrom(env.RESEND_FROM ?? DEFAULT_RESEND_FROM, message.fromName),
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...((message.replyTo ?? env.RESEND_REPLY_TO) ? { reply_to: message.replyTo ?? env.RESEND_REPLY_TO } : {}),
      }),
    });
  } catch {
    throw badGateway("Le service d'envoi d'email est injoignable. Réessaie dans quelques minutes.", "EMAIL_SEND_FAILED");
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    // Jamais le corps complet de Resend renvoyé au visiteur — seulement journalisé côté serveur.
    console.error(`[email] Resend a refusé l'envoi (${response.status}) : ${detail?.message ?? "sans détail"}`);
    throw badGateway("L'email n'a pas pu être envoyé. Réessaie plus tard ou contacte un·e responsable du club.", "EMAIL_SEND_FAILED");
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  return { id: body?.id ?? null };
}
