# Plan d'action — Taxi Urbain (v3)
**5 nouveaux chantiers (avant le chantier 7 "Connexion Google" du plan v2), classés par dépendances puis par complexité croissante**

---

## Vue d'ensemble des dépendances

```
1. Historique en lecture seule        → indépendant, s'appuie sur le chantier 6 (déjà livré)
2. Positions read-only après commande → indépendant, prérequis léger du chantier 5
3. Fin de course sans chauffeur       → indépendant
4. Alerte problème client → admin     → indépendant (réutilise le PATTERN du chantier 2, pas son code)
5. Remplacement du point de départ    → dépend du chantier 2 (même read-only, réutilise sa logique d'état)
   (recherche plein écran + gel GPS)

7. Connexion Google (v2)              → toujours en dernier, inchangé
```

Aucun de ces 5 chantiers ne dépend de l'un des autres au sens strict (pas de blocage technique), mais le chantier 5 **prolonge** le chantier 2 : il serait redondant de coder le premier avant d'avoir stabilisé le second. L'ordre proposé suit donc : indépendance d'abord, complexité ensuite.

---

## 1. Historique de courses : passage en lecture seule

**Constat vérifié dans le code** : `viewRideOnMap()` / `displayRideOnMap()` (`client-ui.js`, lignes ~897-922) ne se contentent pas d'afficher une course terminée — elles **suppriment et réécrivent** `pickupCoords`, `destinationCoords`, `pickupMarker`, `destinationMarker`, `driverPositionMarker` et `driverRouteLayer`, c'est-à-dire les mêmes variables globales que celles utilisées par le suivi d'une course *active*.

**Problème concret** : si un client consulte son historique pendant qu'une course est en cours (`AppState.rideState` ≠ `idle`), cette fonction efface le marqueur et le tracé du chauffeur en circulation, puis remplace `pickupCoords`/`destinationCoords` par ceux de la course historique consultée. Le polling actif (`driverStatusInterval`) recrée bien le marqueur chauffeur au tick suivant, mais `destinationCoords` reste corrompu jusqu'à la prochaine transition d'état — l'utilisateur peut se retrouver avec la mauvaise destination affichée sur la carte pendant sa course réelle.

**Réponse à la question posée — quel mécanisme permet de "passer d'une course à l'autre sans les perdre" ?**
C'est déjà fait : le **chantier 6 du plan v2** (`get_active_ride.php` + `initActiveRideRecovery()`) est précisément ce mécanisme. Il ne repose pas sur un bricolage visuel (réafficher d'anciennes coordonnées sur la carte en espérant "rattraper" l'état) mais sur une source de vérité serveur, interrogée à la demande. Un client ne peut de toute façure avoir qu'**une seule course active à la fois** (contrainte déjà posée par `backend.php`, code 409 "Une course est déjà en cours"), donc il n'y a jamais réellement "plusieurs courses" à jongler côté client — seulement une course active (gérée par le chantier 6) et un historique de courses terminées (purement informatif). Le détournement de `displayRideOnMap()` était un pis-aller antérieur au chantier 6 ; il est aujourd'hui à la fois inutile et dangereux.

**Correctif** :
- Remplacer `viewRideOnMap()`/`displayRideOnMap()` par un affichage **qui ne touche à aucune variable globale de la carte active** : soit un panneau/modale de détail (texte + éventuellement une mini-carte statique indépendante, sans toucher à `map`), soit une carte figée dans une modale utilisant une instance Leaflet dédiée et jetée à la fermeture.
- Supprimer purement et simplement la logique de remplacement de `pickupCoords`/`destinationCoords`/marqueurs partagés.

**Fichiers concernés** :
- `frontend/client/js/client-ui.js` — `viewRideOnMap()`, `displayRideOnMap()` (lignes ~897-922)

**Portée** : isolé, aucun impact backend, aucune dépendance.

---

