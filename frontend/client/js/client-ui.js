/* ============================================================
   TAXIGO â€” client-ui.js
   Architecture: AppState + Bottom Sheet + 3 onglets natifs
   client-api.js reste intact (aucune modification)
   ============================================================ */

// â”€â”€ Variables globales attendues par client-api.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let currentDriverPosition = { lat: null, lng: null };  // pour le suivi ETA en temps réel
let map;
let routeLayer        = null;
let pickupMarker      = null;
let destinationMarker = null;
let driverRouteLayer  = null;
let driverPositionMarker = null;
let pickupCoords      = null;
let destinationCoords = null;
let currentRideId     = null;
let rideStatusCheckInterval = null;
let driverStatusInterval    = null;
let rideAccepted      = false;
let lastDriverLat     = null;
let lastDriverLng     = null;
let userRides         = [];
let etaUpdateInterval = null;
// Chantier 3 (v4) — chauffeurs disponibles affichés sur la carte tant que
// rideState === "idle". nearbyDriverMarkers suit le pattern d'AdminState.driverMarkers
// (admin-ui.js) : { id: marker }.
let nearbyDriverMarkers  = {};
let nearbyDriversInterval = null;
// â”€â”€ AppState â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const AppState = {
  activeTab: "map",   // 'map' | 'ride' | 'profile'
  rideState: "idle",  // 'idle' | 'searching' | 'accepted' | 'arrived' | 'started' | 'completed'
  passengers: 1,
  currentUser: null,
  currentDriver: null,
  pickupText: "",
  destinationText: "",
  // Chantier 5 (v3) — true dès que le client a choisi un point de départ
  // manuellement via l'overlay de recherche. watchUserPosition() arrête
  // alors de réécrire pickupCoords avec la position GPS live, pour ne
  // pas écraser le choix explicite. Remis à false par
  // useCurrentPositionAsPickup() et par onRideStarted().
  pickupLocked: false
};

// â”€â”€ DOM refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let $panels      = {};
let $navBtns     = {};
let $rideStates  = {};

// â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener("DOMContentLoaded", async () => {
  cacheDOM();
  syncAppMode();
  initMap();

  // On attend la confirmation de session avant d'activer la réservation et le
  // reste des interactions -- même correctif que côté chauffeur (voir
  // chauffeur-ui.js) : évite qu'un client dont la session a expiré puisse
  // interagir avec l'app avant d'être redirigé vers le login.
  const authenticated = await initUserSession();
  if (!authenticated) return; // redirection déjà lancée par initUserSession()

  initActiveRideRecovery();
  initPassengerCounter();
  initSearchOverlay();
  initNavigation();
  initFindRideBtn();
  initCancelBtns();
  initDriverActions();
  initReportProblem();
  initRefreshBtn();
  initProfileTabs();
  watchUserPosition();
    initSheetDrag();
});
// ── SHEET DRAG ──────────────────────────────
function initSheetDrag() {
    setupDraggableSheet("sheetDragArea", "sheet-map");
    setupDraggableSheet("sheetDragAreaRide", "sheet-ride");
}

function setupDraggableSheet(areaId, sheetId) {
    const area  = document.getElementById(areaId);
    const sheet = document.getElementById(sheetId);
    if (!area || !sheet) return;

    // Clic sur le handle → toggle
    area.addEventListener("click", () => {
        sheet.classList.toggle("collapsed");
    });

    // Swipe tactile
    let startY = 0;
    area.addEventListener("touchstart", e => {
        startY = e.touches[0].clientY;
    }, { passive: true });

    area.addEventListener("touchend", e => {
        const dy = e.changedTouches[0].clientY - startY;
        if (dy > 40)  sheet.classList.add("collapsed");    // glisse vers le bas → réduit
        if (dy < -40) sheet.classList.remove("collapsed"); // glisse vers le haut → ouvre
    }, { passive: true });
}

function cacheDOM() {
  $panels   = {
    map:     document.getElementById("sheet-map"),
    ride:    document.getElementById("sheet-ride"),
    profile: document.getElementById("sheet-profile")
  };
  $navBtns  = {
    map:     document.getElementById("navMap"),
    ride:    document.getElementById("navRide"),
    profile: document.getElementById("navProfile")
  };
  $rideStates = {
    searching: document.getElementById("rideSearching"),
    accepted:  document.getElementById("rideAcceptedMsg")
  };
}

// â”€â”€ NAVIGATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function switchTab(name) {
  if (!$panels[name]) return;
  AppState.activeTab = name;
  syncAppMode();

  Object.entries($panels).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle("active-sheet", key === name);
  });

  Object.entries($navBtns).forEach(([key, btn]) => {
    if (btn) btn.classList.toggle("active", key === name);
  });

  if (name === "map") {
    setTimeout(() => map && map.invalidateSize(), 50);
  }
}

function syncAppMode() {
  const app = document.getElementById("app");
  if (!app) return;

  app.classList.toggle("ride-searching", AppState.rideState === "searching");
  app.classList.toggle("ride-accepted", AppState.rideState === "accepted" || AppState.rideState === "arrived" || AppState.rideState === "started");
  app.classList.toggle("tab-map", AppState.activeTab === "map");
  app.classList.toggle("tab-ride", AppState.activeTab === "ride");
  app.classList.toggle("tab-profile", AppState.activeTab === "profile");

  // Chantier 2 (v3) : verrouillage réel des champs pickup/destination dès
  // qu'une course existe (searching/accepted/arrived/started). Jusqu'ici
  // seul l'attribut HTML `readonly` empêchait la saisie clavier — il ne
  // bloque ni le clic ni le focus, donc l'overlay de recherche s'ouvrait
  // encore et permettait de modifier pickup/destination en pleine course.
  // Ce toggle pilote le CSS (pointer-events: none) ; openSearchOverlay()
  // vérifie aussi AppState.rideState en défense en profondeur.
  app.classList.toggle("route-locked", AppState.rideState !== "idle");

  // Une nouvelle transition de course rouvre toujours le sheet (jamais collapsed par surprise)
  const sheetRide = document.getElementById("sheet-ride");
  if (sheetRide && AppState.rideState !== "idle") {
    sheetRide.classList.remove("collapsed");
  }
}

function initNavigation() {
  Object.entries($navBtns).forEach(([name, btn]) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (btn.disabled) {
        showToast("Lancez d'abord une course");
        return;
      }
      switchTab(name);
    });
  });
}

// â”€â”€ CARTE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([4.0511, 9.7679], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  L.control.zoom({ position: "topright" }).addTo(map);
  getUserLocation();
  startNearbyDriversPolling();
}

// ── CHAUFFEURS DISPONIBLES (chantier 3, v4) ─────────────────────────
// Repris du pattern refreshDriversOnMap() de l'admin (admin-ui.js), avec
// les mêmes principes : un marqueur par id, mise à jour de position si déjà
// existant, suppression des marqueurs des chauffeurs disparus de la réponse.
// Ne tourne que côté carte "idle" : coupé dans showWaitingMessage(), relancé
// dans onRideCancelled() et onRideCompleted() — les 3 points de bascule
// officiels de la machine à états (voir plan v4, chantier 3.2).
function startNearbyDriversPolling() {
  if (nearbyDriversInterval) return; // déjà actif, ne pas dupliquer
  refreshNearbyDrivers();
  nearbyDriversInterval = setInterval(refreshNearbyDrivers, 12000);
}

function stopNearbyDriversPolling() {
  if (nearbyDriversInterval) {
    clearInterval(nearbyDriversInterval);
    nearbyDriversInterval = null;
  }
  Object.keys(nearbyDriverMarkers).forEach(id => {
    map.removeLayer(nearbyDriverMarkers[id]);
    delete nearbyDriverMarkers[id];
  });
}

