/**
 * Types du schéma PostgreSQL — écrits à la main.
 *
 * À remplacer/compléter par `supabase gen types typescript` dès qu'un vrai
 * projet Supabase existe (voir README). En attendant, ce fichier doit rester
 * synchronisé manuellement avec `supabase/migrations/`.
 *
 * Note : `Relationships: []`, ainsi que `Views` vides sur le schéma
 * `public`, sont requis par le typage générique de `@supabase/postgrest-js`
 * (voir `GenericTable`/`GenericSchema`) — ce ne sont pas des données, juste
 * la forme attendue par la lib. `Table<Row, Insert>` factorise cette forme
 * pour éviter la répétition.
 *
 * Multi-tenant (voir docs/MULTI_TENANCY.md) : `clubs` est le tenant. Les
 * anciens `app_role`/`user_roles` (globaux) ont été remplacés par
 * `club_role`/`club_memberships`/`membership_roles` (scopés au club).
 */

type Table<Row, Insert> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Insert>;
  Relationships: [];
};

type Fn<Args, Returns> = { Args: Args; Returns: Returns };

export type ClubStatus = "active" | "suspended";
export type MembershipStatus = "active" | "suspended";
export type ClubRole = "club_admin" | "correspondant_club" | "responsable_tables" | "coach" | "joueur" | "parent";
export type MatchStatus = "scheduled" | "played" | "postponed" | "cancelled" | "forfeit";
export type EmarqueMatchStatus =
  | "not_applicable"
  | "pending"
  | "waiting_for_emarque"
  | "discovered"
  | "downloading"
  | "downloaded"
  | "parsing"
  | "imported"
  | "error"
  | "needs_review";
export type SyncProvider = "ffbb" | "fbi";
export type SyncStatus = "running" | "success" | "partial" | "error";
export type EmarqueImportStatus = "discovered" | "downloading" | "downloaded" | "parsing" | "imported" | "error" | "needs_review";
export type TeamSide = "home" | "away";
export type CoachRole = "principal" | "adjoint";
export type RefereeRole = "referee_1" | "referee_2" | "referee_3";
export type TableOfficialRole = "scorer" | "assistant_scorer" | "timekeeper" | "shot_clock_operator" | "commissioner" | "other";
export type HistoricalSyncMode = "current_season" | "last_30_days" | "none";
export type FbiJobType = "test_connection" | "discover_emarque";
export type FbiJobStatus = "pending" | "claimed" | "running" | "succeeded" | "failed";
export type MatchDocumentType = "emarque_zip" | "match_sheet" | "summary" | "shot_chart" | "other";
export type MatchDocumentStatus = "downloaded" | "parsing" | "imported" | "error";

// `type`, pas `interface` : `GenericTable["Row"]` (postgrest-js) attend
// `Record<string, unknown>`, et seul un alias de type sur un littéral d'objet
// bénéficie de la signature d'index implicite qui satisfait cette contrainte
// (une interface, elle, reste "ouverte" et ne l'obtient pas) — sinon toute la
// `Database` s'effondre silencieusement en `never` pour TOUS les consommateurs.
export type FbiJobRow = {
  id: string;
  club_id: string;
  match_id: string | null;
  type: FbiJobType;
  status: FbiJobStatus;
  attempt_count: number;
  max_attempts: number;
  scheduled_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  result: unknown;
  created_at: string;
};

