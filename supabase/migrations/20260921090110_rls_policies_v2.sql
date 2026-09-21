-- =============================================================================
-- RLS pour les tables ajoutées en Phase "produit clé en main" (FFBB + FBI +
-- e-Marque). Même principe qu'en Phase 0 (voir 20260921083040_rls_policies.sql) :
-- le frontend n'est jamais la barrière de sécurité.
--
-- Lignes directrices :
-- - Référentiel FFBB (teams, competitions, pools, venues, ffbb_team_engagements,
--   matches, match_change_history) : lecture pour tout utilisateur authentifié
--   (données de calendrier/résultats, non sensibles), écriture réservée au
--   super_admin (le service de synchronisation utilise la service role, qui
--   bypass la RLS — ces policies ne le concernent pas).
-- - sync_runs : diagnostic technique, réservé au super_admin.
-- - fbi_integration_status : statut (jamais de secret), réservé au super_admin
--   (page /admin/integrations).
-- - fbi_credentials : AUCUNE policy pour `authenticated` — accès service role
--   uniquement (voir la migration de création de la table).
-- - Données de match issues d'e-Marque (participants, coachs, officiels, OTM,
--   stats) : contiennent des données personnelles (potentiellement de
--   mineurs) mais servent l'écran /matchs/[id] pour tout utilisateur de
--   l'application interne (pas de visiteur anonyme possible, voir
--   src/proxy.ts) — lecture pour `authenticated`, écriture réservée au
--   super_admin (résolution manuelle depuis /admin/issues).
-- =============================================================================

alter table public.teams enable row level security;
alter table public.competitions enable row level security;
alter table public.pools enable row level security;
alter table public.venues enable row level security;
alter table public.ffbb_team_engagements enable row level security;
alter table public.matches enable row level security;
alter table public.match_change_history enable row level security;
alter table public.sync_runs enable row level security;
alter table public.fbi_credentials enable row level security;
alter table public.fbi_integration_status enable row level security;
alter table public.emarque_imports enable row level security;
alter table public.match_participants enable row level security;
alter table public.match_coaches enable row level security;
alter table public.match_officials enable row level security;
alter table public.match_table_officials enable row level security;
alter table public.player_match_stats enable row level security;
alter table public.shot_events enable row level security;

-- --- Référentiel FFBB : lecture authenticated, écriture super_admin -------
create policy "teams_select_authenticated" on public.teams for select to authenticated using (true);
create policy "teams_all_super_admin" on public.teams for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "competitions_select_authenticated" on public.competitions for select to authenticated using (true);
create policy "competitions_all_super_admin" on public.competitions for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "pools_select_authenticated" on public.pools for select to authenticated using (true);
create policy "pools_all_super_admin" on public.pools for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "venues_select_authenticated" on public.venues for select to authenticated using (true);
create policy "venues_all_super_admin" on public.venues for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "ffbb_team_engagements_select_authenticated" on public.ffbb_team_engagements for select to authenticated using (true);
create policy "ffbb_team_engagements_all_super_admin" on public.ffbb_team_engagements for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "matches_select_authenticated" on public.matches for select to authenticated using (true);
create policy "matches_all_super_admin" on public.matches for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "match_change_history_select_authenticated" on public.match_change_history for select to authenticated using (true);
create policy "match_change_history_all_super_admin" on public.match_change_history for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

-- --- Diagnostic / intégrations : super_admin uniquement -------------------
create policy "sync_runs_select_super_admin" on public.sync_runs for select to authenticated using (public.is_super_admin());

create policy "fbi_integration_status_select_super_admin" on public.fbi_integration_status for select to authenticated using (public.is_super_admin());

-- fbi_credentials : intentionnellement AUCUNE policy pour `authenticated`.
-- RLS activée + aucune policy = accès refusé à tout rôle autre que service
-- role, qui bypass la RLS.

-- --- Données de match e-Marque : lecture authenticated, écriture admin ---
create policy "emarque_imports_select_authenticated" on public.emarque_imports for select to authenticated using (true);
create policy "emarque_imports_all_super_admin" on public.emarque_imports for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "match_participants_select_authenticated" on public.match_participants for select to authenticated using (true);
create policy "match_participants_all_super_admin" on public.match_participants for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "match_coaches_select_authenticated" on public.match_coaches for select to authenticated using (true);
create policy "match_coaches_all_super_admin" on public.match_coaches for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "match_officials_select_authenticated" on public.match_officials for select to authenticated using (true);
create policy "match_officials_all_super_admin" on public.match_officials for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "match_table_officials_select_authenticated" on public.match_table_officials for select to authenticated using (true);
create policy "match_table_officials_all_super_admin" on public.match_table_officials for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "player_match_stats_select_authenticated" on public.player_match_stats for select to authenticated using (true);
create policy "player_match_stats_all_super_admin" on public.player_match_stats for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

create policy "shot_events_select_authenticated" on public.shot_events for select to authenticated using (true);
create policy "shot_events_all_super_admin" on public.shot_events for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());
