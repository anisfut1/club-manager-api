# Migration des dépôts (octobre 2026)

| Avant | Après | Rôle |
|---|---|---|
| `anisfut1/SCSB` | `anisfut1/ball-manager-web` | Frontend web Next.js (Vercel) : SaaS, pages publiques, AASA, confidentialité / aide, connexion web, Smart App Banner, repli des Universal Links |
| `anisfut1/club-manager-api` | `anisfut1/ball-manager-back` | API Hono (Vercel), Supabase, FFBB, FBI / e-Marque, OpenAPI, notifications APNs, authentification mobile, crons, migrations |
| (nouveau) | `anisfut1/ball-manager-app` | App mobile Expo / React Native (iOS, puis Android), EAS Build / Submit |

- Date : 2026-10-10.
- Les anciens noms n'apparaissent plus que dans ce document et dans `ball-manager-web/docs/REPOSITORY_RENAME_AUDIT.md`. Les fichiers de migration SQL déjà appliqués restent inchangés, car ce sont des commentaires historiques.

## Ce qui ne change pas

- **Projets Vercel.** Ils ne sont pas renommés : le domaine de l'API, `club-manager-api-two.vercel.app`, dérive du nom du projet. Il est appelé par le workflow `fbi-frequent-sync.yml` et par la variable `NEXT_PUBLIC_CLUB_MANAGER_API_URL` du web.
- **Noms de variables d'environnement** (`NEXT_PUBLIC_CLUB_MANAGER_API_URL`, `CLUB_MANAGER_OPENAPI_URL`).
- **Identifiants d'exécution du web** : clés `localStorage` `scsb:*`, cookie `scsb-public-known`, sel `scsb-public-session:`. Les changer déconnecterait les familles.
- **Répertoire du worker FBI déjà installé** (`/opt/club-manager-api`).
- **Base Supabase** : un seul projet.

## Liaisons

| Dépôt GitHub | Projet Vercel | Domaine de production |
|---|---|---|
| `ball-manager-web` | projet du frontend (inchangé) | `www.ball-manager.fr` |
| `ball-manager-back` | `club-manager-api` (inchangé) | `club-manager-api-two.vercel.app` |
| `ball-manager-app` | aucun (EAS) | App Store |

## Remotes

```sh
# ball-manager-web
git remote set-url origin https://github.com/anisfut1/ball-manager-web.git
# ball-manager-back
git remote set-url origin https://github.com/anisfut1/ball-manager-back.git
# ball-manager-app
git remote add origin https://github.com/anisfut1/ball-manager-app.git
```

## Branches

| Dépôt | Branche par défaut | Travail mobile |
|---|---|---|
| `ball-manager-web` | `claude/sete-basket-app-architecture-c3hlxx` (production) | `claude/ios-app` (Capacitor, gardé comme référence) |
| `ball-manager-back` | `main` | `claude/ios-app` (sessions d'appareil, push) |
| `ball-manager-app` | `main` | `claude/expo-app` |

## OpenAPI

`ball-manager-back` publie `/openapi.json`. C'est la source de vérité. Le web et l'app génèrent chacun leurs types (`npm run api:generate`).
