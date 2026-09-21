import { handle } from "hono/vercel";
import { app } from "../src/app";

/**
 * Point d'entrée Vercel unique — `vercel.json` réécrit TOUTES les requêtes
 * vers cette fonction (`rewrites: [{ source: "/(.*)", destination: "/api" }]`),
 * Hono se charge ensuite du routage interne (/v1/*, /internal/*, /health,
 * /openapi.json, /docs). Voir docs/DEPLOYMENT.md.
 */
export const config = { runtime: "nodejs" };

export default handle(app);
