-- Logo de l'organisme adverse (demande explicite du club, affichage dans
-- le calendrier). URL construite côté sync (voir
-- integrations/ffbb/public-provider.ts, listOrganismeLogos) —
-- {FFBB_API_BASE_URL}assets/{id} — jamais vérifiée en direct si cet
-- endpoint accepte les requêtes anonymes (voir docs/FFBB.md) : peut
-- nécessiter un proxy/cache d'images plus tard si ce n'est pas le cas.
alter table public.matches add column opponent_logo_url text;

comment on column public.matches.opponent_logo_url is
  'URL du logo FFBB de l''organisme adverse ({FFBB_API_BASE_URL}assets/{id}) — pas encore confirmé accessible sans authentification depuis un navigateur.';
