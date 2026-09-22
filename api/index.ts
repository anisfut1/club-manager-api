import { getRequestListener } from "@hono/node-server";
import { app } from "../src/app.js";

/**
 * Point d'entrée Vercel unique — `vercel.json` réécrit TOUTES les requêtes
 * vers cette fonction (`rewrites: [{ source: "/(.*)", destination: "/api" }]`),
 * Hono se charge ensuite du routage interne (/v1/*, /internal/*, /health,
 * /openapi.json, /docs). Voir docs/DEPLOYMENT.md.
 *
 * `getRequestListener` (@hono/node-server), pas `handle` de `hono/vercel` :
 * ce dernier suppose que Vercel invoque la fonction avec un objet `Request`
 * standard Web tout fait (`app.fetch(req)`), ce qui est le cas pour le
 * preset "Hono" auto-détecté par Vercel — mais `vercel.json` force
 * `"framework": null` (voir ce fichier, nécessaire pour un vrai
 * empaquetage esbuild au lieu d'une transpilation fichier par fichier au
 * démarrage à froid). Sans ce preset, Vercel invoque la fonction Node.js
 * de façon générique, à l'ancienne : `(req: IncomingMessage, res:
 * ServerResponse)`. `handle()` plantait alors avec
 * `this.raw.headers.get is not a function` (`req.headers` est un objet
 * simple côté Node, pas une instance `Headers`). `getRequestListener`
 * convertit correctement `IncomingMessage`/`ServerResponse` vers/depuis le
 * `Request`/`Response` standard Web qu'attend `app.fetch()`.
 */
export const config = { runtime: "nodejs" };

export default getRequestListener((req) => app.fetch(req));
