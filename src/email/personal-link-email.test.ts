import { describe, expect, it } from "vitest";
import { buildPersonalLinkEmail, maskEmail } from "./personal-link-email.js";
import { formatFrom } from "./resend.js";

const base = { clubName: "SC Sète <Basket>", clubLogoUrl: null, accentColor: "#E4572E", firstName: "Léa", link: "https://app.example/public/sc/tables?token=abc&x=1" };

describe("buildPersonalLinkEmail", () => {
  it("contient le bouton et le lien, échappe toute donnée injectée", () => {
    const { subject, html, text } = buildPersonalLinkEmail(base);
    expect(subject).toBe("Ton accès à l'espace SC Sète <Basket>");
    expect(html).toContain("Ouvrir l'espace du club");
    // Pas d'emoji ni de formule « agir en ton nom » (filtres anti-hameçonnage).
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).not.toContain("en ton nom");
    expect(html).toContain('href="https://app.example/public/sc/tables?token=abc&amp;x=1"');
    expect(html).toContain("SC Sète &lt;Basket&gt;");
    expect(html).not.toContain("<Basket>");
    expect(text).toContain(base.link);
  });

  it("n'utilise qu'une couleur hexadécimale valide et un logo https", () => {
    const { html } = buildPersonalLinkEmail({ ...base, accentColor: "red;background:url(x)", clubLogoUrl: "data:image/png;base64,AAAA" });
    expect(html).not.toContain("red;background");
    expect(html).not.toContain("data:image");
    expect(buildPersonalLinkEmail({ ...base, clubLogoUrl: "https://cdn.example/logo.png" }).html).toContain('src="https://cdn.example/logo.png"');
  });

  it("texte du bouton sombre sur un accent clair", () => {
    expect(buildPersonalLinkEmail({ ...base, accentColor: "#FFD60A" }).html).toContain("color:#111827;text-decoration:none");
    expect(buildPersonalLinkEmail(base).html).toContain("color:#ffffff;text-decoration:none");
  });
});

describe("maskEmail / formatFrom", () => {
  it("masque l'adresse", () => {
    expect(maskEmail("camille.martin@gmail.com")).toBe("c***@gmail.com");
    expect(maskEmail("invalide")).toBe("***");
  });

  it("remplace le nom affiché, garde l'adresse configurée", () => {
    expect(formatFrom("SCSB <onboarding@resend.dev>", "SC Sète Basket")).toBe("SC Sète Basket <onboarding@resend.dev>");
    expect(formatFrom("onboarding@resend.dev", 'Club "<x>"')).toBe("Club x <onboarding@resend.dev>");
    expect(formatFrom("SCSB <onboarding@resend.dev>")).toBe("SCSB <onboarding@resend.dev>");
    // Valeurs saisies dans Vercel avec chevrons typographiques / échappés : on garde l'adresse seule.
    expect(formatFrom("Ball Manager ‹noreply@ball-manager.fr›", "SC Sète Basket")).toBe("SC Sète Basket <noreply@ball-manager.fr>");
    expect(formatFrom("Ball Manager ＜noreply@ball-manager.fr＞", "SC Sète Basket")).toBe("SC Sète Basket <noreply@ball-manager.fr>");
    expect(formatFrom("Ball Manager &lt;noreply@ball-manager.fr&gt;", "SC Sète Basket")).toBe("SC Sète Basket <noreply@ball-manager.fr>");
    expect(formatFrom(" noreply@ball-manager.fr ", "SC Sète Basket")).toBe("SC Sète Basket <noreply@ball-manager.fr>");
  });
});
