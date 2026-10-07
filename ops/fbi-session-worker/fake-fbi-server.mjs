// Faux FBI minimal pour tester le worker sans toucher au vrai FBI (voir README.md, « Auto-test »).
// /__invalidate vide les sessions côté serveur ; /__stats compte les connexions.
/* global console */
import http from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
const sessions = new Set();
let logins = 0;
const page = (body) => `<!doctype html><html><head><title>FBI</title></head><body>${body}</body></html>`;
const loginForm = page(`<form method="post" action="/fbi/identification.fbi"><input type="text" name="identificationBean.identifiant"><input type="password" name="identificationBean.mdp"><button type="submit">Connexion</button></form>`);
const sid = (req) => /JSESSIONID=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  console.log(new Date().toISOString(), req.method, url.pathname, url.searchParams.get("action") ?? "", /HeadlessChrome|Chrome/.exec(req.headers["user-agent"] ?? "")?.[0] ?? (req.headers["user-agent"] ?? "").slice(0, 20));
  if (url.pathname === "/__invalidate") { sessions.clear(); res.end("ok"); return; }
  if (url.pathname === "/__stats") { res.end(JSON.stringify({ logins, sessions: sessions.size })); return; }
  if (url.pathname === "/fbi/connexion.fbi") { res.setHeader("content-type", "text/html"); res.end(loginForm); return; }
  if (url.pathname === "/fbi/identification.fbi" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const ok = body.includes("identifiant=robot") && body.includes("mdp=bon");
      if (!ok) { res.setHeader("content-type", "text/html"); res.end(loginForm.replace("<form", '<div class="alert">Identifiant ou mot de passe incorrect.</div><form')); return; }
      logins += 1; const id = randomBytes(8).toString("hex"); sessions.add(id);
      res.writeHead(302, { "set-cookie": `JSESSIONID=${id}; Path=/fbi; HttpOnly`, location: "/fbi/accueil.fbi" }); res.end();
    }); return;
  }
  if (url.pathname === "/fbi/accueil.fbi") {
    if (!sessions.has(sid(req))) { res.writeHead(302, { location: "/fbi/identification.fbi" }); res.end(); return; }
    res.setHeader("content-type", "text/html"); res.end(page(`<a href="/fbi/deconnexion.fbi">Déconnexion</a>`)); return;
  }
  if (url.pathname === "/fbi/identification.fbi") { res.setHeader("content-type", "text/html"); res.end(loginForm); return; }
  if (url.pathname === "/fbi/rechercherRencontreSaisieResultat.fbi") {
    if (!sessions.has(sid(req))) { res.writeHead(302, { location: "/fbi/identification.fbi" }); res.end(); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ iTotalRecords: "1", aaData: [] })); return;
  }
  res.writeHead(404); res.end();
}).listen(18777, "127.0.0.1");
