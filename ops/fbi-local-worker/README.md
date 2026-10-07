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

- Une passe toutes les 15 min : jobs dus → dernière connexion FBI de plus de
  12 min → FBI joignable → UN job (une connexion, puis déconnexion).
- Tant qu'il tourne, Vercel ne se connecte plus à FBI (bail de 30 min
  renouvelé à chaque passe dans `platform_settings.fbi_paused_until`).
- Ctrl+C : bail libéré, Vercel reprend immédiatement. Mac éteint ou en veille :
  le bail expire en 30 min et Vercel reprend seul.
- Le Mac doit rester allumé et éveillé (`caffeinate -i npm run fbi:local-worker`
  empêche la veille pendant que le worker tourne).
