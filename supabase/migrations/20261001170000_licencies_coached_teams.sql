-- Retour du club, 2026-10-01 : « quand on spécifie un coach, on peut lui
-- donner son équipe, comme ça on met un onglet accueil pour les coachs, et il
-- verra son agenda avec les matchs de ses équipes et où il doit coacher ».
--
-- Équipes COACHÉES par le licencié (un coach peut en avoir plusieurs) —
-- distinct de `team_id` (l'équipe où il JOUE). Sert uniquement à l'accueil
-- personnel de l'espace public ; les droits de demande de dérogation restent
-- ceux de `public_coach` (tous les matchs du club). Posé par un club_admin
-- depuis /joueurs. Les ids d'équipe sont revalidés par l'API (équipe du même
-- club) à l'écriture et filtrés à la lecture.
alter table public.licencies
  add column if not exists coached_team_ids uuid[] not null default '{}';

comment on column public.licencies.coached_team_ids is
  'Équipes coachées (accueil coach de l''espace public). Distinct de team_id (équipe où le licencié joue). Écrit par club-manager-api (club_admin).';
