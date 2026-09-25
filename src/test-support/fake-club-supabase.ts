/**
 * Fake Supabase réutilisable pour les tests de routes Hono (§17/§19/§25 de
 * la demande : "tester les permissions" pour chaque nouvelle route) — même
 * esprit que le fake déjà utilisé par `tenancy/club-context.test.ts`, mais
 * partagé pour éviter de le dupliquer dans chaque fichier de test de route.
 *
 * Couvre uniquement ce dont les middlewares/routes ont besoin — PAS un mock
 * générique de tout Supabase, et n'applique AUCUNE RLS réelle : l'isolation
 * cross-tenant réelle reste garantie par `supabase/tests/isolation_test.sql`
 * contre un vrai PostgreSQL ; ce fake ne vérifie que la logique applicative
 * (permissions, validation, branchement) au-dessus.
 */

export interface FakeClubRow {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  timezone: string;
  status: "active" | "suspended";
  ffbb_club_id: string;
  ffbb_enabled: boolean;
  ffbb_next_sync_at: string | null;
}

export interface FakeMembershipRow {
  id: string;
  club_id: string;
  user_id: string;
  status: "active" | "suspended";
  /** Rattachement à un licencié (§ fiche joueur) — voir club_memberships.licencie_id. */
  licencie_id?: string | null;
}

export interface FakeLicencieRow {
  id: string;
  club_id: string;
  first_name: string;
  last_name: string;
  license_number: string | null;
  birth_date: string | null;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  active: boolean;
}

export interface FakeRoleRow {
  membership_id: string;
  role: string;
}

export interface FakeFbiCredentialsRow {
  club_id: string;
  username: string;
  password_ciphertext: string;
  password_iv: string;
  password_auth_tag: string;
}

export interface FakeFbiIntegrationStatusRow {
  club_id: string;
  configured: boolean;
  last_login_success: boolean | null;
  last_login_at: string | null;
  auto_import_emarque: boolean;
  last_error: string | null;
}

export interface FakeSyncRunRow {
  id: string;
  club_id: string;
  provider: "ffbb" | "fbi";
  status: string;
  started_at: string;
  finished_at: string | null;
  error_log: string | null;
}

export interface FakeMatchRow {
  id: string;
  club_id: string;
  numero: string | null;
  journee: string | null;
  match_datetime: string | null;
  is_home: boolean | null;
  opponent_name: string | null;
  venue_raw_label: string | null;
  score_home: number | null;
  score_away: number | null;
  status: string;
  emarque_status: string;
  team_id: string | null;
}

export interface FakeTeamRow {
  id: string;
  club_id: string;
  name: string;
}

export interface FakeEmarqueImportRow {
  id: string;
  club_id: string;
  match_id: string;
  status: string;
  source: "fbi";
  parser_version: string | null;
  quality_warnings: unknown;
  discovered_at: string;
  downloaded_at: string | null;
  imported_at: string | null;
  last_error: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  created_at: string;
}

export interface FakeProfileRow {
  user_id: string;
  display_name: string | null;
}

export interface FakeClubSupabaseState {
  clubs: FakeClubRow[];
  memberships: FakeMembershipRow[];
  roles: FakeRoleRow[];
  fbiCredentials: FakeFbiCredentialsRow[];
  fbiIntegrationStatus: FakeFbiIntegrationStatusRow[];
  syncRuns: FakeSyncRunRow[];
  matches: FakeMatchRow[];
  teams: FakeTeamRow[];
  emarqueImports: FakeEmarqueImportRow[];
  profiles: FakeProfileRow[];
  licencies: FakeLicencieRow[];
  isPlatformAdmin: boolean;
  /** Clés `${clubId}:${integration}` actuellement verrouillées (voir try_acquire_sync_lock/release_sync_lock). */
  syncLocks: Set<string>;
}

export function makeFakeClubSupabaseState(overrides: Partial<FakeClubSupabaseState> = {}): FakeClubSupabaseState {
  return {
    clubs: [],
    memberships: [],
    roles: [],
    fbiCredentials: [],
    fbiIntegrationStatus: [],
    syncRuns: [],
    licencies: [],
    matches: [],
    teams: [],
    emarqueImports: [],
    profiles: [],
    isPlatformAdmin: false,
    syncLocks: new Set(),
    ...overrides,
  };
}

function matchClub(row: FakeClubRow, col: string, value: string): boolean {
  return col === "id" ? row.id === value : row.slug === value;
}