## 2. Lecture seule des positions après commande

**Constat vérifié** : côté serveur, `pickup_lat`/`pickup_lng` ne sont écrits **qu'une seule fois**, à l'`INSERT` dans `backend.php` — aucun endpoint ne les modifie ensuite. La donnée serveur est donc déjà fiable. Le problème est entièrement **côté client** :

- `updateMarker("pickup", …)` crée systématiquement un marqueur `draggable: true`, sans condition sur `AppState.rideState`.
- `watchUserPosition()` (géolocalisation continue) réécrit `pickupCoords` en continu, y compris pendant une course déjà commandée.

**Conséquence concrète** : une fois la course "trouvée" (`currentRideId` défini), l'utilisateur peut toujours faire glisser le marqueur ou voir sa position se déplacer — ce qui laisse croire que le point de départ transmis au chauffeur change, alors qu'en base `pickup_lat`/`pickup_lng` restent figés depuis la création. C'est trompeur : le client pense avoir corrigé son point de départ, le chauffeur navigue toujours vers l'ancien.

**Correctif (première étape, indépendante du chantier 5)** :
- Rendre le marqueur pickup non `draggable` dès que `AppState.rideState !== "idle"`.
- Faire en sorte que `watchUserPosition()` cesse d'écrire dans `pickupCoords` dès qu'une course existe (`currentRideId` non nul), pour ne pas donner l'illusion d'un point de départ qui bouge alors qu'il ne sert plus à rien.

Cette étape seule règle déjà le problème de fond ("read only après commande") avec un minimum de risque. Le chantier 5 va plus loin en remplaçant complètement le mode d'édition *avant* la commande.

**Fichiers concernés** :
- `frontend/client/js/client-ui.js` — `updateMarker()`, `watchUserPosition()`

**Portée** : isolé, purement frontend, aucun risque de régression serveur (le serveur ne change pas).

---

## 3. Fin de course automatique si aucun chauffeur disponible

**Constat** : le mécanisme de refus existant est déjà granulaire — `ride_refusals` (ride_id, driver_id) enregistre un refus **par chauffeur**, sans annuler la course pour les autres (`refuse_ride.php`). `get_rides.php` exclut logiquement, pour chaque chauffeur, les courses qu'il a lui-même refusées. Il n'existe en revanche **aucune expiration** : une course `pending` reste ainsi indéfiniment si tous les chauffeurs connectés l'ont refusée, ou si aucun chauffeur n'est en ligne.

**Contrainte d'hébergement à prendre en compte** : le projet est hébergé sur InfinityFree (confirmé par `.htaccess` et `backend/config/auth.php`), qui **ne fournit pas de cron jobs sur l'offre gratuite**. Un vrai job planifié ("toutes les 2 minutes, annuler les pending expirées") n'est donc pas réalisable simplement. La solution réaliste est une **expiration paresseuse** ("lazy expiration") : la vérification et l'annulation éventuelle se font au moment où un endpoint déjà appelé régulièrement est sollicité — pas besoin de nouveau processus serveur.

**Double condition d'expiration à trancher ensemble avant de coder** :
1. **Plus aucun chauffeur éligible** : aucun chauffeur `is_online = 1 AND status = 'active'` dont l'id n'est pas dans `ride_refusals` pour cette course.
2. **Limite de temps dure**, indépendamment des chauffeurs connectés (filet de sécurité si un chauffeur reste "en ligne" sans jamais répondre) — valeur à définir ensemble (ex. 5-10 minutes ?).

**Points à décider avec toi avant l'implémentation** :
- Faut-il un nouveau statut distinct (ex. `expired`) pour bien distinguer "personne n'a pu prendre la course" d'une annulation classique dans les statistiques admin, ou réutilise-t-on `cancelled` avec une colonne `cancel_reason` (approche à plus faible risque de migration, pas de modification de l'ENUM `status`) ?
- Valeur exacte du délai de la limite de temps.

