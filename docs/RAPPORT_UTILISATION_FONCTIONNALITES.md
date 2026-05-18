# Rapport d'utilisation et de fonctionnalites - TaxiGo

## Vue d'ensemble

TaxiGo est une application web de reservation de taxi avec deux espaces principaux :

- un espace client ;
- un espace chauffeur.

Le site permet a un client de demander une course, de suivre l'etat de sa course, de contacter le chauffeur, puis de consulter son historique. Le chauffeur peut recevoir des demandes, accepter ou refuser une course, signaler son arrivee, demarrer et terminer la course.

L'application est mobile-first et repose actuellement sur Leaflet, OpenStreetMap et OSRM pour la carte, la recherche d'itineraire et les estimations de distance/duree.

## Espace client

### Fonctionnalites principales

Le client peut actuellement :

- creer un compte ;
- se connecter ;
- afficher sa position sur la carte ;
- choisir un point de depart ;
- choisir une destination ;
- calculer un itineraire ;
- obtenir une estimation de distance, duree et prix ;
- choisir le nombre de passagers ;
- envoyer une demande de course ;
- suivre le statut de la course ;
- voir les informations du chauffeur ;
- appeler le chauffeur ;
- envoyer un SMS au chauffeur ;
- annuler une course ;
- signaler un probleme ;
- consulter l'historique des courses ;
- consulter son profil avec nom, telephone, email et statut.

### Statuts visibles cote client

Le client suit les etapes suivantes :

```text
En attente d'acceptation
-> Chauffeur en route
-> Chauffeur arrive
-> Course commencee
-> Course terminee
```

Le client peut aussi voir les cas d'annulation :

```text
Course annulee par le client
Course annulee par le chauffeur
```

### Calcul du prix

Le prix est actuellement calcule selon la distance et le nombre de passagers :

```text
prix = distance_km * 75 FCFA * nombre_de_passagers
```

Exemple :

```text
10 km, 2 passagers
prix = 10 * 75 * 2
prix = 1500 FCFA
```

Il n'y a plus de reduction automatique selon le nombre de passagers.

### Calcul du temps

Le temps de trajet est estime par OSRM. OSRM renvoie une duree en secondes, ensuite l'application convertit cette duree en minutes :

```text
duree_minutes = duree_secondes / 60
```

Le temps affiche est donc une estimation routiere, pas une mesure reelle basee sur la vitesse du taxi.

## Espace chauffeur

### Fonctionnalites principales

Le chauffeur peut actuellement :

- creer un compte ;
- se connecter ;
- consulter son profil complet ;
- passer en ligne ou hors ligne ;
- voir les courses disponibles sur la carte ;
- accepter une course ;
- refuser une course ;
- marquer son arrivee ;
- demarrer une course ;
- terminer une course ;
- annuler une course ;
- signaler un probleme ;
- recevoir une alerte plein ecran si un client signale un probleme ;
- consulter un tableau de bord ;
- consulter ses courses terminees ;
- voir ses gains, distances et statistiques.

### Profil chauffeur

Le profil chauffeur affiche :

- nom ;
- telephone ;
- email ;
- plaque ;
- marque du vehicule ;
- couleur du vehicule ;
- statut en ligne/hors ligne.

### Colonnes de courses

L'onglet des courses chauffeur est divise en trois filtres :

```text
Acceptees
Arrivees
En cours
```

Chaque filtre affiche le nombre de courses correspondantes.

Quand le chauffeur appuie sur un bouton d'action :

- apres "Arrive", l'interface bascule vers le filtre "Arrivees" ;
- apres "Commencer", l'interface bascule vers le filtre "En cours".

## Flux principal de course

Le flux actuel est le suivant :

```text
1. Le client cree une course
2. Les chauffeurs en ligne voient la demande
3. Un chauffeur accepte la course
4. Le client voit que le chauffeur arrive
5. Le chauffeur clique sur "Arrive"
6. Le client voit que le chauffeur est arrive
7. Le chauffeur clique sur "Commencer"
8. Le client voit que la course est commencee
9. Le chauffeur termine la course
10. Le client voit que la course est terminee
```

## Gestion de l'itineraire

### Itineraire actuel

L'application utilise actuellement OSRM pour calculer les routes.

Avant la course, l'itineraire principal est :

```text
pickup -> destination
```

Quand le chauffeur est en approche, l'application calcule aussi :

```text
position chauffeur -> pickup
```

Une fois la course commencee, le trajet est encore surtout base sur :

```text
pickup -> destination
```

Une evolution importante serait de passer a :

```text
position actuelle chauffeur -> destination
```

Cela permettrait de recalculer le trajet restant si le chauffeur change de route.

## Signalement de probleme

### Cote client

Le client peut signaler un probleme pendant une course. Le message est enregistre sur la course.

### Cote chauffeur

Quand un client signale un probleme, l'interface chauffeur affiche une alerte plein ecran indiquant que la course est surveillee et que les actions peuvent etre verifiees.

