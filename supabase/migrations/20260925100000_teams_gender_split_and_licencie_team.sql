-- =============================================================================
-- Fix : équipes garçons/filles fusionnées par erreur (bug de résolution
-- d'équipe FFBB) + rattachement d'un licencié à une équipe (demande du
-- club : sectoriser le roster et le calendrier par équipe, voir
-- docs/TEAMS.md).
--
-- Root cause découverte en production le 2026-09-25 :
-- `resolveTeamForEngagement` (src/integrations/ffbb/sync.ts) résolvait/
-- créait une équipe par NOM ("${categoryLabel} ${numeroEquipe}"), qui
-- n'encode JAMAIS le sexe — deux engagements FFBB de sexes différents
-- partageant le même numéro (ex : Seniors 1 masculine ET féminine)
-- fusionnaient silencieusement dans LA MÊME ligne `teams`, donc sous le
-- même `matches.team_id`. Constaté sur le club pilote : 5 équipes
-- concernées (Seniors 1, U11 1, U13 1, U15 1, U18 1), 57 matchs au total
-- mal regroupés — jamais PERDUS : `matches.competition_id` a toujours
-- pointé vers la bonne compétition (donc le bon sexe), indépendamment de
-- ce bug de regroupement — c'est ce qui permet cette correction sans
-- aucune perte de donnée.
--
-- Corrigé définitivement côté code (même commit) : la résolution se fait
-- désormais par (club_id, category, sexe, numero_equipe), jamais par une
-- chaîne de caractères fragile. Ce fichier corrige en plus les données
-- DÉJÀ fusionnées en production.
-- =============================================================================

alter table public.teams add column sexe text check (sexe in ('M', 'F'));
alter table public.teams add column numero_equipe text;

comment on column public.teams.sexe is
  'Sexe de cette équipe (M/F) — jamais mélangé, voir la découverte du 2026-09-25 documentée en tête de cette migration.';
comment on column public.teams.numero_equipe is
  'Numéro d''équipe au sein de (club, catégorie, sexe) — ex: "1", "2". Utilisé par resolveTeamForEngagement (sync.ts) pour retrouver/créer l''équipe SANS dépendre de son nom (modifiable librement par un·e club_admin sans casser la synchro FFBB).';

alter table public.licencies add column team_id uuid references public.teams (id) on delete set null;
comment on column public.licencies.team_id is
  'Équipe de ce·tte licencié·e (demande du club, docs/TEAMS.md). Renseigné automatiquement à l''auto-provisionnement depuis matches.team_id du match d''origine (voir persist-emarque-match.ts) — jamais réécrit ensuite automatiquement, modifiable par un·e club_admin.';

-- ---------------------------------------------------------------------------
-- Backfill sexe/numero_equipe pour les équipes qui n'ont JAMAIS été
-- fusionnées (un seul sexe parmi leurs engagements) : dérivé directement de
-- l'engagement associé le plus ancien.
-- ---------------------------------------------------------------------------
update public.teams t
set sexe = sub.sexe, numero_equipe = sub.numero_equipe
from (
  select distinct on (e.team_id) e.team_id, c.sexe, e.numero_equipe
  from public.ffbb_team_engagements e
  join public.competitions c on c.id = e.competition_id
  order by e.team_id, e.numero_equipe
) sub
where t.id = sub.team_id
  and t.sexe is null
  and (
    select count(distinct c2.sexe)
    from public.ffbb_team_engagements e2
    join public.competitions c2 on c2.id = e2.competition_id
    where e2.team_id = t.id
  ) = 1;

-- ---------------------------------------------------------------------------
-- Sépare toute équipe DONT les engagements couvrent PLUSIEURS sexes
-- distincts (bug décrit plus haut) : le sexe totalisant le plus de matchs
-- reste sur la ligne existante (nom inchangé, aucune rupture pour
-- l'historique déjà affiché) ; chaque AUTRE sexe migre vers une NOUVELLE
-- ligne (nom "<original> <SEXE>"), avec ses engagements et ses matchs
-- déplacés via leur compétition d'origine (jamais devinés).
-- ---------------------------------------------------------------------------
do $$
declare
  merged_team record;
  other_sexe record;
  primary_sexe text;
  new_team_id uuid;
begin
  for merged_team in
    select t.id as team_id, t.club_id, t.name, t.category
    from public.teams t
    where (
      select count(distinct c.sexe)
      from public.ffbb_team_engagements e
      join public.competitions c on c.id = e.competition_id
      where e.team_id = t.id
    ) > 1
  loop
    -- Le sexe qui totalise le plus de matchs reste sur la ligne existante.
    select c.sexe into primary_sexe
    from public.matches m
    join public.competitions c on c.id = m.competition_id
    where m.team_id = merged_team.team_id
    group by c.sexe
    order by count(*) desc
    limit 1;

    update public.teams set sexe = primary_sexe, numero_equipe = '1' where id = merged_team.team_id;

    for other_sexe in
      select distinct c.sexe
      from public.ffbb_team_engagements e
      join public.competitions c on c.id = e.competition_id
      where e.team_id = merged_team.team_id and c.sexe is distinct from primary_sexe
    loop
      insert into public.teams (club_id, name, category, sexe, numero_equipe, active)
      values (merged_team.club_id, merged_team.name || ' ' || other_sexe.sexe, merged_team.category, other_sexe.sexe, '1', true)
      returning id into new_team_id;

      update public.ffbb_team_engagements e
      set team_id = new_team_id
      from public.competitions c
      where e.competition_id = c.id and e.team_id = merged_team.team_id and c.sexe = other_sexe.sexe;

      update public.matches m
      set team_id = new_team_id
      from public.competitions c
      where m.competition_id = c.id and m.team_id = merged_team.team_id and c.sexe = other_sexe.sexe;
    end loop;
  end loop;
end $$;