**Travail (une fois les deux points ci-dessus tranchés)** :
1. **Backend** : fonction partagée `expire_stale_pending_rides($conn)` (nouveau fichier, ex. `backend/common/ride_expiry.php`), appelée en tête de `check_ride_status.php` et `get_active_ride.php` côté client (interrogés en polling toutes les 5s pendant une course pending) — pas besoin de la dupliquer côté chauffeur, l'expiration sera de toute façon visible dès le prochain appel client.
2. Logique : `UPDATE rides SET status = 'cancelled', cancel_reason = 'no_driver_available' WHERE status = 'pending' AND (condition 1 OR condition 2)`.
3. **Frontend client** : `onRideCancelled()` gère déjà la transition `cancelled`/`cancelled_client` — à adapter légèrement pour distinguer le message affiché ("Aucun chauffeur disponible pour le moment" plutôt qu'un message d'annulation générique) si `cancel_reason` est renvoyé par `check_ride_status.php`.

**Fichiers concernés** :
- Nouveau : `backend/common/ride_expiry.php`
- `backend/client/check_ride_status.php`, `backend/client/get_active_ride.php` (appel de la fonction)
- `database/schema.sql` — colonne `cancel_reason` (ou statut `expired`, selon décision)
- `frontend/client/js/client-ui.js` — message adapté dans `onRideCancelled()`

**Portée** : moyenne — nouveau fichier partagé, mais branché sur des endpoints déjà existants, aucun nouveau mécanisme d'infrastructure (pas de cron réel nécessaire).

---

## 4. Alerte "problème client" : retirer du chauffeur, déplacer vers l'admin

**Constat vérifié** : `showClientProblemAlerts()`/`openClientProblemAlert()` (`chauffeur-ui.js`, lignes ~1046-1103) affichent aujourd'hui au chauffeur lui-même une alerte plein écran **"ALERTE SÉCURITÉ — cette course est surveillée"** dès qu'un client signale un problème. C'est contre-productif du point de vue sécurité : le signalement est censé alerter une supervision, pas prévenir la personne surveillée qu'elle l'est — ce qui peut au contraire l'inciter à couvrir ses traces ou à réagir mal si la situation est déjà tendue.

**Point de vigilance supplémentaire** : retirer uniquement la modale ne suffit pas. `get_rides.php` fait un `SELECT *`, donc `client_problem_description` est déjà présent dans chaque réponse au chauffeur — visible via les outils de développement du navigateur même sans modale. Pour une vraie confidentialité, il faut **exclure cette colonne de la requête chauffeur**, pas seulement cacher son affichage.

**Côté admin, l'infrastructure est partiellement prête** : `backend/admin/list_problems.php` existe déjà et renvoie les courses avec `client_problem_description` ou `problem_description` renseigné — mais rien ne l'affiche côté frontend admin aujourd'hui, et il n'y a ni statut "résolu", ni mécanisme de non-répétition d'alerte.

