-- =============================================================================
-- `matches.match_datetime` était stocké FAUX depuis le tout premier sync
-- FFBB : `date_rencontre` renvoyé par l'API FFBB est une heure MURALE
-- FRANÇAISE, SANS AUCUN marqueur de fuseau ("2026-10-03T17:00:00", jamais
-- un "Z" ni un offset — confirmé sur les 656 matchs déjà synchronisés du
-- club, `raw_ffbb_payload->>'horaire'` toujours cohérent avec l'heure
-- embarquée dans `date_rencontre`). Le code (`public-provider.ts`)
-- copiait cette chaîne telle quelle dans une colonne `timestamptz`,
-- l'assimilant silencieusement à de l'UTC.
--
-- Bug RÉEL et confirmé en production le 2026-09-27 : le club a signalé une
-- fausse alerte de conflit de créneau (§ nouvelle fonctionnalité
-- schedule-conflict.ts) pour la rencontre n°15, dont FBI dit qu'elle est à
-- 17:00 — `match_datetime` affichait 19:00 (+2h, heure d'été CEST). Une
-- ligne `fbi_schedule_discrepancies` (kind="mismatch", field_name=
-- "match_datetime") avait DÉJÀ détecté cet écart précis le 2026-09-25
-- ("ffbb_value": "03/10/2026 19:00" vs "fbi_value": "03/10/2026 17:00")
-- sans jamais être corrigée — elle se résoudra d'elle-même à la prochaine
-- exécution de `processReconcileScheduleJob` maintenant que la donnée
-- sous-jacente est corrigée.
--
-- Fix définitif de l'ingestion : voir `normalizeFfbbDateTime`
-- (public-provider.ts), qui convertit désormais `date_rencontre` en
-- instant UTC réel via `zonedWallTimeToUtc` (DST-safe, +1h CET/+2h CEST
-- selon la date). Cette migration corrige les 656 lignes déjà en base à
-- partir de leur PROPRE `raw_ffbb_payload` déjà stocké (source de vérité
-- FFBB conservée), sans avoir besoin de re-synchroniser quoi que ce soit.
-- =============================================================================

update public.matches
set match_datetime = (raw_ffbb_payload ->> 'date_rencontre')::timestamp at time zone 'Europe/Paris'
where raw_ffbb_payload ->> 'date_rencontre' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$'
  and match_datetime is distinct from ((raw_ffbb_payload ->> 'date_rencontre')::timestamp at time zone 'Europe/Paris');