async function refreshNearbyDrivers() {
  // Garde : si une course a démarré entre le déclenchement de l'intervalle
  // et la réponse réseau, ne pas re-dessiner des marqueurs qu'on vient de nettoyer.
  if (AppState.rideState !== "idle") return;

  const drivers = await fetchNearbyDrivers(); // client-api.js
  if (AppState.rideState !== "idle") return; // re-check après l'await

  const seen = new Set();

  drivers.forEach(driver => {
    seen.add(driver.id);
    const { driver_lat: lat, driver_lng: lng } = driver;

    if (nearbyDriverMarkers[driver.id]) {
      nearbyDriverMarkers[driver.id].setLatLng([lat, lng]);
    } else {
      const icon = L.divIcon({
        html: `<div class="driver-pin">🚕</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        className: ""
      });
      const label = [driver.car_brand, driver.car_color].filter(Boolean).join(" ") || "Chauffeur disponible";
      nearbyDriverMarkers[driver.id] = L.marker([lat, lng], { icon })
        .addTo(map)
        .bindPopup(label);
    }
  });

  // Retirer les marqueurs des chauffeurs qui ne sont plus disponibles
  Object.keys(nearbyDriverMarkers).forEach(id => {
    if (!seen.has(parseInt(id))) {
      map.removeLayer(nearbyDriverMarkers[id]);
      delete nearbyDriverMarkers[id];
    }
  });
}

function getUserLocation() {
  if (!navigator.geolocation) return;

  // Si watchPosition a déjà une position valide, on l'utilise directement
  // (évite le timeout de getCurrentPosition en environnement contraignant)
  if (pickupCoords && pickupCoords.lat) {
    const { lat, lng } = pickupCoords;
    updateMarker("pickup", lat, lng);
    pickupMarker.bindPopup("Votre position").openPopup();
    map.setView([lat, lng], 16);
    reverseGeocode(lat, lng).then(addr => {
      const pickupEl = document.getElementById("pickup");
      if (pickupEl) {
        pickupEl.value = addr || "Position connue";
        AppState.pickupText = pickupEl.value;
      }
    }).catch(() => {});
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      pickupCoords = { lat, lng };
      map.setView([lat, lng], 16);
      updateMarker("pickup", lat, lng);
      pickupMarker.bindPopup(`Vous êtes ici (+/-${Math.round(accuracy)} m)`).openPopup();

      try {
        const addr = await reverseGeocode(lat, lng);
        const pickupEl = document.getElementById("pickup");
        if (pickupEl) {
          pickupEl.value = addr || "Position inconnue";
          AppState.pickupText = pickupEl.value;
        }
      } catch {}
    },
    (err) => {
      console.error("Géolocalisation:", err);
      // Fallback : si watchPosition a une position entre-temps, on l'utilise
      if (pickupCoords && pickupCoords.lat) {
        const { lat, lng } = pickupCoords;
        updateMarker("pickup", lat, lng);
        map.setView([lat, lng], 16);
      }
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 }
  );
}

function watchUserPosition() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      // Chantier 5 (v3) : suivi GPS live autorisé dans deux cas —
      //  - "idle" tant que le client n'a pas verrouillé un point de départ
      //    choisi manuellement via l'overlay de recherche (pickupLocked)
      //  - "started" : repris volontairement une fois la course en cours
      //    (voir onRideStarted), pour permettre ailleurs dans l'app un
      //    suivi du déplacement réel du client.
      // Gelé dans tous les autres cas (searching/accepted/arrived — valeur
      // déjà figée côté serveur depuis la création, chantier 2 v2 — ou
      // idle verrouillé manuellement).
      const allowed = (AppState.rideState === "idle" && !AppState.pickupLocked) ||
                      AppState.rideState === "started";
      if (!allowed) return;

      const { latitude: lat, longitude: lng } = pos.coords;
      pickupCoords = { lat, lng };
      if (pickupMarker) pickupMarker.setLatLng([lat, lng]);
      else updateMarker("pickup", lat, lng);
    },
    (err) => console.error("Watch:", err),
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}

function updateMarker(type, lat, lng) {
  if (type === "pickup") {
    if (pickupMarker) map.removeLayer(pickupMarker);

    const pickupIcon = L.divIcon({
      html: '<div style="font-size:28px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));user-select:none;">📍</div>',
      className: "",
      iconSize:   [28, 28],
      iconAnchor: [14, 28],
      popupAnchor:[0, -30]
    });

    // Chantier 5 (v3) : le marqueur pickup n'est plus draggable. Toute
    // modification du point de départ passe désormais par l'overlay de
    // recherche (initSearchOverlay), comme pour la destination — plus
    // fiable que le drag, en particulier sur mobile.
    pickupMarker = L.marker([lat, lng], { icon: pickupIcon })
      .addTo(map)
      .bindPopup("Point de départ");
  } else {
    if (destinationMarker) map.removeLayer(destinationMarker);
    destinationMarker = L.marker([lat, lng]).addTo(map).bindPopup("Destination");
  }
  map.setView([lat, lng], 14);
}

// â”€â”€ COMPTEUR PASSAGERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initPassengerCounter() {
  const display  = document.getElementById("paxValue");
  const hidden   = document.getElementById("passengers");
  const decrease = document.getElementById("paxMinus");
  const increase = document.getElementById("paxPlus");

  if (!display || !hidden || !decrease || !increase) return;

  function update() {
    display.textContent = AppState.passengers;
    hidden.value = AppState.passengers;
  }
  decrease.addEventListener("click", () => {
    if (AppState.passengers > 1) { AppState.passengers--; update(); }
  });
  increase.addEventListener("click", () => {
    if (AppState.passengers < 4) { AppState.passengers++; update(); }
  });
}

// ── OVERLAY DE RECHERCHE (pickup + destination, partagé) ─────────
// Chantier 5 (v3) : auparavant réservé à la destination. Un seul overlay
// existe dans le DOM (#searchOverlay) — on le réutilise pour le pickup
// plutôt que d'en dupliquer un second, avec `overlayField` qui retient
// quel champ est en cours d'édition au moment de l'ouverture.
let overlayField = "destination"; // "pickup" | "destination"

function initSearchOverlay() {
  const pickupInput   = document.getElementById("pickup");
  const destInput     = document.getElementById("destination");
  const overlay       = document.getElementById("searchOverlay");
  const overlayInput  = document.getElementById("destinationOverlay"); // id historique, désormais partagé
  const closeBtn      = document.getElementById("searchBack");
  const resultsEl     = document.getElementById("overlayResults");
  const recentSection = document.getElementById("recentDestinations");
  const recentEl      = document.getElementById("recentList");
  const labelEl       = recentSection ? recentSection.querySelector(".recent-label") : null;
  let debounceT       = null;

  if (!pickupInput || !destInput || !overlay || !overlayInput || !closeBtn || !resultsEl || !recentEl || !labelEl) return;

  // Ouvrir l'overlay — un listener par champ, routé via overlayField
  pickupInput.addEventListener("focus", () => openSearchOverlay("pickup"));
  pickupInput.addEventListener("click", () => openSearchOverlay("pickup"));
  destInput.addEventListener("focus",   () => openSearchOverlay("destination"));
  destInput.addEventListener("click",   () => openSearchOverlay("destination"));

  function openSearchOverlay(field) {
    // Chantier 2 (v3) : le CSS (.route-locked) bloque déjà le clic via
    // pointer-events: none, mais on vérifie aussi ici — défense en
    // profondeur si jamais cette fonction était appelée autrement qu'au
    // clic (ex. focus programmatique depuis un futur appel de code).
    if (AppState.rideState !== "idle") return;

    overlayField = field;
    const currentInput = field === "pickup" ? pickupInput : destInput;
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => overlay.classList.add("visible"));
    overlayInput.placeholder = field === "pickup" ? "Votre point de départ…" : "Aéroport Nsimalen…";
    overlayInput.value = currentInput.value || "";
    overlayInput.focus();
    resultsEl.innerHTML = "";
    showRecentPlaces();
  }

  function closeSearchOverlay() {
    overlay.classList.remove("visible");
    setTimeout(() => { overlay.classList.add("hidden"); }, 230);
    overlayInput.blur();
  }

  closeBtn.addEventListener("click", closeSearchOverlay);

  // Recherche avec debounce — commune aux deux champs
  overlayInput.addEventListener("input", () => {
    const q = overlayInput.value.trim();
    if (debounceT) clearTimeout(debounceT);

    if (q.length < 2) {
      showRecentPlaces();
      resultsEl.innerHTML = "";
      return;
    }
    labelEl.textContent = "Résultats proches";
    recentEl.innerHTML  = "";

    debounceT = setTimeout(() => fetchOverlayResults(q), 300);
  });

  // Sélection d'un lieu (résultat de recherche ou entrée récente) — route
  // vers pickupCoords/AppState.pickupLocked ou destinationCoords selon
  // overlayField.
  function selectPlace(label, lat, lng) {
    const targetInput = overlayField === "pickup" ? pickupInput : destInput;
    targetInput.value  = label;
    overlayInput.value = label;

    if (overlayField === "pickup") {
      pickupCoords          = { lat, lng };
      AppState.pickupText   = label;
      AppState.pickupLocked = true;
      updateMarker("pickup", lat, lng);
    } else {
      destinationCoords         = { lat, lng };
      AppState.destinationText  = label;
      updateMarker("destination", lat, lng);
    }
    closeSearchOverlay();
  }

  async function fetchOverlayResults(query) {
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lat=4.05&lon=9.76`;
      const res  = await fetch(url);
      const data = await res.json();

      let features = (data.features || []).filter(f => {
        const cc = (f.properties.country_code || "").toLowerCase();
        const c  = (f.properties.country || "").toLowerCase();
        return cc === "cm" || c.includes("cam") || !c;
      });

      resultsEl.innerHTML = "";
      features.forEach(f => {
        const name  = f.properties.name || "";
        const city  = f.properties.city || f.properties.state || f.properties.country || "";
        const dist  = f.properties.distance ? `${(f.properties.distance/1000).toFixed(0)} km` : "";
        const label = city ? `${name}, ${city}` : name;
        const lat   = f.geometry.coordinates[1];
        const lng   = f.geometry.coordinates[0];

        const item = document.createElement("div");
        item.className = "overlay-result-item";
        item.innerHTML = `
          <div class="result-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          </div>
          <div>
            <div class="result-name">${name}</div>
            <div class="result-sub">${city}${dist ? " · " + dist : ""}</div>
          </div>`;

        item.addEventListener("click", () => {
          saveRecentPlace(overlayField, { label, lat, lng });
          selectPlace(label, lat, lng);
        });
        resultsEl.appendChild(item);
      });
    } catch (e) {
      console.error("Overlay search:", e);
    }
  }

  function showRecentPlaces() {
    recentEl.innerHTML = "";

    // Chantier 5 (v3) : pour le pickup uniquement, première entrée fixe
    // pour revenir au suivi GPS automatique — cf. point 5 du plan.
    if (overlayField === "pickup") {
      const gpsItem = document.createElement("div");
      gpsItem.className = "recent-item";
      gpsItem.innerHTML = `
        <div class="recent-icon">📍</div>
        <div>
          <div class="recent-name">Utiliser ma position actuelle</div>
          <div class="recent-sub">Géolocalisation</div>
        </div>`;
      gpsItem.addEventListener("click", () => useCurrentPositionAsPickup(closeSearchOverlay, overlayInput));
      recentEl.appendChild(gpsItem);
    }

    const recents = getRecentPlaces(overlayField);

    if (!recents.length) {
      labelEl.textContent = overlayField === "pickup" ? "Suggestions" : "Tapez une adresse...";
      if (overlayField === "destination") return;
    } else {
      labelEl.textContent = overlayField === "pickup" ? "Suggestions" : "Destinations récentes";
    }

    recents.forEach(r => {
      const item = document.createElement("div");
      item.className = "recent-item";
      item.innerHTML = `
        <div class="recent-icon">↻</div>
        <div>
          <div class="recent-name">${r.label}</div>
          <div class="recent-sub">Récent</div>
        </div>`;
      item.addEventListener("click", () => selectPlace(r.label, r.lat, r.lng));
      recentEl.appendChild(item);
    });
  }
}

// Chantier 5 (v3) : bouton "Utiliser ma position actuelle" dans l'overlay
// pickup. Géolocalisation ponctuelle fraîche (pas la valeur mise en cache
// par watchUserPosition), déverrouille pickupLocked pour que le suivi GPS
// automatique reprenne la main ensuite.
async function useCurrentPositionAsPickup(closeSearchOverlay, overlayInput) {
  if (!navigator.geolocation) return;
  if (overlayInput) overlayInput.value = "Localisation…";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      AppState.pickupLocked = false;
      pickupCoords = { lat, lng };
      updateMarker("pickup", lat, lng);

      try {
        const addr = await reverseGeocode(lat, lng);
        const pickupEl = document.getElementById("pickup");
        if (pickupEl) {
          pickupEl.value = addr || "Position actuelle";
          AppState.pickupText = pickupEl.value;
        }
      } catch {}

      closeSearchOverlay();
    },
    () => {
      showToast("Impossible de récupérer votre position");
      closeSearchOverlay();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// Historique des lieux récents — clé de stockage séparée par champ pour
// ne pas mélanger les repères de départ avec les destinations habituelles.
// "taxigo_recents" est conservé tel quel pour la destination (compatibilité
// avec l'historique déjà enregistré chez les clients existants).
function saveRecentPlace(field, place) {
  const key = field === "pickup" ? "taxigo_recents_pickup" : "taxigo_recents";
  try {
    let recents = JSON.parse(localStorage.getItem(key) || "[]");
    recents = recents.filter(r => r.label !== place.label);
    recents.unshift(place);
    recents = recents.slice(0, 3);
    localStorage.setItem(key, JSON.stringify(recents));
  } catch {}
}
function getRecentPlaces(field) {
  const key = field === "pickup" ? "taxigo_recents_pickup" : "taxigo_recents";
  try { return JSON.parse(localStorage.getItem(key) || "[]"); }
  catch { return []; }
}

// ── TROUVER UNE COURSE ─────────────────────────────────────────
function initFindRideBtn() {
  document.getElementById("findRideBtn").addEventListener("click", async () => {
    AppState.pickupText      = document.getElementById("pickup").value.trim();
    AppState.destinationText = document.getElementById("destination").value.trim();

    // Afficher les dÃ©tails dans le panel ride avant de switch
    document.getElementById("summaryPickup").textContent      = AppState.pickupText || "-";
    document.getElementById("summaryDest").textContent = AppState.destinationText || "-";

    await findRoute(); // fonction de client-api.js
  });
}

// â”€â”€ SUIVI DE COURSE (hooks sur client-api) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// showWaitingMessage est appelÃ© par sendToBackend de client-api.js
function showWaitingMessage() {
  AppState.rideState = "searching";

  // Verrouiller le marqueur pickup dès que la course est envoyée (pending) :
  // un drag ne serait ni sauvegardé côté serveur, ni reflété dans le tracé
  // chauffeur (qui se base sur pickupCoords côté client-api.js), donc laisser
  // le marqueur déplaçable après soumission induirait le client en erreur.
  // Se déclenche aussi bien à la soumission normale qu'à la reprise après
  // rafraîchissement, puisque showWaitingMessage() est le point de passage
  // commun aux deux flux.
  if (pickupMarker && pickupMarker.dragging) {
    pickupMarker.dragging.disable();
    pickupMarker.bindPopup("Point de départ");
  }

  // Chantier 3 (v4) : plus de sens d'afficher les chauffeurs "disponibles"
  // une fois qu'une recherche est lancée.
  stopNearbyDriversPolling();

  // S'assurer que le résumé est rempli avant d'afficher
  const pickupEl = document.getElementById("pickup");
  const destEl   = document.getElementById("destination");
  document.getElementById("summaryPickup").textContent = pickupEl?.value || AppState.pickupText || "-";
  document.getElementById("summaryDest").textContent   = destEl?.value   || AppState.destinationText || "-";

  setRideState("searching");
  syncAppMode();

  // Activer l'onglet Course et basculer automatiquement
  $navBtns.ride.disabled = false;
  switchTab("ride");
}

// ---- RECUPERATION DE COURSE APRES RAFRAICHISSEMENT ----------------
// Interroge get_active_ride.php au chargement de la page : si une course est
// toujours en cours côté serveur (pending / accepted / arrived / started),
// on reconstruit l'état visuel exactement comme si la mise à jour venait
// d'arriver par polling normal, puis on relance le suivi habituel.
async function initActiveRideRecovery() {
  const active = await fetchActiveRide(); // client-api.js
  if (!active) return; // pas de course en cours : rien à faire

  const status = active.ride_status;

  // Fixé avant tout placement de marqueur : une course reprise après
  // rafraîchissement n'est par définition jamais "idle" — nécessaire pour
  // que watchUserPosition()/updateMarker("pickup", …) traitent bien le
  // point de départ comme figé dès la reprise (chantiers 2 et 5, v2/v3).
  AppState.rideState = "searching";

  // Repositionner pickup / destination (texte + coordonnées + marqueurs)
  AppState.pickupText      = active.pickup      || "";
  AppState.destinationText = active.destination || "";
  const pickupEl = document.getElementById("pickup");
  const destEl   = document.getElementById("destination");
  if (pickupEl) pickupEl.value = AppState.pickupText;
  if (destEl)   destEl.value   = AppState.destinationText;

  if (active.pickup_lat && active.pickup_lng) {
    pickupCoords = { lat: parseFloat(active.pickup_lat), lng: parseFloat(active.pickup_lng) };
    updateMarker("pickup", pickupCoords.lat, pickupCoords.lng);
  }

  // Le marqueur destination ne doit être visible que pendant "pending" et
  // "started" — masqué pendant "accepted"/"arrived" (onRideAccepted le retire,
  // onRideStarted le remet), comportement voulu à respecter dès la reprise.
  // destinationCoords, lui, est toujours renseigné : nécessaire pour le calcul
  // Haversine et pour qu'onRideStarted puisse recréer le marqueur plus tard.
  if (active.destination_lat && active.destination_lng) {
    destinationCoords = { lat: parseFloat(active.destination_lat), lng: parseFloat(active.destination_lng) };
    if (status === "pending" || status === "started") {
      updateMarker("destination", destinationCoords.lat, destinationCoords.lng);
    }
  }

  if (pickupCoords && destinationCoords && (status === "pending" || status === "started")) {
    map.fitBounds(L.latLngBounds(
      [pickupCoords.lat, pickupCoords.lng],
      [destinationCoords.lat, destinationCoords.lng]
    ), { padding: [40, 40] });
  }

  // Repeupler distance / durée / prix : en écrivant dans #routeDistance en
  // dernier, on redéclenche le fareObserver existant (voir observeFareUpdate
  // plus bas) qui se charge lui-même de remplir summaryDist/Dur/Price, le
  // pill et d'afficher le fareStrip — évite de dupliquer cette logique ici.
  // Sans ça, ces informations restaient vides après un rafraîchissement,
  // aussi bien dans le panneau "recherche en cours" que dans le fare strip
  // de l'onglet carte.
  if (active.distance_km != null && active.duration_min != null && active.price_fcfa != null) {
    const distanceKm  = parseFloat(active.distance_km);
    const durationMin = parseInt(active.duration_min, 10);
    const priceFcfa   = parseInt(active.price_fcfa, 10);
    const passengers  = active.passengers || 1;

    const routeDuration = document.getElementById("routeDuration");
    const routePrice    = document.getElementById("routePrice");
    const routeDistance = document.getElementById("routeDistance");
    if (routeDuration) routeDuration.textContent = `${durationMin} min`;
    if (routePrice)    routePrice.textContent    = `${priceFcfa} FCFA (${passengers} passagers)`;
    if (routeDistance) routeDistance.textContent = `${distanceKm.toFixed(2)} km`;
  }

  // Reprendre l'identifiant de course : à partir de là, checkRideStatus()
  // (client-api.js) retrouve le vrai statut serveur et déclenche lui-même
  // onRideAccepted / onRideArrived / onRideStarted selon le cas.
  currentRideId = active.ride_id;
  $navBtns.ride.disabled = false;
  showWaitingMessage();   // état de base "recherche", écrasé aussitôt si le statut réel est plus avancé
  startRideTracking();    // client-api.js : appelle checkRideStatus() immédiatement + relance le polling
}

function setRideState(state) {
  Object.entries($rideStates).forEach(([key, el]) => {
    if (el) el.classList.toggle("hidden", key !== state);
  });
}

// updateRideStatusMessage est appelÃ© par client-api.js pour les mises Ã  jour
function updateRideStatusMessage(msg) {
  const el = document.getElementById("rideStatusMessage");
  if (el) el.textContent = msg;
  // Les transitions d'état (completed, cancelled) sont gérées exclusivement
  // par checkRideStatus dans client-api.js — plus de déclenchement ici
}

// Accepte soit un objet { name, plate, car, rating } (depuis client-api.js)
// soit une chaîne texte (fallback legacy)


function setDriverInfo({ name, color, plate, rating }) {
  document.getElementById("rideDriverName").textContent   = name    || "-";
  document.getElementById("rideDriverCar").textContent    = color ? `Couleur ${color}` : "-";
  document.getElementById("rideDriverPlate").textContent  = plate   || "-";
  document.getElementById("rideDriverRating").textContent = rating  || "-";

  const initial = (name || "C").charAt(0).toUpperCase();
  document.getElementById("rideDriverInitial").textContent = initial;
}

function initDriverActions() {
  document.getElementById("driverCallBtn")?.addEventListener("click", () => {
    const phone = normalizePhone(AppState.currentDriver?.phone);
    if (phone) {
      window.location.href = `tel:${phone}`;
      return;
    }
    showToast("Numéro chauffeur indisponible.");
  });

  document.getElementById("driverMsgBtn")?.addEventListener("click", () => {
    const phone = normalizePhone(AppState.currentDriver?.phone);
    if (phone) {
      window.location.href = `sms:${phone}`;
      return;
    }
    showToast("Messagerie chauffeur indisponible.");
  });
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateDriverETA(distanceMeters, durationSeconds) {
  const distanceEl = document.getElementById("driverDistanceToPickup");
  const etaEl = document.getElementById("driverETA");
  if (!distanceEl || !etaEl) return;

  if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
    distanceEl.textContent = "-";
    etaEl.textContent = "-";
    return;
  }

  const km = distanceMeters / 1000;
  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  distanceEl.textContent = km < 1 ? `${Math.round(distanceMeters)} m` : `${km.toFixed(1)} km`;
  etaEl.textContent = `${minutes} min`;
}

function onRideCancelled() {
  AppState.rideState = "idle";
  currentRideId = null;
  rideAccepted = false;
  AppState.currentDriver = null;
  if (rideStatusCheckInterval) clearInterval(rideStatusCheckInterval);
  if (driverStatusInterval) clearInterval(driverStatusInterval);
  if (etaUpdateInterval) clearInterval(etaUpdateInterval);
  $navBtns.ride.disabled = true;
  syncAppMode();
  switchTab("map");
  resetMapPanel();
  startNearbyDriversPolling(); // chantier 3 (v4)
}

function resetMapPanel() {
  // Déconnecter l'observer AVANT de toucher au DOM pour éviter qu'il
  // se retrigger sur la mise à "-" et réaffiche l'ancien fare strip
  if (fareObserver) fareObserver.disconnect();

  // Cacher et vider le fare strip + pill
  const fareStrip = document.getElementById("fareStrip");
  if (fareStrip) fareStrip.style.display = "none";
  document.getElementById("routePill")?.classList.add("hidden");
  const pillDist = document.getElementById("pillDistance");
  const pillDur  = document.getElementById("pillDuration");
  if (pillDist) pillDist.textContent = "-";
  if (pillDur)  pillDur.textContent  = "-";

  // Vider le résumé du panel Course
  const summaryDist  = document.getElementById("summaryDist");
  const summaryDur   = document.getElementById("summaryDur");
  const summaryPrice = document.getElementById("summaryPrice");
  if (summaryDist)  summaryDist.textContent  = "-";
  if (summaryDur)   summaryDur.textContent   = "-";
  if (summaryPrice) summaryPrice.textContent = "-";

  // try/catch par calque : si un calque a déjà été détaché (appel async en vol),
  // l'exception n'empêche pas les suppressions suivantes
  const layers = [
    () => { if (routeLayer)           { map.removeLayer(routeLayer);           routeLayer = null; } },
    () => { if (driverRouteLayer)     { map.removeLayer(driverRouteLayer);     driverRouteLayer = null; } },
    () => { if (driverPositionMarker) { map.removeLayer(driverPositionMarker); driverPositionMarker = null; } },
    () => { if (destinationMarker)    { map.removeLayer(destinationMarker);    destinationMarker = null; } },
    () => { if (pickupMarker)         { map.removeLayer(pickupMarker);         pickupMarker = null; } },
  ];
  layers.forEach(fn => { try { fn(); } catch(e) { console.warn("removeLayer:", e); } });

  destinationCoords = null;
  lastDriverLat     = null;
  lastDriverLng     = null;

  const destEl = document.getElementById("destination");
  if (destEl) destEl.value = "";
  const routePrice = document.getElementById("routePrice");
  if (routePrice) routePrice.textContent = "-";
  const routeDuration = document.getElementById("routeDuration");
  if (routeDuration) routeDuration.textContent = "-";
  const routeDistance = document.getElementById("routeDistance");
  if (routeDistance) routeDistance.textContent = "-";

  // Reconnecter l'observer APRÈS le reset DOM complet
  if (fareObserver) {
    const el = document.getElementById("routeDistance");
    if (el) fareObserver.observe(el, { childList: true, characterData: true, subtree: true });
  }

  getUserLocation();
}

// Hook pour afficher le chip et fare-row aprÃ¨s calcul d'itinÃ©raire
// findRoute() de client-api.js met Ã  jour directement les spans
// On surcharge la fin de findRoute via un MutationObserver sur #routeDistance
let fareObserver = null;
(function observeFareUpdate() {
  fareObserver = new MutationObserver(() => {
    const dist = document.getElementById("routeDistance")?.textContent;
    const dur  = document.getElementById("routeDuration")?.textContent;
    const price = document.getElementById("routePrice")?.textContent;

    if (dist && dist !== "-") {
      document.getElementById("summaryDist").textContent  = dist;
      document.getElementById("summaryDur").textContent   = dur   || "-";
      document.getElementById("summaryPrice").textContent = price || "-";

      const chip = document.getElementById("routePill");
      if (chip) chip.classList.remove("hidden");
      const pillDist = document.getElementById("pillDistance");
      const pillDur  = document.getElementById("pillDuration");
      if (pillDist) pillDist.textContent = dist;
      if (pillDur)  pillDur.textContent  = dur  || "-";
      const fareStrip = document.getElementById("fareStrip");
      if (fareStrip) fareStrip.style.display = "flex";
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("routeDistance");
    if (el) fareObserver.observe(el, { childList: true, characterData: true, subtree: true });
  });
})();

// â”€â”€ ANNULATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initCancelBtns() {
  // Bouton dans l'Ã©tat "searching"
  const cancelSearch = document.getElementById("cancelRideBtn");
  if (cancelSearch) {
    cancelSearch.addEventListener("click", () => cancelCurrentRide());
  }
  // Bouton dans l'Ã©tat "accepted"
  const cancelAccepted = document.getElementById("cancelRideBtnDriver");
  if (cancelAccepted) {
    cancelAccepted.addEventListener("click", () => cancelCurrentRide());
  }
}

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

  try {
    const response = await fetch(`${CLIENT_API_BASE}/client/cancel_ride.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ride_id: currentRideId })
    });
    const result = await response.json();

    if (result.status === "success") {
      currentRideId = null;
      rideAccepted  = false;
      if (rideStatusCheckInterval) clearInterval(rideStatusCheckInterval);
      if (driverStatusInterval)    clearInterval(driverStatusInterval);

      onRideCancelled();
      showToast("Course annulée");
      await loadUserRides(); // rafraÃ®chir historique
    } else {
      showToast(result.message || "Annulation impossible.");
    }
  } catch (e) {
    console.error("Annulation:", e);
    showToast("Erreur lors de l'annulation.");
  }
}

// â”€â”€ RAFRAÃŽCHIR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initRefreshBtn() {
  const btn = document.getElementById("refreshMapBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (currentRideId) checkRideStatus(true);
    else showToast("Aucune course active.");
  });
}

// â”€â”€ SESSION UTILISATEUR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function initUserSession() {
  let authenticated = true; // optimiste par défaut si le réseau échoue (voir catch)
  try {
    // cache: "no-store" : même raison que côté chauffeur (voir chauffeur-api.js) --
    // on force un vrai aller-retour réseau pour la vérification de session, jamais
    // une réponse mise en cache par le navigateur ou un proxy intermédiaire.
    const res = await fetch(`${CLIENT_API_BASE}/common/current_user.php`, { cache: "no-store" });

    // Vérifié AVANT de parser le corps : sur un 401, on ne dépend pas de la forme
    // de la réponse pour déclencher la redirection.
    if (res.status === 401) {
      authenticated = false;
      window.location.href = "/client/login";
      return authenticated;
    }

    const result = await res.json();

    if (result.status === "success") {
      const name = result.user?.name || "Utilisateur";
      AppState.currentUser = result.user;

      // Nom dans le panel carte
      const nameEl = document.getElementById("currentUserName");
      if (nameEl) nameEl.textContent = name;

      // Avatar initiale
      const initial = name.charAt(0).toUpperCase();
      ["userInitial", "profileInitial"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = initial;
      });

      // Panel profil
      const profileName = document.getElementById("profileName");
      const infoName    = document.getElementById("infoName");
      if (profileName) profileName.textContent = name;
      if (infoName)    infoName.textContent    = name;
      setText("profileInfoName", name);
      setText("profileInfoPhone", result.user?.phone || "-");
      setText("profileInfoEmail", result.user?.email || "-");
      setText("profileInfoStatus", result.user?.status === "active" ? "Actif" : (result.user?.status || "-"));
    }
  } catch (e) {
    // Échec réseau réel (hors ligne) : on reste optimiste, comme côté chauffeur --
    // ne pas bloquer toute l'app pour une coupure réseau temporaire.
    console.error("Session:", e);
  }

  // Logout (carte)
  document.getElementById("logoutBtn")?.addEventListener("click", confirmLogout);
  // Logout (profil)
  document.getElementById("logoutBtnProfile")?.addEventListener("click", confirmLogout);

  return authenticated;
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

async function doLogout() {
  try {
    await fetch(`${CLIENT_API_BASE}/common/logout.php`, { method: "POST" });
  } finally {
    window.location.href = "/client/login";
  }
}

// â”€â”€ ONGLETS PROFIL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initProfileTabs() {
  document.getElementById("historyBtn")?.addEventListener("click", async () => {
    const panel = document.getElementById("historyPanel");
    panel?.classList.remove("hidden");
    requestAnimationFrame(() => panel?.classList.add("visible"));
    await loadUserRides();
  });

  document.getElementById("backToMapBtn")?.addEventListener("click", () => {
    const panel = document.getElementById("historyPanel");
    panel?.classList.remove("visible");
    setTimeout(() => panel?.classList.add("hidden"), 300);
  });

  const tabs   = document.querySelectorAll(".profile-tab");
  const panels = document.querySelectorAll(".profile-panel");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t   => t.classList.remove("active"));
      panels.forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const target = document.getElementById(`ptab${capitalize(tab.dataset.ptab)}`);
      if (target) target.classList.add("active");

      if (tab.dataset.ptab === "history") loadUserRides();
    });
  });
}

// â”€â”€ HISTORIQUE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function displayRides() {
  const container = document.getElementById("ridesContainer");
  if (!container) return;

  const history = userRides.filter(r =>
    ["completed", "cancelled", "cancelled_client"].includes(r.status)
  );

  if (history.length === 0) {
    container.innerHTML = "<p style='color:#94a3b8;font-size:13px;padding:8px 0;'>Aucune course terminée.</p>";
    return;
  }

  const labelMap = { completed: "Terminée", cancelled_client: "Annulée (client)", cancelled: "Annulée (chauffeur)" };

  container.innerHTML = history.map(ride => `
    <div class="ride-item" onclick="viewRideOnMap(${ride.id})">
      <div class="details">
        <strong>${ride.pickup} -> ${ride.destination}</strong>
        <div>${ride.distance_km} km · ${ride.price_fcfa} FCFA · ${ride.passengers} passager(s)</div>
        <div>${new Date(ride.created_at).toLocaleString("fr-FR")}</div>
      </div>
      <span class="status ${ride.status}">${labelMap[ride.status] || ride.status}</span>
    </div>
  `).join("");
}

// Historique : consultation en lecture seule uniquement.
//
// L'ancienne implémentation (displayRideOnMap) réutilisait la carte et les
// variables globales de la course active (pickupCoords, destinationCoords,
// pickupMarker, destinationMarker, driverPositionMarker, driverRouteLayer)
// pour "rejouer" une course de l'historique — un pis-aller antérieur au
// mécanisme de reprise de course (get_active_ride.php / initActiveRideRecovery,
// voir plus haut) qui gère aujourd'hui correctement la restauration d'une
// course active après rafraîchissement. Regarder l'historique pendant qu'une
// course est en cours effaçait alors le marqueur/tracé du chauffeur en
// circulation et remplaçait pickupCoords/destinationCoords par ceux de la
// course consultée — un client ne pouvant de toute façon avoir qu'une seule
// course active à la fois, ce recyclage n'apportait rien et ne faisait que
// risquer de corrompre l'affichage d'une course réelle en cours.
// L'historique se contente désormais d'afficher les informations dans une
// fenêtre dédiée, sans toucher à `map` ni à aucune variable partagée.
function viewRideOnMap(rideId) {
  const ride = userRides.find(r => r.id == rideId);
  if (!ride) return;
  showRideDetailModal(ride);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

const RIDE_DETAIL_STYLE_ID = "tg-ride-detail-styles";
function injectRideDetailStyles() {
  if (document.getElementById(RIDE_DETAIL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = RIDE_DETAIL_STYLE_ID;
  style.textContent = `
.tg-ride-detail-overlay {
  position: fixed; inset: 0;
  background: rgba(15, 23, 42, .55);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  z-index: 100000;
}
.tg-ride-detail-box {
  background: #fff;
  border-radius: 16px;
  padding: 20px;
  width: 100%;
  max-width: 360px;
  box-shadow: 0 12px 40px rgba(0,0,0,.25);
}
.tg-ride-detail-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 14px;
}
.tg-ride-detail-close {
  border: none; background: transparent; font-size: 22px; line-height: 1;
  cursor: pointer; color: #64748b; padding: 4px 8px;
}
.tg-ride-detail-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid #f1f5f9;
  font-size: 14px;
}
.tg-ride-detail-row:last-child { border-bottom: none; }
.tg-ride-detail-row span { color: #64748b; }
.tg-ride-detail-row strong { color: #0f172a; text-align: right; }
`;
  document.head.appendChild(style);
}

function showRideDetailModal(ride) {
  injectRideDetailStyles();

  const existing = document.getElementById("tg-ride-detail-overlay");
  if (existing) existing.remove();

  const labelMap = { completed: "Terminée", cancelled_client: "Annulée (client)", cancelled: "Annulée (chauffeur)" };

  const overlay = document.createElement("div");
  overlay.id = "tg-ride-detail-overlay";
  overlay.className = "tg-ride-detail-overlay";

  overlay.innerHTML = `
    <div class="tg-ride-detail-box">
      <div class="tg-ride-detail-header">
        <span class="status ${ride.status}">${labelMap[ride.status] || ride.status}</span>
        <button type="button" class="tg-ride-detail-close" aria-label="Fermer">&times;</button>
      </div>
      <div class="tg-ride-detail-row"><span>Départ</span><strong>${escapeHtml(ride.pickup)}</strong></div>
      <div class="tg-ride-detail-row"><span>Arrivée</span><strong>${escapeHtml(ride.destination)}</strong></div>
      <div class="tg-ride-detail-row"><span>Distance</span><strong>${ride.distance_km} km</strong></div>
      <div class="tg-ride-detail-row"><span>Prix</span><strong>${ride.price_fcfa} FCFA</strong></div>
      <div class="tg-ride-detail-row"><span>Passagers</span><strong>${ride.passengers}</strong></div>
      <div class="tg-ride-detail-row"><span>Date</span><strong>${new Date(ride.created_at).toLocaleString("fr-FR")}</strong></div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector(".tg-ride-detail-close").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// â”€â”€ TOAST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showToast(msg, duration = 2500) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("hidden");
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, duration);
}


// Appelée lorsque le statut "started" est détecté
function onRideStarted(rideData) {
    if (AppState.rideState === "started") return;
    AppState.rideState = "started";
    // Chantier 5 (v3) : le point de départ redevient vivant — watchUserPosition()
    // recommence à suivre la position GPS réelle du client une fois en course.
    AppState.pickupLocked = false;
    syncAppMode();
    removeArrivedNotice();

    // En flux normal ce panneau est déjà visible depuis onRideAccepted/
    // onRideArrived, donc cet appel est un no-op. Mais à la reprise après
    // rafraîchissement quand on atterrit directement sur "started" (sans
    // passer par accepted/arrived dans cette session), rien d'autre ne
    // basculait le panneau visible : "recherche en cours" restait affiché
    // avec juste son texte modifié en coulisses.
    setRideState("accepted");

    // Idem : onRideAccepted/onRideArrived remplissent normalement le nom,
    // la couleur, la plaque et la note du chauffeur — un no-op en flux
    // normal, mais nécessaire ici pour la reprise directe sur "started".
    const driver = rideData?.driver || {};
    setDriverInfo(driver);
    AppState.currentDriver = driver;

    // Modifier l'UI du panneau Course
    const rideTitle = document.querySelector("#rideAcceptedMsg .ride-state-title");
    if (rideTitle) rideTitle.textContent = "Course en cours 🚗";
    const rideSub = document.getElementById("rideStatusMessage");
    if (rideSub) rideSub.textContent = "Course en cours";

    // Désactiver l'affichage du temps d'arrivée et distance du départ
    const etaElements = document.querySelectorAll(".driver-eta");
    etaElements.forEach(el => {
        el.style.display = "none";
    });

    // Cacher les boutons d'appel / message / annuler
    const callBtn = document.getElementById("driverCallBtn");
    const msgBtn = document.getElementById("driverMsgBtn");
    const cancelBtn = document.getElementById("cancelRideBtnDriver");
    if (callBtn) callBtn.style.display = "none";
    if (msgBtn) msgBtn.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "none";

    // Afficher le bouton "Signaler un problème"
    const reportBtn = document.getElementById("reportProblemBtn");
    if (reportBtn) reportBtn.style.display = "inline-flex";

    // Masquer le bloc ETA chauffeur pendant le trajet
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "none";

    // Fix 1 : remettre le marqueur destination maintenant que la course commence
    if (destinationCoords) {
        if (destinationMarker) {
            // Si l'objet existe encore (juste caché), le remettre sur la carte
            try { destinationMarker.addTo(map); } catch(e) {
                // Si l'objet ne peut plus être réutilisé, en créer un nouveau
                const destIcon = L.divIcon({
                    html: '<div style="font-size:26px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));user-select:none;">🏁</div>',
                    className: "",
                    iconSize: [26, 26],
                    iconAnchor: [13, 26],
                    popupAnchor: [0, -28]
                });
                destinationMarker = L.marker([destinationCoords.lat, destinationCoords.lng], { icon: destIcon })
                    .addTo(map).bindPopup("Destination");
            }
        } else {
            const destIcon = L.divIcon({
                html: '<div style="font-size:26px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));user-select:none;">🏁</div>',
                className: "",
                iconSize: [26, 26],
                iconAnchor: [13, 26],
                popupAnchor: [0, -28]
            });
            destinationMarker = L.marker([destinationCoords.lat, destinationCoords.lng], { icon: destIcon })
                .addTo(map).bindPopup("Destination");
        }
    }

    // Une fois la course démarrée, le client est dans le taxi — supprimer le marqueur chauffeur
    if (typeof driverPositionMarker !== "undefined" && driverPositionMarker) {
        map.removeLayer(driverPositionMarker);
        driverPositionMarker = null;
    }

    // Effacer l'ancien tracé (pointillés arrived) et forcer immédiatement le tracé vert
    if (typeof driverRouteLayer !== "undefined" && driverRouteLayer) {
        map.removeLayer(driverRouteLayer);
        driverRouteLayer = null;
    }
    // Réinitialiser lastDriverLat pour forcer posChanged = true au prochain appel
    lastDriverLat = null;
    lastDriverLng = null;

    if (typeof updateDriverPosition === "function") {
        setTimeout(updateDriverPosition, 300);
    }

    // Démarrer le suivi temps réel du trajet
    startRideProgressTracking();
}

function onRideArrived(rideData) {
    if (AppState.rideState === "arrived") return;
    AppState.rideState = "arrived";
    syncAppMode();

    const driver = rideData?.driver || {};
    const info = {
        name:    driver.name   || "Votre chauffeur",
        color:   driver.color  || "",
        plate:   driver.plate  || "-",
        rating:  driver.rating || "4.8",
        phone:   driver.phone  || ""
    };

    setDriverInfo(info);
    AppState.currentDriver = info;
    setRideState("accepted");

    const rideTitle = document.querySelector("#rideAcceptedMsg .ride-state-title");
    if (rideTitle) rideTitle.textContent = "Le chauffeur est arrivé";

    updateRideStatusMessage("Votre chauffeur vous attend au point de départ.");
    showArrivedNotice();

    document.querySelectorAll(".driver-eta").forEach(el => {
        el.style.display = "none";
    });

    const reportBtn = document.getElementById("reportProblemBtn");
    if (reportBtn) reportBtn.style.display = "none";

    const callBtn = document.getElementById("driverCallBtn");
    const msgBtn = document.getElementById("driverMsgBtn");
    const cancelBtn = document.getElementById("cancelRideBtnDriver");
    if (callBtn) callBtn.style.display = "flex";
    if (msgBtn) msgBtn.style.display = "flex";
    if (cancelBtn) cancelBtn.style.display = "flex";

    if (etaUpdateInterval) clearInterval(etaUpdateInterval);
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "none";

    // Effacer l'ancien tracé (bleu accepted) et forcer immédiatement le tracé pointillé
    if (typeof driverRouteLayer !== "undefined" && driverRouteLayer) {
        map.removeLayer(driverRouteLayer);
        driverRouteLayer = null;
    }
    // Réinitialiser lastDriverLat pour forcer posChanged = true au prochain appel
    lastDriverLat = null;
    lastDriverLng = null;

    if (typeof updateDriverPosition === "function") {
        setTimeout(updateDriverPosition, 300);
    }

    switchTab("ride");
}

function showArrivedNotice() {
    const panel = document.getElementById("rideAcceptedMsg");
    if (!panel || document.getElementById("rideArrivedNotice")) return;

    const notice = document.createElement("div");
    notice.id = "rideArrivedNotice";
    notice.className = "ride-arrived-notice";
    notice.textContent = "Le chauffeur est sur place. Vous pouvez le rejoindre au point de départ.";

    const status = document.getElementById("rideStatusMessage");
    if (status && status.nextSibling) {
        panel.insertBefore(notice, status.nextSibling);
    } else {
        panel.appendChild(notice);
    }
}

function removeArrivedNotice() {
    document.getElementById("rideArrivedNotice")?.remove();
}

// Démarre le suivi de la position du chauffeur pour afficher ETA / distance
function startDriverLiveTracking(rideData) {
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "block";

    // Initialiser la position à partir des données reçues
    if (rideData.driver && rideData.driver.lat && rideData.driver.lng) {
        currentDriverPosition = {
            lat: rideData.driver.lat,
            lng: rideData.driver.lng
        };
    }

    async function updateLiveETA() {
        await updateLiveETAFromCurrentPosition();
    }

    if (etaUpdateInterval) clearInterval(etaUpdateInterval);
    etaUpdateInterval = setInterval(updateLiveETA, 5000);
    updateLiveETA(); // premier appel immédiat
}


/* ============================================================
   SUIVI TEMPS RÉEL DE LA COURSE
============================================================ */

async function updateRideProgress() {
    if (!pickupCoords || !destinationCoords) return;

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${pickupCoords.lng},${pickupCoords.lat};${destinationCoords.lng},${destinationCoords.lat}?overview=false`;

        const response = await fetch(url);
        const data = await response.json();

        // Re-vérifier après l'await : si la course a été complétée/annulée
        // pendant l'attente réseau, resetMapPanel() a déjà remis #routeDistance
        // à "-" et masqué le fare strip. Écrire ici sans ce garde redéclenche
        // fareObserver (qui observe #routeDistance) et réaffiche le fare strip
        // juste après son nettoyage.
        if (!currentRideId || AppState.rideState !== "started") return;

        if (!data.routes || !data.routes.length) return;

        const route = data.routes[0];

        const distanceKm = (route.distance / 1000).toFixed(1);
        const durationMin = Math.round(route.duration / 60);

        const distanceEl = document.getElementById("routeDistance");
        const durationEl = document.getElementById("routeDuration");

        if (distanceEl) distanceEl.textContent = `${distanceKm} km`;
        if (durationEl) durationEl.textContent = `${durationMin} min`;

        const pillDistance = document.getElementById("pillDistance");
        const pillDuration = document.getElementById("pillDuration");

        if (pillDistance) pillDistance.textContent = `${distanceKm} km`;
        if (pillDuration) pillDuration.textContent = `${durationMin} min`;

    } catch (error) {
        console.error("Erreur suivi progression course :", error);
    }
}

function startRideProgressTracking() {
    if (etaUpdateInterval) clearInterval(etaUpdateInterval);

    etaUpdateInterval = setInterval(() => {
        if (AppState.rideState === "started") {
            updateRideProgress();
        }
    }, 5000);

    updateRideProgress();
}


// Modifier la fonction onRideCompleted pour afficher un message en grand
function onRideCompleted() {
    // Garde : éviter une double exécution (checkRideStatus + appels async en vol)
    if (AppState.rideState === "idle") return;

    // Marquer immédiatement l'état comme idle pour bloquer tout appel async en vol
    // (updateDriverPosition, updateRideProgress) qui vérifieront AppState.rideState
    AppState.rideState = "idle";

    // Stopper TOUS les intervalles et nullifier les références
    // pour éviter qu'un updateDriverPosition en vol recrée des calques après le nettoyage
    if (rideStatusCheckInterval) { clearInterval(rideStatusCheckInterval); rideStatusCheckInterval = null; }
    if (driverStatusInterval)    { clearInterval(driverStatusInterval);    driverStatusInterval = null; }
    if (etaUpdateInterval)       { clearInterval(etaUpdateInterval);       etaUpdateInterval = null; }

    currentRideId = null;
    rideAccepted = false;
    AppState.currentDriver = null;

    // Nettoyer la carte IMMÉDIATEMENT (avant le modal)
    // resetMapPanel supprime tous les calques et marqueurs SAUF pickup
    // (getUserLocation() le recrée proprement via watchPosition)
    resetMapPanel();
    startNearbyDriversPolling(); // chantier 3 (v4)

    // Afficher le modal de fin de course
    showCompletionMessage();

    $navBtns.ride.disabled = true;
    syncAppMode();

    // Basculer vers la carte après le modal (la carte est déjà propre)
    setTimeout(() => {
        switchTab("map");
    }, 3000);
}

function showCompletionMessage() {
    // Créer un overlay temporaire
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.backgroundColor = "rgba(0,0,0,0.8)";
    overlay.style.zIndex = "10000";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.flexDirection = "column";
    overlay.style.color = "white";
    overlay.style.fontSize = "2rem";
    overlay.style.fontWeight = "bold";
    overlay.innerHTML = `
        <div style="text-align: center; background: #1f2937; padding: 2rem; border-radius: 20px;">
            <div style="font-size: 4rem;">✅</div>
            <div>Course terminée !</div>
            <div style="font-size: 1rem; margin-top: 1rem;">Merci d'avoir voyagé avec TaxiGo</div>
        </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 3000);
}

// Modifier onRideAccepted pour cacher le bouton report si jamais (par sécurité)
function onRideAccepted(driverData) {
    if (AppState.rideState === "accepted") return;
    AppState.rideState = "accepted";
    syncAppMode();
    removeArrivedNotice();
    if (typeof routeLayer !== "undefined" && routeLayer) {
        map.removeLayer(routeLayer);
        routeLayer = null;
    }
    // Fix 1 : masquer le marqueur destination — il réapparaîtra au démarrage
    if (typeof destinationMarker !== "undefined" && destinationMarker) {
        map.removeLayer(destinationMarker);
        // Ne pas mettre à null : on garde destinationCoords + objet pour le remettre au started
    }
    let info;
    if (typeof driverData === "object" && driverData !== null) {
        info = {
            name:    driverData.name   || "Votre chauffeur",
            color:   driverData.color  || "",
            plate:   driverData.plate  || "-",
            rating:  driverData.rating || "4.8",
            phone:   driverData.phone  || ""
        };
    } else {
        const statusMsg  = String(driverData || "");
        const nameMatch  = statusMsg.match(/par\s+([^(]+?)\s*(\(|$)/);
        const plateMatch = statusMsg.match(/\(([^)]+)\)/);
        info = {
            name:    nameMatch  ? nameMatch[1].trim()  : "Votre chauffeur",
            plate:   plateMatch ? plateMatch[1].trim() : "-",
            color: "",
            rating:  "4.8"
        };
    }

    // ✅ AJOUT CRITIQUE : afficher les infos du chauffeur
    setDriverInfo(info);

    AppState.currentDriver = info;
    setRideState("accepted");
    const rideTitle = document.querySelector("#rideAcceptedMsg .ride-state-title");
    if (rideTitle) rideTitle.textContent = "Chauffeur en route";
    updateRideStatusMessage("Le chauffeur arrive");

    document.querySelectorAll(".driver-eta").forEach(el => {
        el.style.display = "";
    });

    // Cacher le bouton "Signaler un problème" si visible
    const reportBtn = document.getElementById("reportProblemBtn");
    if (reportBtn) reportBtn.style.display = "none";

    // Réafficher les boutons d'appel / message / annuler
    const callBtn = document.getElementById("driverCallBtn");
    const msgBtn = document.getElementById("driverMsgBtn");
    const cancelBtn = document.getElementById("cancelRideBtnDriver");
    if (callBtn) callBtn.style.display = "flex";
    if (msgBtn) msgBtn.style.display = "flex";
    if (cancelBtn) cancelBtn.style.display = "flex";

    // Arrêter l’ancien suivi ETA (si existant) et cacher l'info live
    if (etaUpdateInterval) clearInterval(etaUpdateInterval);
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "none";

    switchTab("ride");
    showToast(`🚕 ${info.name} arrive !`);

    // Fix 3 : forcer immédiatement le tracé bleu + marqueur taxi sans attendre l'intervalle
    if (typeof updateDriverPosition === "function") {
        setTimeout(updateDriverPosition, 500);
    }
}

// Ajouter l'écouteur pour le bouton "Signaler un problème"
function initReportProblem() {
    const btn = document.getElementById("reportProblemBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
        if (!currentRideId) return;
        const problem = prompt("Décrivez le problème rencontré :");
        if (!problem) return;
        fetch(`${CLIENT_API_BASE}/client/report_problem.php`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ride_id: currentRideId, problem: problem })
        })
        .then(res => res.json())
        .then(data => {
            if (data.status === "success") {
                showToast("Problème signalé, merci.");
            } else {
                showToast("Erreur lors de l'envoi.");
            }
        })
        .catch(() => showToast("Erreur réseau."));
    });
}