**"Même mécanisme de non-renouvellement" (dédup)** : attention à une différence importante avec le chantier 2 (v2). Le dédup du chantier 2 vit en `localStorage` **côté navigateur du chauffeur** — ça convient à un chauffeur qui n'a qu'un seul appareil. Un admin peut se connecter depuis plusieurs postes ; un dédup purement `localStorage` ne serait pas synchronisé entre eux (l'alerte réapparaîtrait sur un autre poste). Je recommande donc un dédup **côté serveur** (colonne `client_problem_resolved_at`, action explicite "marquer comme traité"), plus robuste — le *principe* reste le même que le chantier 2 (ne pas re-notifier ce qui a déjà été vu/traité), seule l'implémentation change pour tenir compte du contexte multi-poste de l'admin.

**Travail** :
1. **Base de données** : colonne `client_problem_resolved_at TIMESTAMP NULL DEFAULT NULL` sur `rides`.
2. **Backend** :
   - `backend/admin/list_problems.php` — filtrer/exposer aussi `client_problem_resolved_at` pour permettre au frontend de distinguer traité/non traité.
   - Nouveau `backend/admin/resolve_client_problem.php` — marque `client_problem_resolved_at = NOW()` pour un `ride_id` donné.
   - `backend/chauffeur/get_rides.php` — retirer `client_problem_description`/`client_problem_at` du `SELECT *` (whitelist des colonnes plutôt que `*`, pour éviter qu'un futur champ sensible fuite de la même façon).
3. **Frontend admin** — c'est la partie la plus lourde de ce chantier : contrairement au chauffeur, l'admin n'a **pas de polling global indépendant de la section affichée** (chaque section — dashboard, carte, courses, chauffeurs — a son propre `setInterval`, actif uniquement pendant qu'elle est affichée). Pour qu'une alerte apparaisse même si l'admin est sur "Chauffeurs" ou "Clients", il faut un polling **global**, démarré une fois à l'initialisation de la page admin (pas par section), similaire dans son fonctionnement à `updateRideLists()` côté chauffeur.
4. Réutiliser le style d'alerte plein écran actuellement chez le chauffeur (`client-problem-alert`/`client-problem-box`), avec un bouton "Marquer comme traité" qui appelle `resolve_client_problem.php` plutôt qu'un simple "J'ai compris" qui ne fait qu'une fermeture locale.
5. **Frontend chauffeur** — retirer `showClientProblemAlerts()`, `openClientProblemAlert()`, leur CSS associé, et l'appel dans `updateRideLists()`.

**Fichiers concernés** :
- `database/schema.sql` — colonne `client_problem_resolved_at`
- Nouveau : `backend/admin/resolve_client_problem.php`
- `backend/admin/list_problems.php`, `backend/chauffeur/get_rides.php`
- `frontend/chauffeur/js/chauffeur-ui.js` — retrait des fonctions d'alerte
- `frontend/admin/js/admin-ui.js`, `frontend/admin/js/admin-api.js` — nouveau polling global + panneau d'alerte
- `frontend/admin/html/index.html` — éventuel nouvel onglet "Problèmes signalés" si tu veux aussi une vue liste, en plus de l'alerte immédiate

**Portée** : plus large que les précédents — introduit un vrai polling global côté admin, qui n'existe pas encore dans l'architecture actuelle.

---

## 5. Remplacement complet du point de départ modifiable (le plus complexe)

**Dépend du chantier 2** : reprend le principe "lecture seule après commande" et le pousse plus loin en remplaçant totalement le mode d'édition *avant* la commande.

**Objectif** : supprimer le marqueur `draggable` et le remplacer par la même expérience que la destination — recherche en plein écran avec suggestions (`initDestinationOverlay()`, `photon.komoot.io`) — appliquée cette fois au point de départ. Cas d'usage explicite : un client situé loin dans un quartier difficile d'accès veut indiquer comme point de départ un endroit accessible en voiture (bord de route), différent de sa position GPS réelle.

**Ce qui rend ce chantier complexe : trois comportements différents selon la phase de la course.**

| Phase | Comportement attendu | Pourquoi |
|---|---|---|
| Avant "Trouver une course" (position modifiée manuellement) | `pickupCoords` **gelé** sur la position choisie — `watchUserPosition()` ne doit plus l'écraser | Sinon le GPS réécrase le choix de l'utilisateur avant l'envoi, et le chauffeur reçoit la mauvaise position |
| Dès "Trouver une course" cliqué (course créée) | Aucun changement — c'est le chantier 2 qui s'en charge (positions déjà read-only en base et à l'écran) | `arrive_ride.php` calcule déjà sa distance de blocage à 500m à partir de `rides.pickup_lat/pickup_lng`, donc figé automatiquement dès l'`INSERT` — **aucune modification backend nécessaire pour ce point**, le gel côté frontend au moment de l'envoi suffit à garantir la bonne valeur en base |
| Une fois `started` | `pickupCoords` **redevient** vivant, réaligné sur la position GPS réelle du client | Pour permettre, ailleurs dans l'app, un suivi du déplacement du client une fois en course — le geler indéfiniment casserait cette possibilité |

**Point important déjà vérifié dans le code** : le client n'envoie jamais sa propre position au serveur (aucun endpoint `update_position` côté client, contrairement au chauffeur). `pickupCoords` n'est donc utilisé que **localement**, pour l'affichage carte et pour `updateLiveETAFromCurrentPosition()` (ETA chauffeur→point de départ, avant l'arrivée). Cela simplifie beaucoup ce chantier : pas de nouvel endpoint serveur à créer pour la synchronisation de position, tout se joue en JS côté client. Seul `arrive_ride.php` (déjà fait, chantier 3 du plan v2) doit rester alimenté par la bonne valeur — ce qui est garanti dès lors que la valeur envoyée à la création (`backend.php`) est correcte.

**Travail** :
1. **Frontend — généraliser l'overlay de recherche** : soit dupliquer `initDestinationOverlay()` en `initPickupOverlay()` avec ses propres éléments DOM (`pickupOverlay`, `pickupSearchBack`, etc.), soit refactorer en une fonction paramétrée par le champ cible (`field: "pickup" | "destination"`) pour éviter la duplication — recommandé si tu comptes maintenir ce code, mais demande un peu plus de refactoring initial.
2. **État de gel** : introduire un flag explicite, ex. `AppState.pickupLocked = false`. Passe à `true` dès que l'utilisateur choisit une position via l'overlay de recherche pickup. `watchUserPosition()` doit vérifier ce flag avant d'écraser `pickupCoords`.
3. **Déverrouillage à `started`** : dans `onRideStarted()`, remettre `AppState.pickupLocked = false` pour que `watchUserPosition()` recommence à suivre la position réelle du client.
4. **Retrait du drag** : supprimer entièrement la branche `draggable: true` + le handler `dragend` dans `updateMarker("pickup", …)`.
5. **Bouton "Utiliser ma position actuelle"** : à conserver quelque part dans l'overlay pickup (ex. en première entrée des résultats, au-dessus des suggestions), pour ne pas perdre la commodité actuelle de géolocalisation automatique — juste ne plus l'imposer par défaut de façon continue.

**Fichiers concernés** :
- `frontend/client/js/client-ui.js` — `initDestinationOverlay()` (à généraliser ou dupliquer), `updateMarker()`, `watchUserPosition()`, `onRideStarted()`
- `frontend/client/html/index.html` — nouveaux éléments DOM pour l'overlay pickup (si duplication plutôt que refactoring paramétré)
- Aucun changement backend nécessaire (voir ci-dessus)

**Portée** : le plus large des 5 — touche le flux de saisie principal (écran de départ), plusieurs handlers d'état (`onRideStarted`), et doit être testé sur les trois phases (avant commande / pending-à-started / started) pour éviter de régresser le chantier 6 (récupération après rafraîchissement, qui repose aussi sur `pickupCoords`).

---

## Ordre d'exécution recommandé

```
1. Historique en lecture seule         → isolé, corrige un bug actif, gain immédiat
2. Positions read-only après commande  → isolé, prérequis conceptuel léger du chantier 5
3. Fin de course sans chauffeur        → isolé, décisions produit à trancher d'abord
4. Alerte problème client → admin      → introduit le polling global admin (nouvelle brique d'archi)
5. Remplacement du point de départ     → le plus lourd, s'appuie sur le chantier 2
                                          et doit être re-testé contre le chantier 6 (v2)
—
7. Connexion Google (v2, inchangé)     → toujours en dernier
```

---

*Plan v3 généré pour le projet Taxi Urbain — 03/07/2026.*