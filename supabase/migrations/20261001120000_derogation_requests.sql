-- =============================================================================
-- DEMANDES DE DÉROGATION INTERNES (coach → coordinateur) — retour du club,
-- 2026-10-01. Workflow INTERNE au club : AUCUNE de ces tables ne déclenche
-- d'écriture FFBB/FBI ni ne modifie `matches`. À ne pas confondre avec
-- `fbi_derogation_checks` (dérogations OFFICIELLES lues sur FBI).
--
--  club_venues               gymnases du club (mapping vers le référentiel FFBB `venues`)
--  club_scheduling_rules     plages de départ autorisées par jour de semaine
--  derogation_requests       une demande (au plus UNE active par match)
--  derogation_proposals      historique des créneaux proposés
--  derogation_messages       conversation (USER) + événements (SYSTEM)
--
-- Toutes les écritures passent par club-manager-api (rôle service, règles
-- métier + permissions vérifiées en code) : AUCUNE policy d'écriture pour
-- `authenticated`. Les policies de lecture ci-dessous sont une défense en
-- profondeur pour tout accès direct PostgREST.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Gymnases du club
-- -----------------------------------------------------------------------------
create table public.club_venues (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  name text not null,
  address text,
  venue_id uuid references public.venues (id) on delete set null,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, venue_id)
);

comment on table public.club_venues is
  'Gymnases utilisés par un club pour ses matchs à domicile (multi-club : 1, 2, 4... gymnases). `venue_id` relie au référentiel FFBB global `venues` (jamais dupliqué) ; alimenté depuis les matchs à domicile synchronisés.';

create index club_venues_club_id_idx on public.club_venues (club_id);

-- Données réelles uniquement : un gymnase par salle FFBB déjà utilisée pour
-- un match À DOMICILE du club (jamais un nom deviné). Ordre : salle la plus
-- utilisée d'abord. ACTIF seulement si la salle accueille un match à domicile
-- de la saison en cours (depuis le 1er août) — une salle utilisée une seule
-- fois la saison passée reste en base mais n'apparaît pas dans le planning
-- (réactivable par un club_admin, PATCH /v1/clubs/:clubId/venues/:id).
insert into public.club_venues (club_id, name, address, venue_id, sort_order, active)
select
  m.club_id,
  coalesce(v.name, split_part(min(m.venue_raw_label), ' — ', 1)),
  nullif(split_part(min(m.venue_raw_label), ' — ', 2), ''),
  m.venue_id,
  (row_number() over (partition by m.club_id order by count(*) desc))::int - 1,
  bool_or(m.match_datetime >= make_date(case when extract(month from now()) >= 8 then extract(year from now())::int else extract(year from now())::int - 1 end, 8, 1))
from public.matches m
join public.venues v on v.id = m.venue_id
where m.is_home = true and m.venue_id is not null
group by m.club_id, m.venue_id, v.name
on conflict (club_id, venue_id) do nothing;

-- -----------------------------------------------------------------------------
-- 2) Règles de planning par jour (0 = dimanche … 6 = samedi, comme JS getDay)
-- -----------------------------------------------------------------------------
create table public.club_scheduling_rules (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  earliest_start time not null,
  latest_start time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, weekday),
  check (earliest_start <= latest_start)
);

comment on table public.club_scheduling_rules is
  'Plage d''heures de DÉPART autorisées par jour pour les matchs à domicile d''un club (configuration club, jamais une vérité SaaS globale). Jour sans règle : aucune restriction horaire (seulement durée + collisions).';

-- Configuration actuelle du SC Sète (retour du club, 2026-10-01) :
-- samedi 13:00 → 21:00, dimanche 09:00 → 16:00.
insert into public.club_scheduling_rules (club_id, weekday, earliest_start, latest_start)
select id, rule.weekday, rule.earliest_start, rule.latest_start
from public.clubs
cross join (values (6::smallint, time '13:00', time '21:00'), (0::smallint, time '09:00', time '16:00')) as rule (weekday, earliest_start, latest_start)
where slug = 'sc-sete-basket'
on conflict (club_id, weekday) do nothing;

-- -----------------------------------------------------------------------------
-- 3) Demandes
-- -----------------------------------------------------------------------------
create table public.derogation_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  -- Équipe du club au moment de la demande (portée coach, filtres).
  team_id uuid references public.teams (id) on delete set null,
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  requester_membership_id uuid references public.club_memberships (id) on delete set null,
  requester_display_name text not null,
  -- Snapshot : horaire/salle officiels au moment de la demande.
  original_scheduled_at timestamptz,
  original_venue_id uuid references public.venues (id) on delete set null,
  -- Proposition courante (dénormalisée ; historique complet dans derogation_proposals).
  requested_start_at timestamptz not null,
  requested_club_venue_id uuid references public.club_venues (id) on delete set null,
  is_custom_weekday boolean not null default false,
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'IN_PROGRESS', 'NEEDS_CHANGE', 'COMPLETED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

comment on table public.derogation_requests is
  'Demande de dérogation INTERNE (coach → coordinateur). Ne modifie jamais FFBB/FBI ni `matches` : le coordinateur traite la dérogation officielle humainement.';

-- Une seule demande ACTIVE par match (COMPLETED/CANCELLED libèrent le match).
create unique index derogation_requests_one_active_per_match
  on public.derogation_requests (match_id)
  where status in ('REQUESTED', 'IN_PROGRESS', 'NEEDS_CHANGE');

create index derogation_requests_club_id_idx on public.derogation_requests (club_id);
create index derogation_requests_match_id_idx on public.derogation_requests (match_id);
create index derogation_requests_status_idx on public.derogation_requests (club_id, status);
create index derogation_requests_created_by_idx on public.derogation_requests (created_by_user_id);
create index derogation_requests_last_message_at_idx on public.derogation_requests (club_id, last_message_at desc);

