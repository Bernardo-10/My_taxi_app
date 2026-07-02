Voici les deux modifications, chacune très ciblée.

## 1. `frontend/admin/css/admin.css`

**Avant :**
```css
#map-drivers {
  height: 440px;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--c-border);
}
```

**Après :**
```css
#map-drivers {
  height: 440px;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--c-border);
  /* Leaflet utilise des z-index internes élevés (jusqu'à 1000) pour ses
     panneaux et contrôles. Sans contexte d'empilement propre, ces valeurs
     se comparent directement aux éléments globaux positionnés (sidebar
     mobile, overlay) et peuvent passer au-dessus d'eux. `isolation: isolate`
     confine la carte dans son propre contexte, quel que soit son z-index. */
  position: relative;
  isolation: isolate;
  z-index: 0;
}
```

## 2. `frontend/admin/js/admin-ui.js`

**Avant** (fonction `initSidebarMobile`) :
```js
function initSidebarMobile() {
    const toggle  = document.getElementById("menuToggle");
    const overlay = document.querySelector(".sidebar-overlay");
    const sidebar = document.querySelector(".sidebar");

    toggle?.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        overlay.classList.toggle("open");
    });
    overlay?.addEventListener("click", () => {
        sidebar.classList.remove("open");
        overlay.classList.remove("open");
    });
}
```

**Après :**
```js
function initSidebarMobile() {
    const toggle  = document.getElementById("menuToggle");
    const overlay = document.querySelector(".sidebar-overlay");
    const sidebar = document.querySelector(".sidebar");

    toggle?.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        overlay.classList.toggle("open");
        refreshMapAfterSidebarToggle();
    });
    overlay?.addEventListener("click", () => {
        sidebar.classList.remove("open");
        overlay.classList.remove("open");
        refreshMapAfterSidebarToggle();
    });
}

// Filet de sécurité : si la carte temps réel est visible, force Leaflet à
// recalculer sa taille/son rendu une fois la transition de la sidebar
// terminée, pour éviter tout artefact visuel résiduel après ouverture/
// fermeture du menu burger sur mobile.
function refreshMapAfterSidebarToggle() {
    if (AdminState.currentSection !== "map" || !AdminState.driversMap) return;
    setTimeout(() => AdminState.driversMap.invalidateSize(), 260); // après la transition CSS (.25s)
}
```

Rien d'autre n'a bougé dans ces deux fichiers. Je peux aussi te livrer les fichiers complets en téléchargement si tu préfères les remplacer directement plutôt que d'appliquer les diffs à la main — dis-moi.

Quand tu es prêt, on passe au chantier 2.

Voici le récapitulatif du chantier 2 au format demandé — un seul fichier touché, changements peu nombreux, donc portions de code + numéros de ligne.## Chantier 2 — `frontend/chauffeur/js/chauffeur-ui.js`

### Bloc 1 — lignes 67-111 (déclarations, remplace l'ancien bloc `let reportRideId ... new Set()`)

```js
// Report modal state
let reportRideId        = null;

// Persistance des alertes plein écran déjà vues (problème client, annulation
// client) dans localStorage, pour survivre à un rafraîchissement de page —
// même pattern que "taxigo_recents" côté client. Fenêtre de rétention de 24h,
// alignée sur la fenêtre serveur de get_rides.php pour cancelled_client.
const CLIENT_REPORTS_STORAGE_KEY = "taxigo_shown_client_reports";
const CANCELLATIONS_STORAGE_KEY  = "taxigo_shown_cancellations";
const SHOWN_ALERTS_MAX_AGE_MS    = 24 * 60 * 60 * 1000; // 24h

function loadShownAlerts(storageKey) {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(storageKey) || "{}"); }
    catch (e) { raw = {}; }

    const now = Date.now();
    const map = new Map();
    Object.entries(raw).forEach(([key, ts]) => {
        if (typeof ts === "number" && now - ts < SHOWN_ALERTS_MAX_AGE_MS) map.set(key, ts);
    });

    persistShownAlerts(storageKey, map); // purge les entrées expirées dès le chargement
    return map;
}

function persistShownAlerts(storageKey, map) {
    try {
        const obj = {};
        map.forEach((ts, key) => { obj[key] = ts; });
        localStorage.setItem(storageKey, JSON.stringify(obj));
    } catch (e) {
        // localStorage indisponible/plein : l'alerte reste dédupliquée pour
        // la session en cours, seule la persistance au refresh est perdue
    }
}

function markAlertShown(map, storageKey, key) {
    map.set(key, Date.now());
    persistShownAlerts(storageKey, map);
}

let shownClientReports  = loadShownAlerts(CLIENT_REPORTS_STORAGE_KEY);

// Alerte annulation client (course déjà acceptée/arrivée/démarrée)
let shownCancellations  = loadShownAlerts(CANCELLATIONS_STORAGE_KEY);
```

