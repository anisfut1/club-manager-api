# Tests d'isolation RLS multi-tenant

Suite de tests SQL vérifiant, contre un **vrai moteur PostgreSQL**, que
l'isolation entre clubs (tenants) est réellement appliquée par les policies
RLS — pas seulement par le code applicatif (voir `docs/MULTI_TENANCY.md`).

Chaque assertion échouée lève une exception explicite et arrête le script
(`ON_ERROR_STOP=1`) : **un script qui va jusqu'au bout sans erreur signifie
que tous les tests sont passés.**

## Statut

Cette suite a été écrite et **exécutée avec succès** (42/42 assertions,
0 échec) contre une instance PostgreSQL 16 locale, en utilisant le shim
ci-dessous (pas de Docker disponible dans cet environnement de
développement) — d'abord 26 assertions lors de la migration multi-tenant,
puis 12 de plus lors de l'intégration FBI/e-Marque (`fbi_jobs`,
`match_documents`, voir `docs/JOBS.md`), puis 4 de plus lors de la
résolution des gaps frontend (voir `docs/API.md`) pour verrouiller au
niveau colonne le `PATCH /v1/clubs/:clubId`. Migrée telle quelle depuis
SCSB (voir `docs/MIGRATION.md`) et rejouée avec succès depuis ce
repository. Elle n'a pas encore été rejouée via la stack Supabase CLI
complète (`supabase test db`) — les deux chemins d'exécution sont
documentés ci-dessous.

**Correctif shim (résolution des gaps frontend) :**
`01_local_postgres_shim_after_migrations.sql` faisait un `grant select,
insert, update, delete on all tables ...` large APRÈS les migrations, ce
qui écrasait silencieusement le verrou colonne-par-colonne posé sur
`public.clubs` par `20260921100090_rls_multitenant_rewrite.sql` (`revoke
update ... / grant update (name, short_name, ...)`) — un test de sécurité
sur ce verrou aurait donc pu passer à tort dans ce shim local. Corrigé
pour ne plus ré-accorder `update` en large ici (déjà couvert par le
`alter default privileges` du shim `00`, exécuté AVANT les migrations,
donc pour toutes les tables qu'elles créent) ; voir le commentaire dans ce
fichier pour le détail. Sans objet sur un vrai projet Supabase (les
policies/grants du projet ne dépendent pas de ce shim).

## Scénarios couverts

- Un utilisateur membre uniquement du Club A ne voit que les données du
  Club A (matchs, licenciés, sync_runs, e-Marque, stats) — y compris en
  interrogeant directement un UUID connu du Club B, et y compris en
  tentant un `UPDATE` sur une ligne du Club B (0 ligne affectée).
- Idem symétriquement pour un utilisateur membre uniquement du Club B.
- Un utilisateur membre des DEUX clubs (rôles différents dans chacun) voit
  les deux, mais ne peut écrire que là où son rôle le permet.
- Un `platform_admin` voit les données des deux clubs (opérateur SaaS).
- Deux clubs peuvent avoir un licencié avec le même numéro de licence et un
  match avec le même `ffbb_match_id` sans collision (contraintes
  `UNIQUE(club_id, ...)`, jamais `UNIQUE(...)` seul).
- Un visiteur anonyme (rôle `anon`, non authentifié) ne voit rien.
- `fbi_credentials` reste invisible même pour l'admin de son propre club
  (aucune policy `authenticated`, accès service role uniquement).
- `fbi_jobs`/`match_documents` (pipeline FBI, voir `docs/JOBS.md`) : un
  club_admin ne voit et ne peut modifier QUE les lignes de son propre
  club — jamais celles d'un autre, y compris en tentant un `UPDATE`
  direct.
- `claim_next_fbi_job` (fonction `SECURITY DEFINER` utilisée par les
  routes `/internal/cron/*`) est refusée avec une erreur de permission
  pour `authenticated` ET `anon` — sans ce verrou (un correctif appliqué
  pendant cette suite de tests, voir
  `20260921110040_fbi_jobs_execute_lockdown.sql`), n'importe quel
  utilisateur authentifié aurait pu réclamer et lire le `fbi_jobs` d'un
  club dont il n'est même pas membre, contournant totalement la RLS.
- Le `service_role` (utilisé par `/internal/*`), lui, peut réclamer les
  jobs des DEUX clubs sans jamais les mélanger (deux appels successifs
  réclament bien deux jobs différents, un par club).
- Gap 1 (`PATCH /v1/clubs/:clubId`) : `authenticated` ne peut PAS modifier
  `status`/`slug`/`ffbb_club_id` de son propre club (colonnes non
  accordées, `permission denied` réelle), mais peut modifier `name`
  (colonne accordée) — vérifié au niveau grant PostgreSQL, pas seulement
  par la validation applicative Zod.

## Option A — Via Supabase CLI (stack locale complète, recommandé)

```bash
supabase test db
```

La stack Supabase locale fournit déjà `auth.uid()` et les rôles
`anon`/`authenticated`/`service_role` : ignorer les fichiers
`00_local_postgres_shim_before_migrations.sql` et
`01_local_postgres_shim_after_migrations.sql` (spécifiques à l'option B).

## Option B — Sur un PostgreSQL local sans Docker/Supabase CLI

Utile pour vérifier rapidement une migration sans dépendance lourde.

```bash
createdb scsb_isolation_test
psql -d scsb_isolation_test -v ON_ERROR_STOP=1 -f supabase/tests/00_local_postgres_shim_before_migrations.sql
for f in supabase/migrations/*.sql; do
  # emarque_storage_bucket.sql référence storage.buckets (schéma Supabase
  # Storage, absent d'un Postgres vanilla) : sans objet, à ignorer ici.
  [[ "$f" == *emarque_storage_bucket* ]] && continue
  psql -d scsb_isolation_test -v ON_ERROR_STOP=1 -f "$f"
done
psql -d scsb_isolation_test -v ON_ERROR_STOP=1 -f supabase/tests/01_local_postgres_shim_after_migrations.sql
psql -d scsb_isolation_test -v ON_ERROR_STOP=1 -f supabase/tests/fixtures.sql
psql -d scsb_isolation_test -v ON_ERROR_STOP=1 -f supabase/tests/isolation_test.sql
```

Un `NOTICE: === TOUS LES TESTS D'ISOLATION SONT PASSES ===` en dernière
ligne, sans aucune ligne `ERROR`, confirme le succès complet.