Cette fonctionnalite renforce le sentiment de securite du client et responsabilise le chauffeur.

## Points forts actuels

Le site possede deja une base solide :

- separation claire entre client et chauffeur ;
- authentification ;
- creation de course ;
- suivi des statuts ;
- workflow chauffeur complet ;
- geolocalisation ;
- carte interactive ;
- estimation prix/duree ;
- historique ;
- tableau de bord chauffeur ;
- profil utilisateur ;
- signalement de probleme ;
- interface mobile-first.

## Options d'amelioration innovantes

### 1. Assistant IA client

Ajouter un assistant conversationnel dans l'application.

Exemples :

```text
Trouve-moi un taxi pour rentrer a la maison.
Commande mon trajet habituel.
Estime mon prix pour Bonamoussadi.
Previens mon chauffeur que je descends dans 2 minutes.
```

L'assistant pourrait comprendre les habitudes, les destinations frequentes et les preferences du client.

### 2. Rappels automatiques selon les habitudes

L'application pourrait apprendre les habitudes du client :

- trajet maison -> travail le matin ;
- trajet travail -> maison le soir ;
- trajet ecole ;
- trajet aeroport ;
- trajet regulier du week-end.

Exemple :

```text
Il est 17h20. Voulez-vous commander votre taxi habituel pour rentrer a la maison ?
```

Cette fonctionnalite rendrait l'application proactive.

### 3. Objets perdus

Ajouter une section "Objets perdus".

Fonctionnement possible :

- le client signale un objet oublie ;
- l'application relie le signalement a la derniere course ;
- le chauffeur recoit une notification ;
- le client peut ajouter une description et une photo ;
- le statut peut evoluer :

```text
Signale
En verification
Retrouve
Remis au client
```

### 4. Gestion des trajets embouteilles

Ajouter une couche de gestion du trafic :

- detection des zones embouteillees ;
- affichage des ralentissements ;
- estimation de retard ;
- proposition de detour ;
- notification client en cas de forte augmentation du temps d'arrivee.

Exemple :

```text
Trafic dense detecte sur votre route. Temps estime augmente de 8 minutes.
```

### 5. Carte plus sophistiquee

L'application pourrait evoluer vers des API cartographiques plus avancees :

- Google Maps Platform ;
- Mapbox ;
- HERE Maps ;
- TomTom Traffic.

Avantages possibles :

- meilleure precision des adresses ;
- trafic en temps reel ;
- meilleurs ETA ;
- alternatives d'itineraires ;
- meilleurs points d'interet ;
- cartes plus fluides et professionnelles.

### 6. Score de fiabilite

Creer un score interne pour les clients et les chauffeurs.

Pour les chauffeurs :

- ponctualite ;
- nombre de courses terminees ;
- annulations ;
- signalements ;
- note moyenne.

Pour les clients :

- annulations frequentes ;
- courses terminees ;
- signalements abusifs ;
- ponctualite au point de depart.

Ce score pourrait aider a mieux attribuer les courses.

### 7. Adresses favorites

Ajouter des destinations favorites :

- Maison ;
- Travail ;
- Ecole ;
- Aeroport ;
- Favoris personnels.

Cela accelererait la commande.

### 8. Commande planifiee

Permettre au client de reserver une course :

- dans 30 minutes ;
- demain matin ;
- tous les jours ouvrables ;
- chaque vendredi soir.

Cette fonctionnalite serait utile pour les trajets reguliers.

### 9. Mode securite

Ajouter un mode securite :

- partage du trajet a un proche ;
- bouton d'alerte rapide ;
- affichage clair de la plaque ;
- verification par code avant depart ;
- historique GPS de la course.

### 10. IA de repartition des chauffeurs

Une IA pourrait recommander :

- quel chauffeur doit recevoir quelle course ;
- ou les chauffeurs doivent se positionner ;
- quelles zones auront une forte demande ;
- comment reduire le temps d'attente client.

### 11. Notifications intelligentes

Ajouter des notifications :

- chauffeur accepte ;
- chauffeur proche ;
- chauffeur arrive ;
- course commencee ;
- course terminee ;
- rappel de trajet habituel ;
- hausse de trafic ;
- objet perdu retrouve.

### 12. Programme fidelite

Ajouter une logique de fidelite :

- points par course ;
- trajets gratuits ;
- badges ;
- reductions personnalisees ;
- parrainage client/chauffeur.

## Vision produit

TaxiGo peut evoluer d'une simple application de taxi vers un assistant de mobilite intelligent.

L'objectif serait de proposer une experience :

- rapide ;
- proactive ;
- rassurante ;
- personnalisee ;
- precise ;
- adaptee aux habitudes locales.

Avec l'IA, les rappels intelligents, les objets perdus, la gestion du trafic et une carte plus avancee, TaxiGo pourrait devenir une plateforme de mobilite complete, pas seulement un outil de commande de taxi.
