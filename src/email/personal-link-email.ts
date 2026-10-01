/**
 * Email "ton lien personnel" du flux public sans compte (retour du club,
 * 2026-10-01 : "un système d'envoi de mail avec html propre, et un bouton
 * qui renvoie vers son lien avec token"). HTML en tableaux + styles en
 * ligne : seul format rendu correctement par Gmail/Outlook/Apple Mail.
 * Toute donnée injectée est échappée — le nom vient de la base, jamais
 * d'une saisie libre, mais on ne fait aucune hypothèse.
 */

export interface PersonalLinkEmailInput {
  clubName: string;
  /** Uniquement une URL https absolue (une data: URL est bloquée par la plupart des clients mail). */
  clubLogoUrl: string | null;
  accentColor: string | null;
  firstName: string;
  link: string;
}

const DEFAULT_ACCENT = "#2563eb";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeAccent(color: string | null): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_ACCENT;
}

/** Texte du bouton lisible sur l'accent du club : sombre sur une couleur claire (ex. jaune), blanc sinon. */
function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? "#111827" : "#ffffff";
}

export function buildPersonalLinkEmail(input: PersonalLinkEmailInput): { subject: string; html: string; text: string } {
  const accent = safeAccent(input.accentColor);
  const ink = inkFor(accent);
  const club = escapeHtml(input.clubName);
  const firstName = escapeHtml(input.firstName);
  const link = escapeHtml(input.link);
  const logo =
    input.clubLogoUrl && /^https:\/\//.test(input.clubLogoUrl)
      ? `<img src="${escapeHtml(input.clubLogoUrl)}" width="56" height="56" alt="${club}" style="display:block;width:56px;height:56px;border-radius:14px;object-fit:contain;background:#ffffff;border:1px solid #e5e7eb;margin:0 auto 16px;" />`
      : "";

  const subject = `Ton lien personnel — ${input.clubName}`;

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">Ouvre ton espace ${club} en un clic.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;">
        <tr><td style="height:6px;background:${accent};border-radius:16px 16px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:32px 32px 8px;text-align:center;">
            ${logo}
            <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:600;">${club}</p>
            <h1 style="margin:0;font-size:22px;line-height:1.3;color:#111827;">Bonjour ${firstName} 👋</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 32px 0;text-align:center;font-size:15px;line-height:1.6;color:#374151;">
            Voici ton lien personnel pour accéder à l'espace du club : matchs, tables de marque et, selon ton rôle, dérogations.
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="${accent}" style="border-radius:12px;">
                  <a href="${link}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:${ink};text-decoration:none;border-radius:12px;">Ouvrir mon espace</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;font-size:13px;line-height:1.6;color:#6b7280;">
            Le bouton ne fonctionne pas&nbsp;? Copie ce lien dans ton navigateur&nbsp;:<br />
            <a href="${link}" style="color:${accent};word-break:break-all;">${link}</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 28px;border-top:1px solid #f0f1f3;font-size:12px;line-height:1.6;color:#9ca3af;">
            Ce lien est personnel&nbsp;: ne le partage pas, il permet d'agir en ton nom. Chaque nouvelle demande remplace l'ancien lien.
            Si tu n'es pas à l'origine de cette demande, ignore simplement cet email.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `Bonjour ${input.firstName},`,
    "",
    `Voici ton lien personnel pour accéder à l'espace ${input.clubName} :`,
    input.link,
    "",
    "Ce lien est personnel : ne le partage pas. Chaque nouvelle demande remplace l'ancien lien.",
    "Si tu n'es pas à l'origine de cette demande, ignore simplement cet email.",
  ].join("\n");

  return { subject, html, text };
}

/** `c***@gmail.com` — jamais l'adresse complète renvoyée à un visiteur anonyme. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}
