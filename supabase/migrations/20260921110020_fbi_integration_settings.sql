-- =============================================================================
-- FBI/e-Marque réellement automatisé — Étape 3/3 : réglages d'intégration.
--
-- §28/§29 du brief FBI : configuration minimale, pas 50 options.
-- auto_import_emarque : activée par défaut après une connexion réussie
-- (§30) — un club qui vient de se connecter n'a rien d'autre à faire.
-- historical_sync_mode : évite de télécharger 10 ans d'archives au premier
-- onboarding (§28) ; 'current_season' est le défaut raisonnable.
-- =============================================================================

alter table public.fbi_integration_status
  add column auto_import_emarque boolean not null default true,
  add column historical_sync_mode text not null default 'current_season'
    check (historical_sync_mode in ('current_season', 'last_30_days', 'none'));

comment on column public.fbi_integration_status.auto_import_emarque is
  'Si faux, aucun job discover_emarque n''est créé pour ce club même si FBI est configuré et connecté (interrupteur explicite, distinct de "configured").';
comment on column public.fbi_integration_status.historical_sync_mode is
  'Portée de la récupération e-Marque au moment de l''activation : current_season (défaut), last_30_days, ou none (rattrapage manuel via le bouton de resynchronisation admin uniquement).';
