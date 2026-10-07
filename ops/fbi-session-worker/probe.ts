/**
 * `npm run fbi:probe` — UNE sonde FBI couche par couche (DNS, TCP, TLS, HTTP),
 * anonyme, depuis la machine qui la lance. Résultat JSON sur la sortie
 * standard. Voir src/integrations/fbi/layered-probe.ts.
 */
import { probeFbiLayers } from "../../src/integrations/fbi/layered-probe.js";

const path = process.argv[2] ?? "/fbi/connexion.fbi";
const result = await probeFbiLayers({ path });
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.failedLayer ? 1 : 0;
