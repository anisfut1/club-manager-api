-- =============================================================================
-- MIGRATION SAAS MULTI-TENANT — Étape 7/10 : audit des contraintes UNIQUE.
--
-- `licencies.license_number` n'avait aucune contrainte d'unicité (Phase 0).
-- Deux clubs différents peuvent légitimement avoir chacun un licencié
-- portant le même numéro (une même personne physique licenciée dans deux
-- clubs au fil du temps, §6 du brief SaaS) : la contrainte est donc
-- UNIQUE(club_id, license_number), jamais UNIQUE(license_number) seul.
-- Index partiel car license_number est nullable (plusieurs NULL doivent
-- rester possibles).
-- =============================================================================

create unique index licencies_club_license_number_unique
  on public.licencies (club_id, license_number)
  where license_number is not null;
