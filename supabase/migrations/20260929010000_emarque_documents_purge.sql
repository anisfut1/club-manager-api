-- Retour du club, 2026-09-29 : "je veux juste l'interpréter, récupérer les
-- stats et ensuite pas la stocker" — les documents e-Marque (feuilles de
-- match) ne sont plus conservés indéfiniment dans Storage une fois
-- parsés/stats extraites. `purged_at` trace QUAND le fichier original a
-- été supprimé de Storage (`NULL` = toujours présent) ; `match_documents`
-- reste le manifeste (type/filename/discovered_at) même après purge, pour
-- l'audit et pour ne jamais retélécharger un même fichier déjà traité
-- (dédoublonnage sur sha256, voir docs/EMARQUE.md).
alter table public.match_documents
  add column purged_at timestamptz null;

comment on column public.match_documents.purged_at is
  'Horodatage de suppression du fichier original dans Storage (NULL = encore présent). Les stats déjà extraites en base ne sont jamais affectées.';
