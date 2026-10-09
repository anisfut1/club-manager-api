# Vie d'équipe

Bloc métier demandé par le club le 2026-10-09 : planning, présences prévues,
convocations, lavage des maillots — et rien d'autre (pas de covoiturage,
chat, sondages, cotisations, SMS, push…). Livré par lots testables :

| Lot | Contenu | État |
|---|---|---|
| 1 | Entraînements (créneaux récurrents, séances, annuler / modifier une séance), Planning (matchs FFBB + entraînements), réponses Présent / Absent / Incertain, Home « À faire » | ✅ |
| 2 | Disponibilités match, convocations (message personnalisé, snapshot, confirmations), changement FFBB après envoi | ✅ |
| 3 | Lavage des maillots (suggestions équitables, le coach décide) | à faire |

## Identité : le lien personnel (décision du club, 2026-10-09)

Pas de compte pour les parents / joueurs : on garde le **lien personnel**
(un par licencié). Pour un mineur, c'est le parent qui détient le lien de
l'enfant. Un téléphone peut retenir **plusieurs liens** (un par enfant) :
la Home les envoie tous (`POST …/team-life/action-center`, liens dans le
corps, jamais dans l'URL) et fusionne les actions, chaque action indique
l'enfant concerné. Il n'y a pas de fiche « parent » : les textes restent
neutres (« Lina — entraînement mardi 19h »).

Droits (`modules/trainings/actor.ts`) :

- compte `club_admin` (ou admin plateforme) → toutes les équipes ; compte
  coach → son équipe (portée vide = toutes) ;
- lien personnel d'un admin désigné depuis /joueurs (`public_admin`, ou
  compte `club_admin` rattaché) → toutes les équipes ;
- lien personnel d'un coach (`public_coach`) → **uniquement** les équipes
  cochées sur sa fiche (`coached_team_ids`) ;
- tout lien → répondre pour **son** licencié, seulement pour les séances de
  **son** équipe (`team_id`). Jamais pour un autre, même UUID connu.

Un parent ne voit jamais les réponses des autres enfants (`counts: null`,
détail nominatif 403) ; le coach les voit pour ses équipes.

## Entraînements (Lot 1)

