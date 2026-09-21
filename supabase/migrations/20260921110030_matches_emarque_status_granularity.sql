-- =============================================================================
-- Statuts e-Marque plus granulaires sur `matches` (§26 du brief FBI).
--
-- Le worker et le parseur sont désormais deux étapes asynchrones séparées
-- (voir docs/FBI_WORKER.md) : l'admin doit pouvoir distinguer "en attente
-- du document" de "document trouvé, téléchargement en cours" de
-- "téléchargé, en cours d'analyse", plutôt qu'un unique statut "pending"
-- qui masquerait la progression réelle.
-- =============================================================================

alter table public.matches drop constraint matches_emarque_status_check;

alter table public.matches add constraint matches_emarque_status_check
  check (emarque_status in (
    'not_applicable', 'pending', 'waiting_for_emarque',
    'discovered', 'downloading', 'downloaded', 'parsing',
    'imported', 'error', 'needs_review'
  ));

comment on column public.matches.emarque_status is
  'not_applicable: non concerné. pending: joué, en attente de traitement. waiting_for_emarque: rien trouvé chez FBI pour l''instant (retry). discovered/downloading/downloaded/parsing: progression du worker puis du parseur (voir docs/FBI_WORKER.md). imported: succès. error/needs_review: intervention admin (voir /c/{slug}/admin/issues).';
