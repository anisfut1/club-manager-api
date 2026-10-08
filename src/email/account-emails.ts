import { PLATFORM_NAME, renderEmail } from "./layout.js";

/**
 * Emails de compte (invitation, accès ajouté, mot de passe oublié) — envoyés
 * par Resend depuis le domaine de la plateforme, jamais par Supabase Auth
 * (retour du club, 2026-10-08 : « pourquoi une invit Supabase ? Faut un mail
 * propre »). Les liens pointent vers le frontend (`/bienvenue`), jamais vers
 * un domaine tiers.
 */
export interface ClubBranding {
  name: string;
  logoUrl: string | null;
  accentColor: string | null;
}

export function buildInviteEmail(input: { club: ClubBranding; roleLabel: string; link: string }) {
  const subject = `Invitation : ${input.club.name} sur ${PLATFORM_NAME}`;
  const { html, text } = renderEmail({
    preheader: `Crée ton mot de passe pour accéder à ${input.club.name}.`,
    eyebrow: input.club.name,
    title: "Ton accès est prêt",
    paragraphs: [
      `Tu as été ajouté·e à ${input.club.name} sur ${PLATFORM_NAME} en tant que ${input.roleLabel}.`,
      "Il ne reste qu'une étape : choisir ton mot de passe. Ensuite, tu te connectes simplement avec ton email.",
    ],
    button: { label: "Créer mon mot de passe", href: input.link },
    footer: [
      `Tu reçois cet email parce qu'un responsable de ${input.club.name} a indiqué cette adresse.`,
      "Le lien est à usage unique. S'il a expiré, utilise « Mot de passe oublié » sur la page de connexion.",
      "Si tu ne t'attendais pas à cet email, ignore-le simplement : aucun accès ne sera créé sans clic.",
    ],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

export function buildAccessGrantedEmail(input: { club: ClubBranding; roleLabel: string; link: string }) {
  const subject = `Nouvel accès : ${input.club.name}`;
  const { html, text } = renderEmail({
    preheader: `Tu es maintenant ${input.roleLabel} de ${input.club.name}.`,
    eyebrow: input.club.name,
    title: `Tu es maintenant ${input.roleLabel}`,
    paragraphs: [`Ton compte ${PLATFORM_NAME} a désormais accès à ${input.club.name} en tant que ${input.roleLabel}.`, "Connecte-toi avec ton email et ton mot de passe habituels."],
    button: { label: `Ouvrir ${input.club.name}`, href: input.link },
    footer: [`Tu reçois cet email parce qu'un responsable a modifié tes accès à ${input.club.name}.`],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

export function buildPasswordResetEmail(input: { link: string }) {
  const subject = `Ton nouveau mot de passe ${PLATFORM_NAME}`;
  const { html, text } = renderEmail({
    preheader: "Choisis un nouveau mot de passe en un clic.",
    eyebrow: PLATFORM_NAME,
    title: "Nouveau mot de passe",
    paragraphs: ["Tu as demandé à changer ton mot de passe. Clique sur le bouton pour en choisir un nouveau."],
    button: { label: "Choisir un nouveau mot de passe", href: input.link },
    footer: ["Le lien est à usage unique et expire rapidement.", "Si ce n'est pas toi, ignore cet email : ton mot de passe actuel reste valable."],
  });
  return { subject, html, text };
}

/**
 * « Je ne trouve pas mon nom » (espace public, retour du club 2026-10-08) :
 * prévient les administrateurs du club. « Répondre » écrit directement à la
 * personne (Reply-To = son adresse).
 */
export function buildAccessRequestEmail(input: { club: ClubBranding; fullName: string; email: string; message: string | null; link: string }) {
  const subject = `${input.fullName} ne trouve pas son nom — ${input.club.name}`;
  const { html, text } = renderEmail({
    preheader: `Demande d'accès à l'espace public de ${input.club.name}.`,
    eyebrow: input.club.name,
    title: "Demande d'accès",
    paragraphs: [
      `${input.fullName} n'a pas trouvé son nom dans la liste des licenciés de l'espace public.`,
      `Adresse indiquée : ${input.email}`,
      ...(input.message ? [`Son message : « ${input.message} »`] : []),
      "Ajoute ou corrige sa fiche (nom, prénom, email) dans la liste des joueurs, puis réponds-lui : « Répondre » écrit directement à son adresse.",
    ],
    button: { label: "Ouvrir la liste des joueurs", href: input.link },
    footer: [`Tu reçois cet email parce que tu es administrateur de ${input.club.name} sur ${PLATFORM_NAME}.`],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}