Tables (`supabase/migrations/20261009120000_trainings.sql`, RLS activée sans
policy — accès uniquement par l'API) :

- `training_series` : un créneau récurrent (jour 0–6, début/fin, gymnase du
  club `club_venue_id` **ou** lieu libre `location_label`, période). Aucun
  gymnase codé en dur.
- `training_occurrences` : les séances, générées à partir de la série
  (`series_date` = date prévue). `status` `scheduled` / `cancelled` (annulée
  = visible, jamais supprimée en silence) ; `is_modified` = modifiée à la
  main, jamais écrasée par une modification de la série.
- `training_responses` : `PRESENT` / `ABSENT` / `UNCERTAIN`, unique par
  séance et licencié, `responded_at`, `responded_by_user_id` /
  `responded_by_licencie_id` (déduits du contexte, jamais du corps).

Récurrence (`modules/trainings/recurrence.ts`, pure, testée) : chaque
semaine, heure locale du club (19:00 reste 19:00 au passage heure d'hiver).

Règles (`modules/trainings/service.ts`) :

- **Créer** : toute la semaine en un envoi (`slots[]`), une série par créneau.
- **Modifier à partir d'une date** : le passé et ce qui précède la date ne
  bougent pas. La série est coupée en deux ; si le jour ne change pas, les
  séances futures sont recalées (réponses conservées), sinon recréées au
  nouveau jour. Une séance modifiée à la main n'est jamais touchée.
- **Supprimer un créneau à partir d'une date** : séances futures supprimées
  si personne n'a répondu, **annulées** sinon.
- **Une séance** : modifier (date, horaires, lieu) ou annuler / rétablir.
- **Répondre** : jusqu'à la fin de la séance ; changer d'avis remplace la
  réponse (pas d'historique en V1).

## Planning

`GET /clubs/{clubId}/team-life/planning` (comptes) et
`POST /public/clubs/{clubSlug}/team-life/planning` (liens de l'appareil) :
matchs FFBB lus dans `matches` (jamais recopiés) + entraînements, triés par
date ; filtres équipe et type (`MATCH` / `TRAINING`). Fenêtre ≤ 120 jours.

## Home « À faire » (action center)

`POST /public/clubs/{clubSlug}/team-life/action-center` `{ tokens: [...] }`
renvoie, sur 14 jours :

1. `TRAINING_RESPONSE` : les 3 prochains entraînements de chaque enfant /
   joueur, avec la réponse actuelle (`null` = à répondre). Réponse en un
   clic : `PUT …/team-life/trainings/{id}/response?token=` (lien de l'enfant).
2. `COACH_TRAINING_SUMMARY` : prochaine séance de chaque équipe coachée,
   avec les compteurs (présents, absents, incertains, sans réponse).
3. `upcoming` : matchs + entraînements des équipes concernées, avec les
   prénoms concernés.

`canAddRelative` : afficher « Ajouter un enfant » seulement si plusieurs
personnes sont déjà sur l'appareil ou si un autre licencié actif du club
porte le même nom de famille (fratrie probable, retour du club 2026-10-09 :
« sinon ça sert à rien de l'afficher à tout le monde »). Booléen seul,
jamais le nom de l'autre licencié.

L'accueil public mêle les entraînements de `upcoming` à « Mon agenda »
(matchs du coach et du joueur), au lieu d'un planning séparé.

Tri : réponses attendues (chronologique), puis résumés coach, puis réponses
déjà données. Liens invalides signalés (`invalidTokenIndexes`) pour être
oubliés par l'appareil, jamais bloquants.

## Matchs : disponibilités et convocations (Lot 2)

Trois notions **distinctes** : DISPONIBLE (« je peux venir »), CONVOQUÉ
(« le coach m'a choisi »), CONFIRMÉ (« je confirme ma venue »).

1. **Demander les disponibilités** (coach / admin) :
   `match_availability_requests` (une par match et équipe). Ne crée **aucune**
   convocation. Les joueurs / parents de l'équipe voient « Lina est-elle
   disponible ? » sur la Home et répondent Disponible / Indisponible /
   Incertaine (`match_availability_responses`).
2. **Préparer la convocation** : brouillon (`draft_*` de
   `match_convocations`), jamais visible des familles. À la première
   préparation, les disponibles sont présélectionnés. Ordre d'affichage :
   disponibles, incertains, sans réponse, indisponibles. Sélectionner un
   indisponible est permis (alerte « Emma a indiqué être indisponible »).
   Rendez-vous : heure (`timestamptz`, fuseau du club) et lieu (texte libre,
   gymnase du club en option). À domicile, le lieu de rendez-vous par défaut
   est le gymnase du match ; **à l'extérieur, il est obligatoire**.
3. **Aperçu** : un exemple de message « parent » et « joueur majeur » selon
   la sélection, alertes et points bloquants.
4. **Envoyer** : photo du match (`match_snapshot`), révision + 1, message
   rendu pour chaque convoqué et gardé tel quel
   (`match_convocation_dispatches`), statut individuel PENDING / CONFIRMED /
   DECLINED (`match_convocation_recipients`). Envoi **dans l'application**
   seulement (Home), pas d'email / SMS / push en V1.
5. **Après envoi** : toute modification reste en brouillon
   (`hasUnsentChanges`) jusqu'à « Envoyer la mise à jour ». Si l'heure, le
   lieu de rendez-vous ou le match ont changé, les réponses repassent « en
   attente ». Un convoqué retiré garde son historique (`removed_at`).
6. **Match modifié par la FFBB** : `matchChanges` (DATE, VENUE, STATUS)
   compare la photo au match actuel ; le message déjà lu n'est jamais modifié
   en silence. Match annulé / reporté / commencé : plus de demande ni de
   confirmation (409 `MATCH_CLOSED`), la convocation reste en historique.

**Message** (`renderConvocationMessage`, fonction pure testée) : mineur ou
âge inconnu → message au parent (« Convocation pour Lina avec les U15 (F).
… Merci de confirmer la présence de Lina. ») ; majeur → « Bonjour Anis, … »
avec tutoiement. Jamais de tournure genrée (« convoqué·e ») : le sexe n'est
pas déduit du prénom. À l'extérieur, « Rendez-vous » et « Lieu du match »
sont toujours séparés.

**Home** : `MATCH_AVAILABILITY` (disponibilité à donner),
`CONVOCATION_RESPONSE` (message tel qu'envoyé, Je confirme / Je ne peux pas
venir en un clic), `COACH_MATCH` (étape suivante du coach pour chaque match
de ses équipes dans les 14 jours : `ASK_AVAILABILITY`,
`PREPARE_CONVOCATION`, `CONVOCATION_SENT` avec compteurs). Familles : matchs
des 21 prochains jours. Tri : réponses attendues, convocations à confirmer,
coach, le reste ; chronologique.

## Routes

Espace club (Bearer) sous `/v1/clubs/{clubId}/team-life`, espace public
(`?token=`) sous `/v1/public/clubs/{clubSlug}/team-life` — mêmes fonctions :

| Méthode | Chemin | Rôle |
|---|---|---|
| GET / POST | `/teams/{teamId}/training-series` | lister / créer les créneaux |
| PATCH / DELETE | `/training-series/{seriesId}` | modifier / arrêter à partir d'une date |
| GET / PATCH | `/trainings/{occurrenceId}` | détail (coach) / modifier cette séance |
| POST | `/trainings/{occurrenceId}/cancel`, `/restore` | annuler / rétablir |
| GET | `/trainings`, `/planning` | (club) séances, planning |
| GET | `/teams/{teamId}/trainings` | (public) séances d'une équipe gérée, avec compteurs |
| PUT | `/trainings/{occurrenceId}/response` | (public) Présent / Absent / Incertain |
| POST | `/action-center`, `/planning` | (public) Home, planning de l'appareil |
| GET | `/matches/{matchId}` | disponibilités + convocation (coach / admin) |
| POST | `/matches/{matchId}/availability/open` | demander les disponibilités |
| PUT | `/matches/{matchId}/convocation/draft` | brouillon : sélection, rendez-vous, message |
| POST | `/matches/{matchId}/convocation/preview`, `/send` | aperçu, envoi / mise à jour |
| PUT | `/matches/{matchId}/availability/response`, `/convocation/response` | (public) réponse du licencié du lien |

## Limites V1

- Pas de statistiques d'assiduité.
- Pas de notification externe (email, push, SMS) : tout est dans l'app.
- Les comptes « parents » n'existent pas : la Home fusionne les liens
  retenus sur l'appareil.
