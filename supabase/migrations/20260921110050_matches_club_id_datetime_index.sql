-- Index composite pour GET /v1/clubs/:clubId/matches (gap 7/12 de la
-- demande de résolution des gaps frontend) : chaque requête filtre
-- systématiquement par club_id puis trie/filtre par match_datetime
-- (period=weekend, from/to, pagination triée). `matches` n'avait jusqu'ici
-- aucun index sur club_id (seul `matches_match_datetime_idx` existe, sans
-- club_id en tête), donc ce filtre le plus fréquent forçait un scan complet
-- de la table à mesure qu'elle grossit.
create index matches_club_id_match_datetime_idx on public.matches (club_id, match_datetime);
