-- Plafond de connexions identifiant/mot de passe à FBI (2026-10-06) : chaque
-- coupure d'adresse de la journée a suivi, d'environ 10 s, une connexion avec
-- identifiants ; l'app en faisait jusqu'à plusieurs centaines par jour. Entre
-- deux connexions (au plus une toutes les 3 h par club), seule la session
-- conservée (fbi_saved_sessions) est reprise.
alter table public.fbi_integration_status add column if not exists last_credential_login_at timestamptz;
