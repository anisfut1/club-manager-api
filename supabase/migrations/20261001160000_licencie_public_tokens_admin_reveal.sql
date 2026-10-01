-- Retour du club, 2026-10-01 : « l'admin doit avoir accès au lien unique par
-- joueur au cas où il a besoin de l'envoyer ».
--
-- Le jeton reste haché pour l'authentification (`token_hash`) ; on garde en
-- plus une copie CHIFFRÉE (AES-256-GCM, clé FBI_CREDENTIALS_ENCRYPTION_KEY
-- côté API, AAD = club + licencié) pour qu'un club_admin puisse réafficher le
-- lien EXISTANT sans le régénérer (le lien déjà utilisé par le joueur reste
-- valable). Déchiffré uniquement par club-manager-api (la clé n'est jamais
-- en base) ; la table reste sous la policy existante `..._all_club_admin`.
alter table public.licencie_public_tokens
  add column if not exists token_ciphertext jsonb;

comment on column public.licencie_public_tokens.token_ciphertext is
  'Jeton chiffré (AES-256-GCM {ciphertext, iv, authTag}) — réaffichage du lien par un club_admin. NULL pour les jetons émis avant 2026-10-01.';