-- Garde-fous structurels (même esprit que club_memberships_licencie_same_club).
create function public.check_derogation_request_same_club()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  match_club uuid;
  venue_club uuid;
begin
  select club_id into match_club from public.matches where id = new.match_id;
  if match_club is null or match_club <> new.club_id then
    raise exception 'derogation_requests.match_id doit appartenir au même club';
  end if;
  if new.requested_club_venue_id is not null then
    select club_id into venue_club from public.club_venues where id = new.requested_club_venue_id;
    if venue_club is null or venue_club <> new.club_id then
      raise exception 'derogation_requests.requested_club_venue_id doit appartenir au même club';
    end if;
  end if;
  return new;
end;
$$;

create trigger derogation_requests_same_club
  before insert or update of match_id, club_id, requested_club_venue_id on public.derogation_requests
  for each row execute function public.check_derogation_request_same_club();

-- -----------------------------------------------------------------------------
-- 4) Propositions (historique des créneaux)
-- -----------------------------------------------------------------------------
create table public.derogation_proposals (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  request_id uuid not null references public.derogation_requests (id) on delete cascade,
  proposed_by_user_id uuid not null references auth.users (id) on delete restrict,
  proposed_by_display_name text not null,
  requested_start_at timestamptz not null,
  requested_club_venue_id uuid references public.club_venues (id) on delete set null,
  is_custom_weekday boolean not null default false,
  created_at timestamptz not null default now()
);

create index derogation_proposals_request_idx on public.derogation_proposals (request_id, created_at);

-- -----------------------------------------------------------------------------
-- 5) Conversation
-- -----------------------------------------------------------------------------
create table public.derogation_messages (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  request_id uuid not null references public.derogation_requests (id) on delete cascade,
  author_user_id uuid references auth.users (id) on delete set null,
  author_membership_id uuid references public.club_memberships (id) on delete set null,
  author_display_name text not null,
  -- Libellé de rôle au moment du message (« Coach », « Coordinateur »...).
  author_role_label text,
  body text not null check (char_length(body) between 1 and 3000),
  message_type text not null check (message_type in ('USER', 'SYSTEM')),
  -- Pour SYSTEM : nature de l'événement (REQUEST_CREATED, TAKEN_IN_CHARGE...).
  event text,
  created_at timestamptz not null default now()
);

create index derogation_messages_request_idx on public.derogation_messages (request_id, created_at);

-- -----------------------------------------------------------------------------
-- 6) RLS
-- -----------------------------------------------------------------------------
-- Vrai si l'utilisateur courant peut LIRE une demande : coordinateur
-- (correspondant_club) ou club_admin du club, auteur de la demande, ou coach
-- de l'équipe concernée (rôle coach à portée club entière ou scopé sur cette
-- équipe). Même règle que le code applicatif (modules/derogation-requests).
create function public.can_read_derogation_request(target_club_id uuid, target_team_id uuid, target_created_by uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_platform_admin()
    or (
      public.is_club_member(target_club_id)
      and (
        target_created_by = auth.uid()
        or public.has_club_role(target_club_id, 'club_admin')
        or public.has_club_role(target_club_id, 'correspondant_club')
        or exists (
          select 1
          from public.club_memberships m
          join public.membership_roles r on r.membership_id = m.id
          where m.club_id = target_club_id
            and m.user_id = auth.uid()
            and m.status = 'active'
            and r.role = 'coach'
            and (r.scope_team_id is null or r.scope_team_id = target_team_id)
        )
      )
    );
$$;

comment on function public.can_read_derogation_request(uuid, uuid, uuid) is
  'Lecture d''une demande de dérogation interne : coordinateur/club_admin du club, auteur, ou coach de l''équipe. SECURITY DEFINER + search_path fixé.';

alter table public.club_venues enable row level security;
alter table public.club_scheduling_rules enable row level security;
alter table public.derogation_requests enable row level security;
alter table public.derogation_proposals enable row level security;
alter table public.derogation_messages enable row level security;

create policy "club_venues_select_member" on public.club_venues for select to authenticated
  using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "club_venues_all_club_admin" on public.club_venues for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "club_scheduling_rules_select_member" on public.club_scheduling_rules for select to authenticated
  using (public.is_club_member(club_id) or public.is_platform_admin());
create policy "club_scheduling_rules_all_club_admin" on public.club_scheduling_rules for all to authenticated
  using (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin())
  with check (public.has_club_role(club_id, 'club_admin') or public.is_platform_admin());

create policy "derogation_requests_select_authorized" on public.derogation_requests for select to authenticated
  using (public.can_read_derogation_request(club_id, team_id, created_by_user_id));

create policy "derogation_proposals_select_authorized" on public.derogation_proposals for select to authenticated
  using (exists (
    select 1 from public.derogation_requests r
    where r.id = request_id and r.club_id = derogation_proposals.club_id
      and public.can_read_derogation_request(r.club_id, r.team_id, r.created_by_user_id)
  ));

create policy "derogation_messages_select_authorized" on public.derogation_messages for select to authenticated
  using (exists (
    select 1 from public.derogation_requests r
    where r.id = request_id and r.club_id = derogation_messages.club_id
      and public.can_read_derogation_request(r.club_id, r.team_id, r.created_by_user_id)
  ));

-- Historique immuable : aucune suppression/édition depuis un client.
revoke insert, update, delete on public.derogation_requests, public.derogation_proposals, public.derogation_messages from authenticated, anon;
revoke all on public.derogation_requests, public.derogation_proposals, public.derogation_messages, public.club_venues, public.club_scheduling_rules from anon;
