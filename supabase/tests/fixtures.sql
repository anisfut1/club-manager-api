-- Fixtures : deux clubs totalement indépendants, un utilisateur par club,
-- un utilisateur membre des deux, données métier synthétiques pour chacun.
-- Aucune donnée réelle (voir docs/MULTI_TENANCY.md).

insert into public.clubs (id, name, slug, ffbb_club_id, timezone)
values
  ('aaaaaaaa-0000-0000-0000-000000000000', 'Club A Basket', 'club-a', 'AAA0000001', 'Europe/Paris'),
  ('bbbbbbbb-0000-0000-0000-000000000000', 'Club B Basket', 'club-b', 'BBB0000002', 'Europe/Paris');

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'user-a@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'user-b@example.com'),
  ('cccccccc-0000-0000-0000-000000000001', 'user-ab@example.com');

-- Le trigger on_auth_user_created cree deja les profils ; rien a faire ici.

insert into public.club_memberships (id, club_id, user_id) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000000', 'cccccccc-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000000', 'cccccccc-0000-0000-0000-000000000001');

insert into public.membership_roles (membership_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'club_admin'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'club_admin'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'coach'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'joueur');

insert into public.teams (id, club_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000000', 'Equipe A'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000000', 'Equipe B');

insert into public.licencies (id, club_id, first_name, last_name, license_number) values
  ('aaaaaaaa-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000000', 'Alix', 'Testeur', 'AAA123456'),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000000', 'Sacha', 'Exemple', 'AAA123456');
-- meme numero de licence AAA123456 dans les deux clubs : doit coexister
-- (contrainte UNIQUE(club_id, license_number), jamais UNIQUE(license_number)).

insert into public.matches (id, club_id, ffbb_match_id, numero, team_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000000', 'ffbb-shared-123', '9001', 'aaaaaaaa-0000-0000-0000-000000000004', 'played'),
  ('bbbbbbbb-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-000000000000', 'ffbb-shared-123', '9001', 'bbbbbbbb-0000-0000-0000-000000000004', 'played');
-- meme ffbb_match_id 'ffbb-shared-123' dans les deux clubs (deux clubs
-- tenants qui s'affrontent, ou simple coincidence d'ID externe) : doit
-- coexister (contrainte UNIQUE(club_id, ffbb_match_id)).

insert into public.fbi_credentials (club_id, username, password_ciphertext, password_iv, password_auth_tag) values
  ('aaaaaaaa-0000-0000-0000-000000000000', 'clubA-user', 'ciphertext-a', 'iv-a', 'tag-a'),
  ('bbbbbbbb-0000-0000-0000-000000000000', 'clubB-user', 'ciphertext-b', 'iv-b', 'tag-b');

insert into public.sync_runs (id, club_id, provider, status) values
  ('aaaaaaaa-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000000', 'ffbb', 'success'),
  ('bbbbbbbb-0000-0000-0000-000000000007', 'bbbbbbbb-0000-0000-0000-000000000000', 'ffbb', 'success');

insert into public.emarque_imports (id, club_id, match_id, file_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'hash-a'),
  ('bbbbbbbb-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000006', 'hash-b');

insert into public.match_participants (id, club_id, match_id, emarque_import_id, team_side, jersey_number, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000008', 'home', '6', 'Joueur', 'ClubA'),
  ('bbbbbbbb-0000-0000-0000-000000000009', 'bbbbbbbb-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-000000000008', 'home', '6', 'Joueur', 'ClubB');

insert into public.player_match_stats (id, club_id, match_id, participant_id, points) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000009', 12),
  ('bbbbbbbb-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000006', 'bbbbbbbb-0000-0000-0000-000000000009', 20);

-- fbi_jobs (worker FBI, voir docs/FBI_WORKER.md) : un job discover_emarque
-- par club, sur le match de CE club uniquement.
insert into public.fbi_jobs (id, club_id, match_id, type) values
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'discover_emarque'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000006', 'discover_emarque');

-- match_documents : un ZIP déposé pour chaque club, chemin de storage
-- distinct (jamais partagé entre clubs, §22/§56 du brief FBI).
insert into public.match_documents (id, club_id, match_id, type, filename, sha256, storage_path) values
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'emarque_zip', '9001.zip', 'sha256-a', 'private/emarque/aaaaaaaa-0000-0000-0000-000000000000/2025-2026/aaaaaaaa-0000-0000-0000-000000000006/original.zip'),
  ('bbbbbbbb-0000-0000-0000-00000000000c', 'bbbbbbbb-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000006', 'emarque_zip', '9001.zip', 'sha256-b', 'private/emarque/bbbbbbbb-0000-0000-0000-000000000000/2025-2026/bbbbbbbb-0000-0000-0000-000000000006/original.zip');
