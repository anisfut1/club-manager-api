/**
 * Commandes du worker de test FBI (voir worker.ts), sur le VPS :
 *   status  — état de la session et dernier événement
 *   tick    — passage immédiat (sonde réseau + vérification de session)
 *   login   — UNE connexion FBI, identifiants saisis au clavier (mot de
 *             passe masqué), transmis au worker par son socket local et
 *             jamais écrits sur disque. Refusée si la session est valide.
 */
import { createConnection } from "node:net";
import { ask } from "./prompt.js";

const socketPath = process.env.FBI_WORKER_SOCKET || "/run/fbi-session-worker/ctl.sock";

function send(request: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => socket.write(`${JSON.stringify(request)}\n`));
    let reply = "";
    socket.on("data", (chunk) => (reply += chunk.toString("utf8")));
    socket.on("end", () => resolve(reply.trim()));
    socket.on("error", reject);
  });
}

const cmd = process.argv[2] ?? "status";
if (cmd === "login") {
  const username = await ask("Identifiant FBI : ", false);
  const password = await ask("Mot de passe FBI (masqué) : ", true);
  console.log(await send({ cmd, username, password }));
} else if (cmd === "status" || cmd === "tick") {
  console.log(await send({ cmd }));
} else {
  console.error("usage : ctl.ts status | tick | login");
  process.exitCode = 2;
}