### Bloc 2 — ligne ~1047, dans `showClientProblemAlerts()`

```js
const key = `${ride.id}:${ride.client_problem_at || problem}`;
if (shownClientReports.has(key)) return;

markAlertShown(shownClientReports, CLIENT_REPORTS_STORAGE_KEY, key);   // ← remplace shownClientReports.add(key)
openClientProblemAlert(ride, problem);
```

### Bloc 3 — lignes ~1111-1114, dans `showClientCancellationAlerts()`

```js
if (ride.status !== "cancelled_client") return;
const key = String(ride.id); // JSON.stringify convertit les clés en chaînes ; on normalise dès l'écriture pour que .has() reste cohérent après un rechargement depuis localStorage
if (shownCancellations.has(key)) return;

markAlertShown(shownCancellations, CANCELLATIONS_STORAGE_KEY, key);    // ← remplace shownCancellations.add(ride.id)
openClientCancellationAlert(ride);
```

Un seul fichier touché, syntaxe validée (`node -c`). Aucun autre changement.

---

On passe au chantier 3 (blocage "arrivé" à 500m) ?

Bien. Je crée d'abord le module partagé Haversine, réutilisable pour l'étape 5 (confirmation "terminer" à 200m).Maintenant `arrive_ride.php` avec le blocage strict à 500m :Maintenant le frontend — envoi de la position GPS fraîche du chauffeur lors du clic "Arrivé" :## Chantier 3 — Blocage "arrivé" à 500m

3 fichiers touchés : 1 nouveau, 2 modifiés (peu de lignes).

### Nouveau fichier — `backend/common/geo.php`

```php
<?php
/**
 * geo.php — Fonctions géographiques partagées.
 * Réutilisé par arrive_ride.php (blocage 500m) et complete_ride.php
 * (confirmation 200m) pour éviter de dupliquer le calcul de distance.
 */

/**
 * Distance en mètres entre deux points GPS (formule de Haversine).
 */
function haversine_distance_meters(float $lat1, float $lng1, float $lat2, float $lng2): float {
    $earthRadius = 6371000; // rayon moyen de la Terre, en mètres

    $dLat = deg2rad($lat2 - $lat1);
    $dLng = deg2rad($lng2 - $lng1);

    $a = sin($dLat / 2) ** 2
       + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;

    $c = 2 * atan2(sqrt($a), sqrt(1 - $a));

    return $earthRadius * $c;
}
?>
```

### Fichier réécrit en entier — `backend/chauffeur/arrive_ride.php`

```php
<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/geo.php";

// Rayon de tolérance autour du point de départ pour valider "arrivé".
// Blocage strict : au-delà, la requête est rejetée, pas de confirmation.
const ARRIVE_MAX_DISTANCE_METERS = 500;

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id  = isset($data["id"])  ? (int) $data["id"]  : 0;
$lat = isset($data["lat"]) && is_numeric($data["lat"]) ? (float) $data["lat"] : null;
$lng = isset($data["lng"]) && is_numeric($data["lng"]) ? (float) $data["lng"] : null;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

if ($lat === null || $lng === null) {
    json_response(["status" => "error", "message" => "Position GPS manquante. Activez la localisation pour confirmer l'arrivee."], 400);
}

$conn = db_connect();

// Point de depart de la course (pickup), pour verifier la proximite.
$stmt = $conn->prepare("SELECT pickup_lat, pickup_lng FROM rides WHERE id = ? AND driver_id = ? AND status = 'accepted'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$ride = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$ride) {
    $conn->close();
    json_response(["status" => "error", "message" => "Impossible de marquer la course comme arrivee"]);
}

// Si le point de depart n'a pas de coordonnees enregistrees (cas rare,
// donnee manquante), on ne peut pas verifier la proximite : on ne bloque
// pas le chauffeur sur une donnee absente cote serveur.
if ($ride["pickup_lat"] !== null && $ride["pickup_lng"] !== null) {
    $distance = haversine_distance_meters(
        (float) $ride["pickup_lat"],
        (float) $ride["pickup_lng"],
        $lat,
        $lng
    );

    if ($distance > ARRIVE_MAX_DISTANCE_METERS) {
        $conn->close();
        json_response([
            "status"   => "error",
            "message"  => "Vous etes a " . round($distance) . " m du point de depart. Rapprochez-vous a moins de " . ARRIVE_MAX_DISTANCE_METERS . " m pour confirmer l'arrivee.",
            "distance" => round($distance)
        ]);
    }
}

$stmt = $conn->prepare("UPDATE rides SET status = 'arrived', arrived_at = NOW() WHERE id = ? AND driver_id = ? AND status = 'accepted'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

json_response([
    "status" => $updated ? "success" : "error",
    "message" => $updated ? "Arrivee chauffeur confirmee" : "Impossible de marquer la course comme arrivee"
]);
?>
```

