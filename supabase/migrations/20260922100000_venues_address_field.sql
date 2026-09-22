-- Renomme venues.commune en venues.address : le modèle réel de l'API
-- publique FFBB (confirmé via le SDK tiers ffbb-data-client,
-- models/get_salle_response.py — id/numero/libelle/adresse) n'expose
-- qu'une adresse consolidée en un seul champ, pas une commune séparée du
-- reste de l'adresse (voir docs/FFBB.md). "commune" restait vide depuis le
-- début (jamais alimenté avec ce champ) : renommage sans perte de données.
alter table public.venues rename column commune to address;

comment on column public.venues.address is
  'Adresse complète telle que renvoyée par ffbbserver_salles.adresse (chaîne unique, pas de découpage rue/code postal/commune côté API FFBB).';