export interface Database {
  public: {
    Tables: {
      clubs: Table<
        {
          id: string;
          name: string;
          ffbb_club_id: string;
          slug: string;
          timezone: string;
          status: ClubStatus;
          short_name: string | null;
          logo_url: string | null;
          accent_color: string | null;
          ffbb_enabled: boolean;
          ffbb_next_sync_at: string | null;
          created_at: string;
        },
        {
          id?: string;
          name: string;
          ffbb_club_id: string;
          slug: string;
          timezone?: string;
          status?: ClubStatus;
          short_name?: string | null;
          logo_url?: string | null;
          accent_color?: string | null;
          ffbb_enabled?: boolean;
          ffbb_next_sync_at?: string | null;
          created_at?: string;
        }
      >;

      platform_admins: Table<{ user_id: string; created_at: string }, { user_id: string; created_at?: string }>;

      club_memberships: Table<
        {
          id: string;
          club_id: string;
          user_id: string;
          licencie_id: string | null;
          status: MembershipStatus;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          user_id: string;
          licencie_id?: string | null;
          status?: MembershipStatus;
          created_at?: string;
          updated_at?: string;
        }
      >;

      membership_roles: Table<
        { id: string; membership_id: string; role: ClubRole; scope_team_id: string | null; scope_key: string; created_at: string },
        { id?: string; membership_id: string; role: ClubRole; scope_team_id?: string | null; created_at?: string }
      >;

      licencies: Table<
        {
          id: string;
          club_id: string;
          first_name: string;
          last_name: string;
          birth_date: string | null;
          license_number: string | null;
          email: string | null;
          phone: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          first_name: string;
          last_name: string;
          birth_date?: string | null;
          license_number?: string | null;
          email?: string | null;
          phone?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        }
      >;

      profiles: Table<
        { user_id: string; display_name: string | null; created_at: string; updated_at: string },
        { user_id: string; display_name?: string | null; created_at?: string; updated_at?: string }
      >;

      teams: Table<
        { id: string; club_id: string; name: string; category: string | null; active: boolean; created_at: string; updated_at: string },
        { id?: string; club_id: string; name: string; category?: string | null; active?: boolean; created_at?: string; updated_at?: string }
      >;

      competitions: Table<
        {
          id: string;
          ffbb_competition_id: string;
          name: string;
          code: string | null;
          sexe: string | null;
          type_competition: string | null;
          category_code: string | null;
          category_label: string | null;
          phase_code: string | null;
          live_stat: boolean;
          emarque_v2: boolean;
          publication_internet: boolean;
          season: string | null;
          parent_ffbb_competition_id: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          ffbb_competition_id: string;
          name: string;
          code?: string | null;
          sexe?: string | null;
          type_competition?: string | null;
          category_code?: string | null;
          category_label?: string | null;
          phase_code?: string | null;
          live_stat?: boolean;
          emarque_v2?: boolean;
          publication_internet?: boolean;
          season?: string | null;
          parent_ffbb_competition_id?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      pools: Table<
        {
          id: string;
          ffbb_pool_id: string;
          competition_id: string;
          name: string;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          ffbb_pool_id: string;
          competition_id: string;
          name: string;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      venues: Table<
        {
          id: string;
          ffbb_venue_id: string | null;
          name: string | null;
          commune: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          ffbb_venue_id?: string | null;
          name?: string | null;
          commune?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      ffbb_team_engagements: Table<
        {
          id: string;
          club_id: string;
          team_id: string;
          ffbb_engagement_id: string;
          competition_id: string;
          pool_id: string | null;
          season: string | null;
          name: string | null;
          numero_equipe: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          team_id: string;
          ffbb_engagement_id: string;
          competition_id: string;
          pool_id?: string | null;
          season?: string | null;
          name?: string | null;
          numero_equipe?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      matches: Table<
        {
          id: string;
          club_id: string;
          ffbb_match_id: string;
          ffbb_unique_key: string | null;
          ffbb_gs_id: string | null;
          numero: string | null;
          team_id: string | null;
          competition_id: string | null;
          pool_id: string | null;
          journee: string | null;
          match_datetime: string | null;
          is_home: boolean | null;
          opponent_name: string | null;
          opponent_ffbb_organisme_id: string | null;
          venue_id: string | null;
          venue_raw_label: string | null;
          score_home: number | null;
          score_away: number | null;
          status: MatchStatus;
          emarque_status: EmarqueMatchStatus;
          emarque_discovery_attempt_count: number;
          emarque_next_discovery_attempt_at: string | null;
          raw_ffbb_payload: unknown;
          ffbb_last_seen_at: string;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          ffbb_match_id: string;
          ffbb_unique_key?: string | null;
          ffbb_gs_id?: string | null;
          numero?: string | null;
          team_id?: string | null;
          competition_id?: string | null;
          pool_id?: string | null;
          journee?: string | null;
          match_datetime?: string | null;
          is_home?: boolean | null;
          opponent_name?: string | null;
          opponent_ffbb_organisme_id?: string | null;
          venue_id?: string | null;
          venue_raw_label?: string | null;
          score_home?: number | null;
          score_away?: number | null;
          status?: MatchStatus;
          emarque_status?: EmarqueMatchStatus;
          emarque_discovery_attempt_count?: number;
          emarque_next_discovery_attempt_at?: string | null;
          raw_ffbb_payload?: unknown;
          ffbb_last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_change_history: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          sync_run_id: string | null;
          field_name: string;
          old_value: string | null;
          new_value: string | null;
          detected_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          sync_run_id?: string | null;
          field_name: string;
          old_value?: string | null;
          new_value?: string | null;
          detected_at?: string;
        }
      >;

      sync_runs: Table<
        {
          id: string;
          club_id: string;
          provider: SyncProvider;
          started_at: string;
          finished_at: string | null;
          status: SyncStatus;
          stats: unknown;
          error_log: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          provider: SyncProvider;
          started_at?: string;
          finished_at?: string | null;
          status?: SyncStatus;
          stats?: unknown;
          error_log?: string | null;
          created_at?: string;
        }
      >;

      fbi_credentials: Table<
        {
          id: string;
          club_id: string;
          username: string;
          password_ciphertext: string;
          password_iv: string;
          password_auth_tag: string;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          username: string;
          password_ciphertext: string;
          password_iv: string;
          password_auth_tag: string;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      fbi_integration_status: Table<
        {
          id: string;
          club_id: string;
          configured: boolean;
          last_test_at: string | null;
          last_test_success: boolean | null;
          last_test_message: string | null;
          last_login_at: string | null;
          last_login_success: boolean | null;
          last_job_at: string | null;
          last_job_status: string | null;
          last_error: string | null;
          auto_import_emarque: boolean;
          historical_sync_mode: HistoricalSyncMode;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          configured?: boolean;
          last_test_at?: string | null;
          last_test_success?: boolean | null;
          last_test_message?: string | null;
          last_login_at?: string | null;
          last_login_success?: boolean | null;
          last_job_at?: string | null;
          last_job_status?: string | null;
          last_error?: string | null;
          auto_import_emarque?: boolean;
          historical_sync_mode?: HistoricalSyncMode;
          updated_at?: string;
        }
      >;

      fbi_jobs: Table<
        FbiJobRow,
        {
          id?: string;
          club_id: string;
          match_id?: string | null;
          type: FbiJobType;
          status?: FbiJobStatus;
          attempt_count?: number;
          max_attempts?: number;
          scheduled_at?: string;
          claimed_at?: string | null;
          claimed_by?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          last_error?: string | null;
          result?: unknown;
          created_at?: string;
        }
      >;

      match_documents: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          type: MatchDocumentType;
          source: "fbi";
          filename: string | null;
          mime_type: string | null;
          sha256: string;
          storage_path: string;
          status: MatchDocumentStatus;
          discovered_at: string;
          downloaded_at: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          type: MatchDocumentType;
          source?: "fbi";
          filename?: string | null;
          mime_type?: string | null;
          sha256: string;
          storage_path: string;
          status?: MatchDocumentStatus;
          discovered_at?: string;
          downloaded_at?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      sync_locks: Table<
        { club_id: string; integration: SyncProvider; locked_at: string },
        { club_id: string; integration: SyncProvider; locked_at?: string }
      >;

      emarque_imports: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          source: "fbi";
          file_hash: string | null;
          source_file_name: string | null;
          storage_path: string | null;
          status: EmarqueImportStatus;
          parser_version: string | null;
          quality_warnings: unknown;
          discovered_at: string;
          downloaded_at: string | null;
          imported_at: string | null;
          last_error: string | null;
          attempt_count: number;
          next_attempt_at: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          source?: "fbi";
          file_hash?: string | null;
          source_file_name?: string | null;
          storage_path?: string | null;
          status?: EmarqueImportStatus;
          parser_version?: string | null;
          quality_warnings?: unknown;
          discovered_at?: string;
          downloaded_at?: string | null;
          imported_at?: string | null;
          last_error?: string | null;
          attempt_count?: number;
          next_attempt_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_participants: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          jersey_number: string | null;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          is_captain: boolean;
          is_starter: boolean | null;
          licencie_id: string | null;
          extraction_confidence: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          jersey_number?: string | null;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          is_captain?: boolean;
          is_starter?: boolean | null;
          licencie_id?: string | null;
          extraction_confidence?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_coaches: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          role: CoachRole;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          licencie_id: string | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          team_side: TeamSide;
          role?: CoachRole;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          licencie_id?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      match_officials: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: RefereeRole;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          licencie_id: string | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: RefereeRole;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          licencie_id?: string | null;
          created_at?: string;
        }
      >;

      match_table_officials: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: TableOfficialRole;
          first_name: string | null;
          last_name: string | null;
          license_number: string | null;
          licencie_id: string | null;
          extraction_confidence: number | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          emarque_import_id: string;
          role: TableOfficialRole;
          first_name?: string | null;
          last_name?: string | null;
          license_number?: string | null;
          licencie_id?: string | null;
          extraction_confidence?: number | null;
          created_at?: string;
        }
      >;

      player_match_stats: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          participant_id: string;
          seconds_played: number | null;
          points: number | null;
          shots_made: number | null;
          three_points_made: number | null;
          two_points_interior_made: number | null;
          two_points_exterior_made: number | null;
          free_throws_made: number | null;
          fouls_committed: number | null;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          participant_id: string;
          seconds_played?: number | null;
          points?: number | null;
          shots_made?: number | null;
          three_points_made?: number | null;
          two_points_interior_made?: number | null;
          two_points_exterior_made?: number | null;
          free_throws_made?: number | null;
          fouls_committed?: number | null;
          created_at?: string;
          updated_at?: string;
        }
      >;

      shot_events: Table<
        {
          id: string;
          club_id: string;
          match_id: string;
          participant_id: string | null;
          team_side: TeamSide;
          period: number | null;
          made: boolean;
          shot_type: string | null;
          x: number | null;
          y: number | null;
          created_at: string;
        },
        {
          id?: string;
          club_id: string;
          match_id: string;
          participant_id?: string | null;
          team_side: TeamSide;
          period?: number | null;
          made: boolean;
          shot_type?: string | null;
          x?: number | null;
          y?: number | null;
          created_at?: string;
        }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      is_club_member: Fn<{ target_club_id: string }, boolean>;
      has_club_role: Fn<{ target_club_id: string; target_role: ClubRole }, boolean>;
      is_platform_admin: Fn<Record<string, never>, boolean>;
      try_acquire_sync_lock: Fn<{ p_club_id: string; p_integration: SyncProvider; p_stale_after?: string }, boolean>;
      release_sync_lock: Fn<{ p_club_id: string; p_integration: SyncProvider }, void>;
      claim_next_fbi_job: Fn<{ p_worker_id: string }, FbiJobRow | null>;
    };
    Enums: {
      club_role: ClubRole;
    };
  };
}
