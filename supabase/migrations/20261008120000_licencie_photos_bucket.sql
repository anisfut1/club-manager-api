-- Photos de fiches joueurs (retour du club, 2026-10-08 : "insérer des photos
-- png/jpeg, compressées au max, stockées"). Compressées dans le navigateur
-- (WebP 512 px) avant envoi ; écrites UNIQUEMENT par l'API (rôle service,
-- aucune policy d'écriture). Lecture publique par URL : chemin aléatoire
-- (club/licencié/uuid), jamais listable ni devinable.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('licencie-photos', 'licencie-photos', true, 524288, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
