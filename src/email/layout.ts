import { escapeHtml } from "./personal-link-email.js";

/**
 * Gabarit commun des emails de la plateforme (retour du club, 2026-10-08 :
 * « un mail propre, domaine Ball Manager, une expérience claire de A à Z »).
 * Tableaux + styles en ligne (seul format rendu partout), version texte
 * toujours jointe, aucune image obligatoire, aucun emoji. Toute donnée
 * injectée est échappée ici.
 */
export const PLATFORM_NAME = "Ball Manager";
const DEFAULT_ACCENT = "#2563eb";

export interface EmailLayoutInput {
  /** Texte d'aperçu (affiché par les clients mail après le sujet). */
  preheader: string;
  /** Petite ligne au-dessus du titre (ex. le nom du club). */
  eyebrow: string;
  title: string;
  paragraphs: string[];
  button: { label: string; href: string };
  /** Lignes du pied (raison de l'envoi, sécurité). */
  footer: string[];
  accentColor?: string | null;
  logoUrl?: string | null;
}

function safeAccent(color: string | null | undefined): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_ACCENT;
}

function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111827" : "#ffffff";
}

export function renderEmail(input: EmailLayoutInput): { html: string; text: string } {
  const accent = safeAccent(input.accentColor);
  const ink = inkFor(accent);
  const href = escapeHtml(input.button.href);
  const logo =
    input.logoUrl && /^https:\/\//.test(input.logoUrl)
      ? `<img src="${escapeHtml(input.logoUrl)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:14px;object-fit:contain;background:#ffffff;border:1px solid #e5e7eb;margin:0 auto 16px;" />`
      : "";
  const paragraphs = input.paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(p)}</p>`)
    .join("\n            ");
  const footer = input.footer.map((line) => escapeHtml(line)).join("<br />");

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;">
        <tr><td style="height:6px;background:${accent};border-radius:16px 16px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:32px 32px 8px;text-align:center;">
            ${logo}
            <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:600;">${escapeHtml(input.eyebrow)}</p>
            <h1 style="margin:0;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(input.title)}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 0;text-align:center;">
            ${paragraphs}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:16px 32px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="${accent}" style="border-radius:12px;">
                  <a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:${ink};text-decoration:none;border-radius:12px;">${escapeHtml(input.button.label)}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;font-size:13px;line-height:1.6;color:#6b7280;">
            Le bouton ne fonctionne pas&nbsp;? Copie ce lien dans ton navigateur&nbsp;:<br />
            <a href="${href}" style="color:${accent};word-break:break-all;">${href}</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 28px;border-top:1px solid #f0f1f3;font-size:12px;line-height:1.6;color:#9ca3af;">
            ${footer}
            <br /><br />${PLATFORM_NAME}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [input.title, "", ...input.paragraphs, "", `${input.button.label} : ${input.button.href}`, "", ...input.footer, "", PLATFORM_NAME].join("\n");
  return { html, text };
}
