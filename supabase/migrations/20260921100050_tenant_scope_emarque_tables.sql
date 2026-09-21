-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 6/10 : club_id explicite sur la couche e-Marque.
--
-- Même principe que la migration précédente : colonne nullable -> backfill
-- depuis matches.club_id -> contraintes -> NOT NULL. `file_hash` devient
-- unique PAR CLUB (deux clubs ne doivent jamais se déduplicer l'un l'autre,
-- même en cas de collision improbable) plutôt que globalement unique.
-- =============================================================================

alter table public.emarque_imports add column club_id uuid references public.clubs (id) on delete cascade;
update public.emarque_imports i set club_id = m.club_id from public.matches m where m.id = i.match_id and i.club_id is null;
alter table public.emarque_imports alter column club_id set not null;
create index emarque_imports_club_id_idx on public.emarque_imports (club_id);

alter table public.emarque_imports drop constraint emarque_imports_file_hash_key;
alter table public.emarque_imports add constraint emarque_imports_club_file_hash_unique unique (club_id, file_hash);

comment on column public.emarque_imports.club_id is
  'Tenant propriétaire (dérivé de matches.club_id). Garantit que file_hash ne déduplique jamais deux clubs différents.';

alter table public.match_participants add column club_id uuid references public.clubs (id) on delete cascade;
update public.match_participants p set club_id = m.club_id from public.matches m where m.id = p.match_id and p.club_id is null;
alter table public.match_participants alter column club_id set not null;
create index match_participants_club_id_idx on public.match_participants (club_id);

alter table public.match_coaches add column club_id uuid references public.clubs (id) on delete cascade;
update public.match_coaches c set club_id = m.club_id from public.matches m where m.id = c.match_id and c.club_id is null;
alter table public.match_coaches alter column club_id set not null;
create index match_coaches_club_id_idx on public.match_coaches (club_id);

alter table public.match_officials add column club_id uuid references public.clubs (id) on delete cascade;
update public.match_officials o set club_id = m.club_id from public.matches m where m.id = o.match_id and o.club_id is null;
alter table public.match_officials alter column club_id set not null;
create index match_officials_club_id_idx on public.match_officials (club_id);

alter table public.match_table_officials add column club_id uuid references public.clubs (id) on delete cascade;
update public.match_table_officials t set club_id = m.club_id from public.matches m where m.id = t.match_id and t.club_id is null;
alter table public.match_table_officials alter column club_id set not null;
create index match_table_officials_club_id_idx on public.match_table_officials (club_id);

alter table public.player_match_stats add column club_id uuid references public.clubs (id) on delete cascade;
update public.player_match_stats s set club_id = m.club_id from public.matches m where m.id = s.match_id and s.club_id is null;
alter table public.player_match_stats alter column club_id set not null;
create index player_match_stats_club_id_idx on public.player_match_stats (club_id);

alter table public.shot_events add column club_id uuid references public.clubs (id) on delete cascade;
update public.shot_events e set club_id = m.club_id from public.matches m where m.id = e.match_id and e.club_id is null;
alter table public.shot_events alter column club_id set not null;
create index shot_events_club_id_idx on public.shot_events (club_id);
