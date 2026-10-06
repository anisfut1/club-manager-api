import type { Browser } from "playwright-core";
import { getEnv } from "../../config/env.js";
import { logInfo } from "../../logger.js";

/**
 * Lance un Chromium headless "serverless" (playwright-core + @sparticuz/chromium)
 * DANS une Vercel Function — voir docs/FBI.md pour l'analyse complète des
 * contraintes Vercel actuelles (durée, mémoire, taille de bundle, /tmp) et
 * pourquoi ce n'est PAS une solution officiellement supportée par Vercel :
 * ni la documentation Vercel ni le README de @sparticuz/chromium ne
 * mentionnent Vercel comme plateforme cible (seulement AWS Lambda/Netlify),
 * et des rapports communautaires documentent des ruptures récurrentes
 * (bibliothèques partagées manquantes, Fluid Compute cassant des
 * configurations qui fonctionnaient). D'où le garde-fou `BROWSER_FBI_ENABLED`
 * (désactivé par défaut) : la capability e-Marque via navigateur est
 * explicitement marquée indisponible tant que ce flag n'est pas activé en
 * connaissance de cause pour un déploiement donné — `HttpFbiClient` reste
 * la stratégie principale dans tous les cas (§22 de la demande).
 *
 * `@sparticuz/chromium` extrait son binaire (compressé en brotli) dans
 * `/tmp` au premier appel de `executablePath()` — le seul stockage
 * temporaire utilisé, jamais nettoyé explicitement ici car `/tmp` est de
 * toute façon éphémère et non partagé entre invocations (voir docs/FBI.md).
 */
export class BrowserFbiUnavailableError extends Error {
  constructor(reason: string) {
    super(`Automatisation FBI par navigateur indisponible sur ce déploiement : ${reason}`);
    this.name = "BrowserFbiUnavailableError";
  }
}

export interface FbiProxySettings {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Proxy de sortie vers FBI (`FBI_PROXY_URL`), au format Playwright. Les IP
 * de Vercel changent à chaque invocation et sont partagées avec d'autres
 * clients : FBI en coupe régulièrement l'accès (constaté 2026-10-05/06).
 * Une IP FIXE dédiée — jamais un proxy "rotatif", qui ferait apparaître le
 * compte du club depuis des dizaines d'adresses — rend l'accès stable.
 */
/**
 * Adresse du proxy lue en base (`platform_settings.fbi_proxy_url`) au
 * lancement du navigateur — modifiable sans redéploiement Vercel. La
 * variable d'environnement `FBI_PROXY_URL`, si elle existe, reste prioritaire.
 */
let proxyUrlFromDatabase: string | undefined;

export function fbiProxySettings(proxyUrl: string | undefined = process.env.FBI_PROXY_URL || proxyUrlFromDatabase): FbiProxySettings | undefined {
  if (!proxyUrl) return undefined;
  const url = new URL(proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export async function launchServerlessBrowser(): Promise<Browser> {
  if (!getEnv().BROWSER_FBI_ENABLED) {
    throw new BrowserFbiUnavailableError(
      "BROWSER_FBI_ENABLED=false (valeur par défaut). Voir docs/FBI.md avant de l'activer.",
    );
  }

  // Import paresseux : évite de charger ces modules (et leur poids) quand
  // la capability est désactivée, ce qui est le cas par défaut.
  const [{ default: chromium }, { chromium: playwrightChromium }] = await Promise.all([
    import("@sparticuz/chromium"),
    import("playwright-core"),
  ]);

  const executablePath = await chromium.executablePath();
  proxyUrlFromDatabase = await readProxyUrlFromDatabase();
  const proxy = fbiProxySettings();
  // Jamais l'identifiant/mot de passe du proxy dans les logs : uniquement s'il est actif.
  logInfo("Lancement de Chromium serverless pour BrowserFbiClient", { executablePath, proxy: proxy ? "actif" : "aucun" });

  return playwrightChromium.launch({
    args: chromium.args,
    executablePath,
    headless: true,
    ...(proxy ? { proxy } : {}),
  });
}

async function readProxyUrlFromDatabase(): Promise<string | undefined> {
  if (process.env.FBI_PROXY_URL) return undefined;
  try {
    const { createServiceSupabaseClient } = await import("../../db/client.js");
    const { data } = await createServiceSupabaseClient().from("platform_settings").select("value").eq("key", "fbi_proxy_url").maybeSingle();
    if (!data?.value) return undefined;
    new URL(data.value); // valeur invalide → sortie directe plutôt qu'un échec au lancement
    return data.value;
  } catch {
    // Réglage illisible : sortie directe, jamais un échec du job pour ça.
    return undefined;
  }
}
