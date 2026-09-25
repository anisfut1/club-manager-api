-- =============================================================================
-- Fiche joueur (demande du club, § "comment on peut optimiser tout ça là ?" /
-- "faire la fiche joueur associée à licence") — deux changements :
--
-- 1. `licencies.photo_url` : seul champ de "profil" réellement nouveau, les
--    autres "infos persos" (birth_date, email, phone) existent déjà depuis la
--    Phase 0. Même convention que `clubs.logo_url` (simple URL, pas de pipeline
--    d'upload dans ce backend, voir modules/clubs/routes.ts) — un admin ou le
--    licencié lui-même (une fois rattaché à un compte, voir club_memberships.
--    licencie_id) y colle l'URL d'une photo hébergée ailleurs.
--
-- 2. Élargissement de la lecture : la RLS actuelle (20260921100090) ne permet
--    de lire un `licencies` qu'au club_admin OU au licencié lui-même
--    ("licencies_select_own") — jamais à un autre membre du club, alors que
--    les tables adjacentes qu'une fiche joueur agrège (match_participants,
--    player_match_stats) sont déjà lisibles par TOUT membre actif du club
--    (`is_club_member`, voir "match_participants_select_member" /
--    "player_match_stats_select_member" dans la même migration). Sans ce
--    changement, une fiche joueur serait invisible pour un coéquipier ou un
--    coach consultant la fiche d'un·e camarade — incohérent avec le reste de
--    l'app. Politique additive : les policies existantes ne sont jamais
--    supprimées ("select_own" reste, redondante mais inoffensive, pour un
--    licencié qui perdrait sa membership active mais garderait un accès
--    ponctuel — cas déjà couvert avant ce changement, non retiré ici).
-- =============================================================================

alter table public.licencies add column photo_url text;

comment on column public.licencies.photo_url is
  'URL d''une photo de profil (convention identique à clubs.logo_url) — jamais un fichier stocké par ce backend.';

create policy "licencies_select_member" on public.licencies for select to authenticated
  using (public.is_club_member(club_id) or public.is_platform_admin());
