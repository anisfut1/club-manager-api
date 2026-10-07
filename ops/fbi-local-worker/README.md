# Worker FBI local (Mac du club)

Exécute le traitement FBI de production (récupération des feuilles e-Marque,
dérogations, calendrier : mêmes jobs, mêmes fonctions que Vercel) depuis un
poste dont l'accès à FBI fonctionne. Le parsing des feuilles et les stats
restent faits par l'API.

## Mise en route (une fois)

```bash
cd ~/fbi-test && git pull && npm ci
```

Créer `~/fbi-test/.env.fbi-local` (jamais commité) avec les 4 valeurs copiées
depuis Vercel → projet `club-manager-api` → Settings → Environment Variables :

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
FBI_CREDENTIALS_ENCRYPTION_KEY=...
```

Ces clés donnent accès à la base : elles restent sur ce poste, jamais dans un
message ni un dépôt.

## Lancer

```bash
npm run fbi:local-worker
```

- **Une seule session FBI, gardée ouverte** : un navigateur lancé au démarrage,
  une connexion, puis la même session réutilisée à chaque passe ; aucune
  connexion tant qu'elle est authentifiée, aucune déconnexion.
- Chaque passe (15 min) : FBI joignable ? → session encore authentifiée (page
  d'accueil) ? → jusqu'à 3 feuilles e-Marque recherchées/téléchargées dans
  cette session. Sans job, la passe vérifie seulement la session.
- Session renvoyée vers l'identification : expiration journalisée (preuves),
  traitements de la passe arrêtés ; UNE nouvelle connexion au plus tôt à la
  passe suivante (et 12 min après la précédente). `FBI_LOCAL_RELOGIN=never`
  dans `.env.fbi-local` pour l'interdire.
- Seules les feuilles e-Marque sont traitées ici (les dérogations et le
  calendrier ouvriraient leur propre connexion).
- Journal : `fbi-local-worker-<date>.jsonl` (sans identifiant, mot de passe
  ni valeur de cookie).
- Tant qu'il tourne, Vercel ne se connecte plus à FBI (bail de 30 min
  renouvelé à chaque passe dans `platform_settings.fbi_paused_until`).
- Ctrl+C : bail libéré (Vercel reprend immédiatement), navigateur fermé sans déconnexion FBI. Mac éteint ou en veille :
  le bail expire en 30 min et Vercel reprend seul.
- Le Mac doit rester allumé et éveillé (`caffeinate -i npm run fbi:local-worker`
  empêche la veille pendant que le worker tourne).