/** Petit constructeur de requête chaînable `.eq()/.gte()/.lte()/.in()` générique sur un tableau en mémoire — suffisant pour les filtres réellement utilisés par les routes testées, pas un moteur de requête complet. */
function queryable<T extends object>(rows: T[]) {
  let filtered = rows;
  const orderKeys: { col: string; ascending: boolean }[] = [];
  const field = (r: T, col: string): unknown => (r as Record<string, unknown>)[col];
  const api = {
    eq(col: string, value: unknown) {
      filtered = filtered.filter((r) => field(r, col) === value);
      return api;
    },
    in(col: string, values: unknown[]) {
      filtered = filtered.filter((r) => values.includes(field(r, col)));
      return api;
    },
    gte(col: string, value: string) {
      filtered = filtered.filter((r) => (field(r, col) as string) >= value);
      return api;
    },
    lte(col: string, value: string) {
      filtered = filtered.filter((r) => (field(r, col) as string) <= value);
      return api;
    },
    lt(col: string, value: string) {
      filtered = filtered.filter((r) => (field(r, col) as string) < value);
      return api;
    },
    // Appels multiples de `.order()` cumulent les clés de tri (comme le vrai
    // client Supabase — `ORDER BY col1, col2`, jamais un simple écrasement
    // du tri précédent par le dernier appel).
    order(col: string, opts?: { ascending?: boolean }) {
      orderKeys.push({ col, ascending: opts?.ascending ?? true });
      filtered = [...filtered].sort((a, b) => {
        for (const key of orderKeys) {
          const av = field(a, key.col) as string | number | null;
          const bv = field(b, key.col) as string | number | null;
          if (av === bv) continue;
          if (av === null) return 1;
          if (bv === null) return -1;
          return (av < bv ? -1 : 1) * (key.ascending ? 1 : -1);
        }
        return 0;
      });
      return api;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return api;
    },
    range(from: number, to: number) {
      const total = filtered.length;
      filtered = filtered.slice(from, to + 1);
      return Promise.resolve({ data: filtered, error: null, count: total });
    },
    maybeSingle() {
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    },
    single() {
      return filtered[0] ? Promise.resolve({ data: filtered[0], error: null }) : Promise.resolve({ data: null, error: { message: "not found" } });
    },
    then(onFulfilled: (value: { data: T[]; error: null; count: number }) => unknown) {
      return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(onFulfilled);
    },
  };
  return api;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildFakeClubSupabase(state: FakeClubSupabaseState): any {
  const clubsTable = {
    select: (_cols?: string) => {
      const filters: { col: string; value: string }[] = [];
      const api = {
        eq(col: string, value: string) {
          filters.push({ col, value });
          return api;
        },
        maybeSingle() {
          const row = state.clubs.find((c) => filters.every((f) => matchClub(c, f.col, f.value)));
          return Promise.resolve({ data: row ?? null, error: null });
        },
        single() {
          const row = state.clubs.find((c) => filters.every((f) => matchClub(c, f.col, f.value)));
          return row ? Promise.resolve({ data: row, error: null }) : Promise.resolve({ data: null, error: { message: "not found" } });
        },
      };
      return api;
    },
    update: (patch: Partial<FakeClubRow>) => ({
      eq(_col: string, id: string) {
        const row = state.clubs.find((c) => c.id === id);
        const api = {
          select: () => api,
          single: () => {
            if (!row) return Promise.resolve({ data: null, error: { message: "not found" } });
            Object.assign(row, patch);
            return Promise.resolve({ data: row, error: null });
          },
        };
        return api;
      },
    }),
  };

  const membershipsTable = {
    select: (_cols?: string) => ({
      eq(_c1: string, clubId: string) {
        return {
          eq(_c2: string, userId: string) {
            return {
              eq(_c3: string, status: string) {
                return {
                  maybeSingle: () =>
                    Promise.resolve({
                      data: state.memberships.find((m) => m.club_id === clubId && m.user_id === userId && m.status === status) ?? null,
                      error: null,
                    }),
                };
              },
            };
          },
        };
      },
    }),
  };

  const rolesTable = {
    select: (_cols?: string) => ({
      eq: (_col: string, membershipId: string) => Promise.resolve({ data: state.roles.filter((r) => r.membership_id === membershipId), error: null }),
    }),
  };

  const fbiCredentialsTable = {
    select: (_cols?: string) => ({
      eq: (_col: string, clubId: string) => ({
        maybeSingle: () => Promise.resolve({ data: state.fbiCredentials.find((r) => r.club_id === clubId) ?? null, error: null }),
      }),
    }),
    upsert: (row: FakeFbiCredentialsRow) => {
      const index = state.fbiCredentials.findIndex((r) => r.club_id === row.club_id);
      if (index >= 0) state.fbiCredentials[index] = row;
      else state.fbiCredentials.push(row);
      return Promise.resolve({ error: null });
    },
  };

  const fbiIntegrationStatusTable = {
    select: (_cols?: string) => ({
      eq: (_col: string, clubId: string) => ({
        maybeSingle: () => Promise.resolve({ data: state.fbiIntegrationStatus.find((r) => r.club_id === clubId) ?? null, error: null }),
      }),
    }),
    upsert: (patch: Partial<FakeFbiIntegrationStatusRow> & { club_id: string }) => {
      const index = state.fbiIntegrationStatus.findIndex((r) => r.club_id === patch.club_id);
      if (index >= 0) Object.assign(state.fbiIntegrationStatus[index]!, patch);
      else
        state.fbiIntegrationStatus.push({
          configured: false,
          last_login_success: null,
          last_login_at: null,
          auto_import_emarque: false,
          last_error: null,
          ...patch,
        });
      return Promise.resolve({ error: null });
    },
  };

  const matchesTable = {
    select: (_cols?: string, _opts?: { count?: string }) => queryable(state.matches),
    update: (patch: Partial<FakeMatchRow>) => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        select() {
          const rows = state.matches.filter((m) => filters.every((f) => (m as unknown as Record<string, unknown>)[f.col] === f.value));
          rows.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return api;
    },
  };

  const teamsTable = { select: (_cols?: string) => queryable(state.teams) };
  const emarqueImportsTable = { select: (_cols?: string, _opts?: { count?: string }) => queryable(state.emarqueImports) };
  const syncRunsTable = { select: (_cols?: string) => queryable(state.syncRuns) };
  const profilesTable = {
    select: (_cols?: string) => ({
      eq: (_col: string, userId: string) => ({
        maybeSingle: () => Promise.resolve({ data: state.profiles.find((p) => p.user_id === userId) ?? null, error: null }),
      }),
    }),
  };

  // Stubs minimaux (toujours vides) : les routes de la fiche joueur
  // (modules/licencies/routes.ts) agrègent aussi ces deux tables, mais leur
  // jointure profonde n'est PAS testée ici — même choix que le détail d'un
  // match (`modules/matches/routes.ts#GET /:matchId`, jamais unit-testé
  // pour la même raison, voir son propre fichier de test) : seule la
  // logique de permission (admin/self/aucun) est couverte au niveau route,
  // la jointure elle-même est vérifiée manuellement contre la vraie base.
  const matchParticipantsTable = {
    select: (_cols?: string) => ({
      eq: (_c1: string, _clubId: string) => ({ eq: (_c2: string, _licencieId: string) => Promise.resolve({ data: [], error: null }) }),
    }),
  };
  const playerMatchStatsTable = {
    select: (_cols?: string) => ({ in: (_col: string, _ids: string[]) => Promise.resolve({ data: [], error: null }) }),
  };

  const licenciesTable = {
    select: (_cols?: string) => queryable(state.licencies),
    update: (patch: Partial<FakeLicencieRow>) => {
      const filters: { col: string; value: unknown }[] = [];
      const api = {
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return api;
        },
        select() {
          const rows = state.licencies.filter((l) => filters.every((f) => (l as unknown as Record<string, unknown>)[f.col] === f.value));
          rows.forEach((r) => Object.assign(r, patch));
          return {
            single: () => (rows[0] ? Promise.resolve({ data: rows[0], error: null }) : Promise.resolve({ data: null, error: { message: "not found" } })),
          };
        },
      };
      return api;
    },
  };

  return {
    from(table: string) {
      switch (table) {
        case "clubs":
          return clubsTable;
        case "club_memberships":
          return membershipsTable;
        case "membership_roles":
          return rolesTable;
        case "fbi_credentials":
          return fbiCredentialsTable;
        case "fbi_integration_status":
          return fbiIntegrationStatusTable;
        case "sync_runs":
          return syncRunsTable;
        case "matches":
          return matchesTable;
        case "teams":
          return teamsTable;
        case "emarque_imports":
          return emarqueImportsTable;
        case "profiles":
          return profilesTable;
        case "licencies":
          return licenciesTable;
        case "match_participants":
          return matchParticipantsTable;
        case "player_match_stats":
          return playerMatchStatsTable;
        default:
          throw new Error(`Table inattendue dans le fake Supabase de test : ${table}`);
      }
    },
    rpc(fn: string, args?: { p_club_id?: string; p_integration?: string }) {
      if (fn === "is_platform_admin") return Promise.resolve({ data: state.isPlatformAdmin, error: null });
      if (fn === "try_acquire_sync_lock") {
        const key = `${args?.p_club_id}:${args?.p_integration}`;
        if (state.syncLocks.has(key)) return Promise.resolve({ data: false, error: null });
        state.syncLocks.add(key);
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === "release_sync_lock") {
        const key = `${args?.p_club_id}:${args?.p_integration}`;
        state.syncLocks.delete(key);
        return Promise.resolve({ data: null, error: null });
      }
      throw new Error(`RPC inattendue dans le fake Supabase de test : ${fn}`);
    },
  };
}
