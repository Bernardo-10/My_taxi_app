# 📊 LISTE COMPLÈTE DES MISES À JOUR

## 🚕 CÔTÉ CHAUFFEUR (chauffeur.js)

### 1. **Position du chauffeur sur la carte**
- **Élément:** Marqueur 🚕 (driverMarker)
- **Mise à jour:** **EN TEMPS RÉEL** (via `navigator.geolocation.watchPosition`)
- **Source:** GPS du navigateur chauffeur
- **Fréquence:** Continu (dépendt du GPS - généralement 1-5 secondes)
- **Fonction:** `initMap()` ligne 47-68
- **Impact:** La carte suit le chauffeur en permanence

### 2. **Listes des courses (En attente / Acceptées)**
- **Élément:** Conteneurs HTML (#pendingRides, #acceptedRides)
- **Mise à jour:** **Toutes les 5 secondes**
- **Source:** API `get_rides.php`
- **Fréquence:** `setInterval(checkNewRides, 5000)` - ligne 18
- **Fonction:** `checkNewRides()` -> `updateRideLists()`
- **Impact:** Affichage des nouvelles courses en attente, mise à jour des statuts

### 3. **Marqueurs des courses acceptées (pickup et destination)**
- **Élément:** `rideMarkers[]` et `destinationMarkers[]`
- **Mise à jour:** **Toutes les 5 secondes**
- **Source:** Données des courses acceptées
- **Fréquence:** `setInterval(checkNewRides, 5000)` - ligne 18
- **Fonction:** `updateRideMarkers()` ligne 115-292
- **Impact:** Affichage des points de départ et destination des courses acceptées
- **Détails:**
  - 📍 Points de départ en ORANGE (#f39c12)
  - 🎯 Points de destination en ROUGE (#marker-red)

### 4. **Routes chauffeur → clients**
- **Élément:** `driverRouteLayer` (tracé sur la carte)
- **Mise à jour:** **À chaque recalcul de route** (basé sur distance > 100m)
- **Source:** API OSRM (OpenStreetMap Routing)
- **Fréquence:** Recalcul seulement si chauffeur s'est déplacé de plus de 100m
- **Fonction:** `updateRideMarkers()` ligne 247-271
- **Impact:** Affichage de l'itinéraire du chauffeur vers chaque client
- **Couleurs:**
  - Trajet chauffeur → pickup: ORANGE (#f39c12)
  - Trajet pickup → destination: VERT (#27ae60)

### 5. **Position du chauffeur en BD**
- **Élément:** Colonnes `driver_lat`, `driver_lng` en base de données
- **Mise à jour:** **Toutes les 10 secondes**
- **Source:** GPS du chauffeur
- **Fréquence:** `setInterval(updateDriverPosition, 10000)` - ligne 19
- **Fonction:** `updateDriverPosition()` -> `updateDriverPositionInDB()`
- **Impact:** Enregistrement de la position chauffeur en BD pour consultation client
- **Note:** La mise à jour en BD se fait pour CHAQUE course acceptée

### 6. **Dashboard statistiques chauffeur**
- **Élément:** Statistiques affichées (courses terminées, montant, distance)
- **Mise à jour:** **À la demande** (manuelle via bouton ou onglet)
- **Source:** Calcul local des courses complétées
- **Fréquence:** Bouton "Onglet Dashboard" ou automatique après action
- **Fonction:** `updateDashboard()` ligne 438-475
- **Impact:** Affichage des stats du chauffeur (total FCFA, km, nombre de courses)

---

## 👥 CÔTÉ CLIENT (script.js)

### 1. **Position du client sur la carte**
- **Élément:** Marqueur client `pickupMarker`
- **Mise à jour:** **EN TEMPS RÉEL** (via `navigator.geolocation.watchPosition`)
- **Source:** GPS du client
- **Fréquence:** Continu (1-5 secondes selon le GPS)
- **Fonction:** `watchUserPosition()` ligne 113-132
- **Impact:** La carte suit le client en permanent pendant la course
- **Note:** Différent de `getUserLocation()` qui est une géolocalisation unique au démarrage

### 2. **Statut de la course**
- **Élément:** Message de statut (#rideStatusMessage)
- **Mise à jour:** **Toutes les 5 secondes**
- **Source:** API `check_ride_status.php`
- **Fréquence:** `setInterval(checkRideStatus, 5000)` - ligne 435
- **Fonction:** `checkRideStatus()` ligne 443-475
- **Impact:** Affichage du statut: "En attente..." / "✅ Acceptée" / "Terminée" etc.
- **Déclencheur:** Seulement si course existe (`currentRideId`)

### 3. **Position du chauffeur en temps réel**
- **Élément:** Marqueur taxi 🚕 (`driverPositionMarker`)
- **Mise à jour:** **Toutes les 10 secondes**
- **Source:** API `get_driver_location.php` (récupère de la BD)
- **Fréquence:** `setInterval(updateDriverPosition, 10000)` - ligne 441
- **Fonction:** `updateDriverPosition()` ligne 480-548
- **Impact:** 
  - Affichage du marqueur 🚕 à la position du chauffeur
  - Mise à jour du marqueur quand le chauffeur se déplace
  - Affichage du trajet chauffeur → client
- **Déclencheur:** Seulement si course acceptée (`rideAccepted=true`)

### 4. **Itinéraire chauffeur → client (destination)**
- **Élément:** Trajet en trait bleu pointillé (`driverRouteLayer`)
- **Mise à jour:** **À chaque changement de position > 0.00005°** (environ 5 mètres)
- **Source:** API OSRM (calcul itinéraire)
- **Fréquence:** Recalcul si chauffeur a bougé > 5m
- **Fonction:** `updateDriverPosition()` -> `getRouteGeoJSON()` ligne 525-542
- **Impact:** Affichage du chemin que le chauffeur doit prendre
- **Couleur:** Bleu pointillé (#1d4ed8)

### 5. **Positionnement de la carte**
- **Élément:** Vue/zoom de la carte (`map.fitBounds()`)
- **Mise à jour:** **Toutes les 10 secondes**
- **Source:** Positions du chauffeur et du client
- **Fréquence:** À chaque mise à jour de position du chauffeur
- **Fonction:** `centerMapOnRide()` ligne 550-561
- **Impact:** La carte ajuste automatiquement le zoom pour montrer chauffeur + client
- **Note:** Padding de 40px pour une meilleure vue

### 6. **Historique des courses**
- **Élément:** Liste des courses passées
- **Mise à jour:** **À la demande** (clic sur onglet Historique)
- **Source:** API `get_user_rides.php`
- **Fréquence:** Manuelle
- **Fonction:** `loadUserRides()` -> `displayRides()` ligne 600-650
- **Impact:** Affichage de l'historique des courses du client

### 7. **Recherche d'adresse (autocomplete)**
- **Élément:** Suggestions de départ/destination
- **Mise à jour:** **Avec délai de 300ms après la saisie**
- **Source:** API Photon (géocodage)
- **Fréquence:** `setTimeout(300ms)` après chaque frappe clavier
- **Fonction:** `initAutocomplete()` ligne 159-210
- **Impact:** Suggestions d'adresses en temps réel

---

## 📡 TABLEAU RÉCAPITULATIF

| Élément | Côté | Fréquence | Déclencheur | Fonction |
|---------|------|-----------|-------------|----------|
| Position chauffeur (carte) | 🚕 | TEMPS RÉEL | GPS | watchPosition |
| Listes courses | 🚕 | 5 sec | Timer | checkNewRides |
| Marqueurs pickup/dest | 🚕 | 5 sec | Timer | updateRideMarkers |
| Routes chauffeur | 🚕 | Si >100m | GPS change | updateRideMarkers |
| Position en BD | 🚕 | 10 sec | Timer | updateDriverPosition |
| Dashboard stats | 🚕 | Manuel | Clic onglet | updateDashboard |
| --- | --- | --- | --- | --- |
| Position client (carte) | 👥 | TEMPS RÉEL | GPS | watchUserPosition |
| Statut course | 👥 | 5 sec | Timer | checkRideStatus |
| Position chauffeur (en direct) | 👥 | 10 sec | Timer | updateDriverPosition |
| Route chauffeur→client | 👥 | Si >5m | GPS change | getRouteGeoJSON |
| Zoom/centrage carte | 👥 | 10 sec | Timer | centerMapOnRide |
| Historique courses | 👥 | Manuel | Clic | loadUserRides |
| Autocomplete | 👥 | 300ms | Saisie | initAutocomplete |

---

## ⏱️ RÉSUMÉ DES FRÉQUENCES

### **EN TEMPS RÉEL (watchPosition)**
- Position du chauffeur sur sa carte (GPS continu)
- Position du client sur sa carte (GPS continu)

### **5 SECONDES**
- Chauffeur: Vérification nouvelles courses + mise à jour listes
- Client: Vérification statut course

### **10 SECONDES**
- Chauffeur: Mise à jour position en BD
- Client: Mise à jour position chauffeur (récupéré de la BD)

### **À LA DEMANDE (Manuel)**
- Actualisation dashboard chauffeur
- Actualisation historique client
- Calcul itinéraire client

### **EN FONCTION UTILISATEUR**
- Autocomplete: 300ms après saisie
- Recalcul itinéraire: Si déplacement > 5m-100m

---

## 🔄 FLUX COMPLET EN TEMPS RÉEL

```
CHAUFFEUR                          CLIENT
─────────                          ──────
Position GPS (continu)  ─────────> Attente position
    ↓
Mise à jour marqueur
    ↓
5 sec: Vérif courses
    ↓
10 sec: Enregistre position en BD
    ↓                              5 sec: Vérif statut
    ↓                              ↓
    ↓                              Si acceptée:
    ↓                              10 sec: Récupère position chauffeur de BD
    ↓                              ↓
    ↓                              Affiche 🚕 à bonne position
    ↓                              ↓
    ↓                              Calcule itinéraire
    ↓                              ↓
    ↓                              Met à jour carte
```

---

## ⚠️ POINTS CRITIQUES

1. **Délai entre chauffeur et client = 10 secondes**
   - Chauffeur update BD toutes les 10s
   - Client récupère toutes les 10s
   - Total: jusqu'à 20s de retard!

2. **Position GPS dépend du navigateur**
   - watchPosition peut être 1-30 secondes selon le device
   - En intérieur: moins précis

3. **Recalcul itinéraire coûteux**
   - Si chauffeur se déplace < 100m: pas de recalcul
   - Pour optimiser les appels API

4. **Interruption des timers**
   - `clearInterval()` quand course terminée/annulée
   - Évite les appels inutiles

---

## 💡 OPTIMISATIONS POSSIBLES

1. **WebSocket** pour la position en temps réel (au lieu de polling 10s)
2. **Service Worker** pour continuer les mises à jour en arrière-plan
3. **IndexedDB** pour mettre en cache les historiques
4. **Throttling** sur les mises à jour GPS si trop fréquentes