// Appelée à chaque polling (checkRideStatus) pour mettre à jour la position chauffeur
function onRideStatusUpdate(rideData) {
    if (!rideData || !rideData.driver) return;

    // Mettre à jour la position globale
    if (rideData.driver.lat && rideData.driver.lng) {
        currentDriverPosition = {
            lat: rideData.driver.lat,
            lng: rideData.driver.lng
        };
    }

    // Si la course est en "started" et que l'affichage ETA est actif, on rafraîchit
    if (AppState.rideState === "started") {
        const liveDiv = document.getElementById("driverLiveInfo");
        if (liveDiv && liveDiv.style.display !== "none") {
            updateLiveETAFromCurrentPosition();
        }
    }
}

// Recalcule l’ETA à partir de la dernière position connue du chauffeur
async function updateLiveETAFromCurrentPosition() {
    if (!currentDriverPosition.lat || !currentDriverPosition.lng) return;
    if (!pickupCoords) return;

    const url = `https://router.project-osrm.org/route/v1/driving/${currentDriverPosition.lng},${currentDriverPosition.lat};${pickupCoords.lng},${pickupCoords.lat}?overview=false`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.routes && data.routes.length) {
            const distanceM = data.routes[0].distance;
            const durationSec = data.routes[0].duration;
            const km = (distanceM / 1000).toFixed(1);
            const minutes = Math.round(durationSec / 60);
            document.getElementById("liveDistance").textContent = `${km} km`;
            document.getElementById("liveETA").textContent = `${minutes} min`;
        } else {
            document.getElementById("liveDistance").textContent = "Calcul...";
            document.getElementById("liveETA").textContent = "--";
        }
    } catch (e) {
        console.warn("Erreur calcul ETA temps réel", e);
    }
}
// â”€â”€ UTILS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }