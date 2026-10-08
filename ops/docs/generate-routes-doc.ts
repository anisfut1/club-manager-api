/**
 * Génère docs/API_ROUTES.md : l'inventaire de TOUTES les routes de l'API,
 * relu depuis le code (routes Hono réellement montées) et le contrat OpenAPI.
 * Les écarts entre les deux sont listés en fin de document.
 *
 *   npm run docs:routes
 *
 * À relancer après tout ajout / retrait de route (la CI ne le fait pas).
 */
import { writeFileSync } from "node:fs";
import { generateOpenApiDocument } from "../../src/openapi.js";
import { app } from "../../src/app.js";

interface Op {
  security?: unknown[];
  responses?: Record<string, { description?: string }>;
}

const spec = generateOpenApiDocument() as unknown as { paths: Record<string, Record<string, Op>> };
const toHono = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

const documented = new Map<string, Op>();
for (const [path, ops] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(ops)) documented.set(`${method.toUpperCase()} ${toHono(path)}`, op);

const mounted = new Set<string>();
for (const r of (app as unknown as { routes: { method: string; path: string }[] }).routes) {
  if (r.method === "ALL") continue;
  mounted.add(`${r.method} ${r.path.replace(/\/$/, "") || "/"}`);
}

function group(path: string): string {
  if (path.startsWith("/internal/")) return "Interne (tâches planifiées)";
  if (path.startsWith("/v1/platform")) return "Plateforme (platform_admin)";
  if (path.startsWith("/v1/account")) return "Compte (sans session)";
  const pub = path.match(/^\/v1\/public\/clubs\/:clubSlug\/?([^/]*)/);
  if (pub) return `Public — ${pub[1] || "club"}`;
  const club = path.match(/^\/v1\/clubs\/:clubId\/?([^/]*)/);
  if (club) return `Club — ${club[1] || "club"}`;
  if (path.startsWith("/v1/")) return `Général — ${path.split("/")[2]}`;
  return "Technique";
}

function access(key: string, op: Op | undefined): string {
  const path = key.split(" ")[1]!;
  if (path.startsWith("/internal/")) return "Secret cron";
  if (op?.security?.length) return "Compte connecté";
  if (path.includes("/public/")) return "Public (lien perso si action)";
  return "Public";
}

function summary(op: Op | undefined): string {
  if (!op?.responses) return "";
  const ok = op.responses["200"] ?? op.responses["201"] ?? Object.values(op.responses)[0];
  return (ok?.description ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

const all = [...new Set([...mounted, ...documented.keys()])].sort((a, b) => a.split(" ")[1]!.localeCompare(b.split(" ")[1]!) || a.localeCompare(b));
const byGroup = new Map<string, string[]>();
for (const key of all) {
  const g = group(key.split(" ")[1]!);
  byGroup.set(g, [...(byGroup.get(g) ?? []), key]);
}

const lines: string[] = [
  "# Inventaire des routes de l'API",
  "",
  "> Fichier **généré** par `npm run docs:routes` (ops/docs/generate-routes-doc.ts) — ne pas modifier à la main.",
  `> ${mounted.size} routes montées dans le code, ${documented.size} décrites dans le contrat OpenAPI (\`/openapi.json\`, \`/docs\`).`,
  "",
  "Accès : **Compte connecté** = JWT Supabase (`Authorization: Bearer`), droits vérifiés par club ; **Public** = sans compte ; **Public (lien perso si action)** = lecture libre, écriture avec le jeton du lien personnel ; **Secret cron** = `CRON_SECRET`.",
  "",
];

for (const [g, keys] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b, "fr"))) {
  lines.push(`## ${g}`, "", "| Méthode | Route | Accès | Description |", "|---|---|---|---|");
  for (const key of keys) {
    const [method, path] = key.split(" ") as [string, string];
    const op = documented.get(key);
    const flag = !mounted.has(key) ? " ⚠️ documentée mais absente du code" : !op && !path.startsWith("/internal/") && !["/docs", "/openapi.json"].includes(path) ? " ⚠️ absente du contrat OpenAPI" : "";
    lines.push(`| ${method} | \`${path}\` | ${access(key, op)} | ${summary(op)}${flag} |`);
  }
  lines.push("");
}

const missingInCode = [...documented.keys()].filter((k) => !mounted.has(k));
const missingInSpec = [...mounted].filter((k) => !documented.has(k) && !k.includes("/internal/") && !k.endsWith(" /docs") && !k.endsWith(" /openapi.json"));
lines.push("## Écarts code / contrat", "");
if (missingInCode.length === 0 && missingInSpec.length === 0) lines.push("Aucun.");
for (const k of missingInCode) lines.push(`- Documentée mais absente du code : \`${k}\``);
for (const k of missingInSpec) lines.push(`- Montée mais absente du contrat OpenAPI : \`${k}\``);
lines.push("");

writeFileSync(new URL("../../docs/API_ROUTES.md", import.meta.url), lines.join("\n"));
console.log(`docs/API_ROUTES.md : ${mounted.size} routes, ${missingInCode.length + missingInSpec.length} écart(s).`);