### `frontend/chauffeur/js/chauffeur-api.js` — ligne 349 (fonction `arriveRide`, remplacée en entier)

```js
async function arriveRide(id, btn) {
    const restore = setButtonLoading(btn, "Arrivee...");
    try {
        let lat, lng;
        try {
            ({ lat, lng } = await getDriverPosition());   // ← nouveau : position GPS fraîche en cache (watchPosition), déjà utilisée pour acceptRide
        } catch (gpsErr) {
            showToast("Impossible d'obtenir votre position GPS. Activez la localisation pour confirmer l'arrivee.", "error");
            return;
        }

        const res    = await fetch(`${DRIVER_API_BASE}/chauffeur/arrive_ride.php`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ id, lat, lng })      // ← lat/lng ajoutés au payload
        });
        const result = await res.json();
        if (result.status === "success") {
            showToast("Arrivee confirmee. Le client est prevenu.", "success");
            await checkNewRides();
            if (typeof setRideFilter === "function") setRideFilter("arrived");
        } else {
            showToast(result.message || "Impossible de confirmer l'arrivee", "error");
        }
    } catch {
        showToast("Erreur de connexion", "error");
    } finally {
        restore();
    }
}
```

### Notes de conception

- **Fraîcheur GPS** : plutôt que d'utiliser la dernière position stockée en base (mise à jour toutes les 10s), on réutilise `getDriverPosition()` — déjà en place pour `acceptRide()` — qui lit le cache alimenté en continu par `watchPosition()` (`maximumAge: 0`). C'est la position la plus fraîche disponible au moment du clic.
- **`start_ride.php` non touché**, conformément au plan (la proximité est déjà garantie par le blocage à l'étape "arrivé").
- **Donnée manquante** : si `pickup_lat`/`pickup_lng` sont absents en base (cas rare), le blocage est ignoré plutôt que de bloquer indûment le chauffeur sur une donnée serveur manquante.
- `haversine_distance_meters()` dans `backend/common/geo.php` est conçue pour être réutilisée telle quelle à l'étape 5 (confirmation "terminer" à 200m).

Syntaxe JS validée (`node -c`) ; PHP non vérifiable ici (CLI absent), mais relu attentivement.

---

On passe au **chantier 4** (confirmations stylisées) ?

Maintenant l'admin :Je crée d'abord le composant de modale partagé, puis je le câble dans les 5 points recensés.Maintenant l'inclusion dans les 3 HTML, puis les 5 câblages.Maintenant les 5 câblages. **1/5 — admin logout :****2/5 — annulation client :****3/5 — déconnexion client (aucune confirmation actuellement) :****4/5 — déconnexion chauffeur (aucune confirmation actuellement) :****5/5 — annulation course chauffeur (aucune confirmation actuellement) :**Vérification finale de la syntaxe de tous les fichiers touchés :Tout est valide. Récapitulatif du chantier 4.

## Chantier 4 — Confirmations stylisées (périmètre élargi)

**1 nouveau fichier** (composant partagé) + **6 fichiers modifiés** (5 câblages + 3 inclusions HTML, quelques-uns combinés) — je vous livre le nouveau fichier en entier et les portions modifiées pour le reste.

### Nouveau — `frontend/js/confirm-modal.js`
Composant auto-suffisant (CSS injecté, aucune dépendance aux styles existants) exposant `window.confirmAction({title, message, confirmLabel, cancelLabel, danger}) → Promise<boolean>`. Un seul modal actif à la fois, fermeture via bouton, clic sur l'overlay, ou touche Échap.### Inclusion HTML (1 ligne ajoutée dans chaque fichier, avant les scripts existants)

**`frontend/client/html/index.html`** (fin de fichier) :
```html
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="/frontend/js/confirm-modal.js" defer></script>
<script src="/frontend/client/js/client-api.js" defer></script>
<script src="/frontend/client/js/client-ui.js" defer></script>
```

**`frontend/chauffeur/html/index.html`** (fin de fichier) :
```html
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" defer></script>
<script src="/frontend/js/confirm-modal.js" defer></script>
<script src="/frontend/chauffeur/js/chauffeur-api.js" defer></script>
<script src="/frontend/chauffeur/js/chauffeur-ui.js" defer></script>
```

**`frontend/admin/html/index.html`** (fin de fichier) :
```html
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="/frontend/js/confirm-modal.js"></script>
<script src="/frontend/admin/js/admin-api.js"></script>
<script src="/frontend/admin/js/admin-ui.js"></script>
```

### Les 5 câblages

**1. `frontend/admin/js/admin-ui.js` — `initLogout()`** (remplace `confirm()` natif) :
```js
function initLogout() {
    document.getElementById("logoutBtn")?.addEventListener("click", async () => {
        const ok = await confirmAction({
            title: "Déconnecter l'administrateur ?",
            confirmLabel: "Déconnecter",
            cancelLabel: "Annuler",
            danger: true
        });
        if (ok) logoutAdmin();
    });
}
```

**2. `frontend/client/js/client-ui.js` — `cancelCurrentRide()`** (remplace `window.confirm()`) :
```js
async function cancelCurrentRide() {
  if (!currentRideId) {
    updateRideStatusMessage("Aucune course à annuler.");
    return;
  }
  const ok = await confirmAction({
    title: "Annuler cette course ?",
    confirmLabel: "Annuler la course",
    cancelLabel: "Retour",
    danger: true
  });
  if (!ok) return;
  // ... suite inchangée
```

**3. `frontend/client/js/client-ui.js` — logout (aucune confirmation avant)** :
```js
  // Logout (carte)
  document.getElementById("logoutBtn")?.addEventListener("click", confirmLogout);
  // Logout (profil)
  document.getElementById("logoutBtnProfile")?.addEventListener("click", confirmLogout);
}

async function confirmLogout() {
  const ok = await confirmAction({
    title: "Se déconnecter ?",
    confirmLabel: "Se déconnecter",
    cancelLabel: "Annuler",
    danger: true
  });
  if (ok) doLogout();
}
```

**4. `frontend/chauffeur/js/chauffeur-api.js` — logout (aucune confirmation avant)** :
```js
    if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
            const ok = await confirmAction({
                title: "Se déconnecter ?",
                confirmLabel: "Se déconnecter",
                cancelLabel: "Annuler",
                danger: true
            });
            if (!ok) return;

            const restore = setButtonLoading(logoutBtn, "Déconnexion…");
            try {
                await fetch(`${DRIVER_API_BASE}/common/logout.php`, { method: "POST" });
            } catch (e) {
                console.warn("Logout request failed:", e);
            } finally {
                window.location.href = loginPage;
            }
        });
    }
```

**5. `frontend/chauffeur/js/chauffeur-api.js` — `cancelRide()`** (aucune confirmation avant) :
```js
async function cancelRide(id, btn) {
    const ok = await confirmAction({
        title: "Annuler cette course ?",
        message: "Le client sera prévenu de l'annulation.",
        confirmLabel: "Annuler la course",
        cancelLabel: "Retour",
        danger: true
    });
    if (!ok) return;

    const restore = setButtonLoading(btn, "Annulation…");
    // ... suite inchangée
```

Les 5 points recensés au plan sont câblés sur ce composant unique. Syntaxe validée sur tous les fichiers JS touchés.

---

On enchaîne sur le **chantier 5** (confirmation "terminer" à 200m — réutilise la modale et le calcul Haversine) ?