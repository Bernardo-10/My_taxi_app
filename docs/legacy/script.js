let map;
let routeLayer = null;
let pickupMarker = null;
let destinationMarker = null;
let driverMarker = null;
let driverRouteLayer = null;

let pickupCoords = null;
let destinationCoords = null;
let currentRideId = null;
let rideStatusCheckInterval = null;
let driverStatusInterval = null;
let rideAccepted = false;
let driverPositionMarker = null;
let lastDriverLat = null;
let lastDriverLng = null;
let refreshMapBtn = null;
let rideStatusMessage = null;
let historyBtn = null;
let clientBtn = null;
let backToMapBtn = null;
let historyList = null;
let formElement = null;
let ridesContainer = null;
let userRides = [];
let currentView = 'map'; // 'map' or 'history'

// 🚀 INITIALISATION
document.addEventListener("DOMContentLoaded", () => {
    initUserHeader("login_client.html");
    initMap();
    initAutocomplete("pickup");
    initAutocomplete("destination");

    document.getElementById("findRideBtn").addEventListener("click", findRoute);
    refreshMapBtn = document.getElementById("refreshMapBtn");
    rideStatusMessage = document.getElementById("rideStatusMessage");
    refreshMapBtn.disabled = true;
    refreshMapBtn.addEventListener("click", () => {
        if (currentRideId) {
            checkRideStatus(true);
        } else {
            updateRideStatusMessage("Aucune course à rafraîchir pour l'instant.");
        }
    });

    // Historique
    historyBtn = document.getElementById("historyBtn");
    clientBtn = document.getElementById("clientBtn");
    backToMapBtn = document.getElementById("backToMapBtn");
    historyList = document.getElementById("historyList");
    formElement = document.querySelector('.form');
    ridesContainer = document.getElementById("ridesContainer");

    historyBtn.addEventListener("click", showHistory);
    clientBtn.addEventListener("click", showMap);
    backToMapBtn.addEventListener("click", showMap);
});

async function initUserHeader(loginPage) {
    const currentUserName = document.getElementById("currentUserName");
    const logoutBtn = document.getElementById("logoutBtn");

    try {
        const response = await fetch("current_user.php");
        const result = await response.json();

        if (response.status === 401) {
            window.location.href = loginPage;
            return;
        }

        if (result.status === "success" && currentUserName) {
            currentUserName.textContent = result.user.name || "Utilisateur";
        }
    } catch (error) {
        console.error("Erreur chargement utilisateur:", error);
    }

    if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
            try {
                await fetch("logout.php", { method: "POST" });
            } finally {
                window.location.href = loginPage;
            }
        });
    }
}

// 🗺️ INITIALISATION CARTE
function initMap() {
    map = L.map("map").setView([4.0511, 9.7679], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    getUserLocation();
    watchUserPosition();
}

// 📍 GÉOLOCALISATION (PRÉCISE)
function getUserLocation() {
    if (!navigator.geolocation) {
        alert("La géolocalisation n'est pas supportée.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            console.log("Position :", lat, lng);
            console.log("Précision :", accuracy, "m");

            pickupCoords = { lat, lng };

            map.setView([lat, lng], 16);

            updateMarker("pickup", lat, lng);

            pickupMarker
                .bindPopup(`Vous êtes ici (±${Math.round(accuracy)} m)`)
                .openPopup();

            document.getElementById("pickup").value = "Ma position actuelle";
        },
        (error) => {
            console.error("Erreur géolocalisation :", error);
            alert("Activez la localisation et le GPS.");
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        }
    );
}

// 🔄 SUIVI TEMPS RÉEL
function watchUserPosition() {
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            pickupCoords = { lat, lng };

            if (pickupMarker) {
                pickupMarker.setLatLng([lat, lng]);
            } else {
                updateMarker("pickup", lat, lng);
            }
        },
        (error) => console.error("Erreur watch:", error),
        {
            enableHighAccuracy: true,
            maximumAge: 0
        }
    );
}

// 🔍 AUTOCOMPLETE (PHOTON)
function initAutocomplete(inputId) {
    const input = document.getElementById(inputId);
    const suggestionsBox = document.getElementById(`${inputId}-suggestions`);

    let timeout = null;

    input.addEventListener("input", () => {
        const query = input.value.trim();

        if (timeout) clearTimeout(timeout);

        if (query.length < 3) {
            suggestionsBox.innerHTML = "";
            return;
        }

        timeout = setTimeout(async () => {
            try {
                const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lat=5.5&lon=12.3`;

                const response = await fetch(url);
                const data = await response.json();

                let features = data.features || [];

                // 🇨🇲 filtre intelligent Cameroun (SAFE)
                features = features.filter(f => {
                    const country = (f.properties.country || "").toLowerCase();
                    const countryCode = (f.properties.country_code || "").toLowerCase();

                    return (
                        country.includes("cam") ||   // cameroon / cameroun
                        countryCode === "cm" ||      // code officiel
                        !country                    // fallback si champ absent
                    );
                });

                renderSuggestions(inputId, features);

            } catch (error) {
                console.error("Erreur autocomplete :", error);
            }
        }, 300);
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(`#${inputId}-suggestions`) && e.target !== input) {
            suggestionsBox.innerHTML = "";
        }
    });
}

// 📋 AFFICHAGE SUGGESTIONS
function renderSuggestions(inputId, features) {
    const suggestionsBox = document.getElementById(`${inputId}-suggestions`);
    suggestionsBox.innerHTML = "";

    features.forEach((feature) => {
        const name = feature.properties.name || "";
        const city = feature.properties.city || feature.properties.country || "";
        const label = city ? `${name}, ${city}` : name;

        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.textContent = label;

        item.addEventListener("click", () => {
            const lat = feature.geometry.coordinates[1];
            const lng = feature.geometry.coordinates[0];

            document.getElementById(inputId).value = label;
            suggestionsBox.innerHTML = "";

            if (inputId === "pickup") {
                pickupCoords = { lat, lng };
                updateMarker("pickup", lat, lng);
            } else {
                destinationCoords = { lat, lng };
                updateMarker("destination", lat, lng);
            }
        });

        suggestionsBox.appendChild(item);
    });
}

// 📍 MARKERS
function updateMarker(type, lat, lng) {
    if (type === "pickup") {
        if (pickupMarker) map.removeLayer(pickupMarker);

        pickupMarker = L.marker([lat, lng], {
            draggable: true // 🔥 IMPORTANT
        }).addTo(map).bindPopup("Déplacez-moi");

        // 🎯 Quand on déplace le marker
        pickupMarker.on("dragend", async function () {
            const newPos = pickupMarker.getLatLng();

            pickupCoords = {
                lat: newPos.lat,
                lng: newPos.lng
            };

            // 🔄 Mise à jour du champ texte avec l'adresse
            const address = await reverseGeocode(newPos.lat, newPos.lng);

            document.getElementById("pickup").value =
                address || "Position ajustée";

            pickupMarker
                .bindPopup("Position mise à jour")
                .openPopup();

            console.log("Nouvelle position :", pickupCoords);
        });

    } else {
        if (destinationMarker) map.removeLayer(destinationMarker);

        destinationMarker = L.marker([lat, lng]).addTo(map)
            .bindPopup("Destination");
    }

    map.setView([lat, lng], 14);
}

// 🚗 CALCUL ITINÉRAIRE + PRIX
async function findRoute() {
    const pickupText = document.getElementById("pickup").value.trim();
    const destinationText = document.getElementById("destination").value.trim();

    if (!pickupCoords) {
        alert("Veuillez choisir votre position de départ.");
        return;
    }

    if (!destinationText) {
        alert("Veuillez entrer une destination.");
        return;
    }

    if (!destinationCoords) {
        destinationCoords = await geocodeAddress(destinationText);

        if (!destinationCoords) {
            alert("Destination introuvable.");
            return;
        }

        updateMarker("destination", destinationCoords.lat, destinationCoords.lng);
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${pickupCoords.lng},${pickupCoords.lat};${destinationCoords.lng},${destinationCoords.lat}?overview=full&geometries=geojson`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!data.routes || !data.routes.length) {
            alert("Impossible de calculer l'itinéraire.");
            return;
        }

        const route = data.routes[0];
        const distanceKm = route.distance / 1000;
        const durationMin = Math.round(route.duration / 60);
        const passengers = parseInt(document.querySelector(".passengers input").value) || 1;

        const basePrice = distanceKm * 75;

        // 🔥 réduction 5% par passager supplémentaire
        const discountRate = 0.10 * (passengers - 1);

        // éviter réduction excessive (optionnel)
        const finalDiscount = Math.min(discountRate, 0.7); // max 70%

        const totalPrice = basePrice * passengers * (1 - finalDiscount);

        const priceFcfa = Math.round(totalPrice);

        if (routeLayer) map.removeLayer(routeLayer);

        routeLayer = L.geoJSON(route.geometry, {
            style: {
                color: "#27ae60",
                weight: 6
            }
        }).addTo(map);

        map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });

        document.getElementById("routeDistance").textContent = `${distanceKm.toFixed(2)} km`;
        document.getElementById("routeDuration").textContent = `${durationMin} min`;
        document.getElementById("routePrice").textContent =
        `${priceFcfa} FCFA (${passengers} passagers)`;

        sendToBackend({
            pickup: pickupText,
            destination: destinationText,

            pickup_lat: pickupCoords.lat,
            pickup_lng: pickupCoords.lng,

            destination_lat: destinationCoords.lat,
            destination_lng: destinationCoords.lng,

            distance_km: distanceKm,
            duration_min: durationMin,
            price_fcfa: priceFcfa,
            passengers: passengers
        });

    } catch (error) {
        console.error("Erreur itinéraire :", error);
        alert("Erreur lors du calcul.");
    }
}

// 🌍 GEOCODAGE SI UTILISATEUR TAPE MANUELLEMENT
async function geocodeAddress(query) {
    try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`;
        const response = await fetch(url);
        const data = await response.json();

        if (!data.features || !data.features.length) return null;

        const feature = data.features[0];

        return {
            lat: feature.geometry.coordinates[1],
            lng: feature.geometry.coordinates[0]
        };
    } catch (error) {
        console.error("Erreur géocodage :", error);
        return null;
    }
}

async function reverseGeocode(lat, lng) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
        const response = await fetch(url);
        const data = await response.json();

        return data.display_name;
    } catch (error) {
        console.error("Erreur reverse geocoding :", error);
        return null;
    }
}

// 💾 ENVOI BACKEND
async function sendToBackend(data) {
    try {
        const response = await fetch("backend.php", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();
        console.log("Réponse backend :", result);

        if (response.status === 401) {
            window.location.href = "login_client.html";
            return result;
        }

        if (result.status === "success" && result.ride_id) {
            currentRideId = result.ride_id;
            startRideTracking();
            showWaitingMessage();
        }

        return result;
    } catch (error) {
        console.error("Erreur backend:", error);
        return { status: "error", message: "Erreur de connexion" };
    }
}

function updateRideStatusMessage(message) {
    if (!rideStatusMessage) return;
    rideStatusMessage.textContent = message;
}

function showWaitingMessage() {
    updateRideStatusMessage("Course envoyée, en attente d'acceptation du chauffeur...");
    if (refreshMapBtn) {
        refreshMapBtn.disabled = false;
    }
}

function startRideTracking() {
    if (rideStatusCheckInterval) {
        clearInterval(rideStatusCheckInterval);
    }
    rideAccepted = false;
    updateRideStatusMessage("En attente d'acceptation du chauffeur...");
    checkRideStatus();
    rideStatusCheckInterval = setInterval(checkRideStatus, 5000);

    // Démarrer aussi la mise à jour de la position du chauffeur
    if (driverStatusInterval) {
        clearInterval(driverStatusInterval);
    }
    driverStatusInterval = setInterval(updateDriverPosition, 10000);
}

async function checkRideStatus(forceRefresh = false) {
    if (!currentRideId) return;

    try {
        const response = await fetch(`check_ride_status.php?ride_id=${currentRideId}`);
        const result = await response.json();

        if (result.status !== "success") {
            updateRideStatusMessage("Impossible de vérifier le statut de la course.");
            return;
        }

        if (result.ride_status === "accepted") {
            if (!rideAccepted || forceRefresh) {
                rideAccepted = true;
                updateRideStatusMessage(`✅ Course acceptée par ${result.driver_name || 'le chauffeur'} (${result.driver_plate || ''}) 🚕`);
            }
            await updateDriverPosition();
        } else if (result.ride_status === "cancelled") {
            clearInterval(rideStatusCheckInterval);
            clearInterval(driverStatusInterval);
            rideAccepted = false;
            updateRideStatusMessage("❌ Course annulée.");
        } else if (result.ride_status === "completed") {
            clearInterval(rideStatusCheckInterval);
            clearInterval(driverStatusInterval);
            updateRideStatusMessage("🏁 Course terminée. Merci !");
        } else {
            updateRideStatusMessage("⏳ Course toujours en attente d'acceptation...");
        }
    } catch (error) {
        console.error("Erreur vérification statut de course:", error);
        updateRideStatusMessage("Erreur lors de la vérification du statut.");
    }
}

async function updateDriverPosition() {
    if (!currentRideId || !rideAccepted) {
        console.log("⏳ Pas de course acceptée, pas de mise à jour");
        return;
    }

    try {
        console.log(`🔄 Récupération position chauffeur pour course #${currentRideId}`);
        
        const response = await fetch(`get_driver_location.php?ride_id=${currentRideId}`);
        const data = await response.json();

        console.log("📡 Réponse serveur:", data);

        if (data.status !== "success") {
            console.warn("⚠️ Position chauffeur indisponible:", data.message);
            updateRideStatusMessage("Attente de la position du chauffeur...");
            return;
        }

        const driverLat = parseFloat(data.driver_lat);
        const driverLng = parseFloat(data.driver_lng);

        console.log(`📍 Position chauffeur reçue: Lat=${driverLat}, Lng=${driverLng}`);

        if (isNaN(driverLat) || isNaN(driverLng)) {
            console.error("❌ Coordonnées chauffeur invalides:", data);
            updateRideStatusMessage("Position chauffeur invalide");
            return;
        }

        // ✅ Mettre à jour ou créer le marqueur taxi
        if (driverPositionMarker) {
            console.log("🚕 Mise à jour marqueur taxi existant");
            driverPositionMarker.setLatLng([driverLat, driverLng]);
        } else {
            console.log("🚕 Création du marqueur taxi");
            const taxiIcon = L.divIcon({
                html: '<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:30px;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.6));">🚕</div>',
                className: '',
                iconSize: [40, 40],
                iconAnchor: [20, 38],
                popupAnchor: [0, -40]
            });
            driverPositionMarker = L.marker([driverLat, driverLng], { icon: taxiIcon })
                .addTo(map)
                .bindPopup('<strong>🚕 Votre chauffeur</strong><br>Il arrive vers vous !');
            driverPositionMarker.openPopup();
        }

        // 🛣️ Tracer l'itinéraire chauffeur vers client
        const posChanged = (lastDriverLat === null) ||
            (Math.abs(driverLat - lastDriverLat) > 0.00005) ||
            (Math.abs(driverLng - lastDriverLng) > 0.00005);

        lastDriverLat = driverLat;
        lastDriverLng = driverLng;

        if (posChanged && pickupCoords) {
            console.log("🛣️ Recalcul de l'itinéraire");
            if (driverRouteLayer) {
                map.removeLayer(driverRouteLayer);
                driverRouteLayer = null;
            }
            const route = await getRouteGeoJSON(driverLng, driverLat, pickupCoords.lng, pickupCoords.lat);
            if (route) {
                driverRouteLayer = L.geoJSON(route, {
                    style: { color: '#1d4ed8', weight: 5, opacity: 0.75, dashArray: '8, 6' }
                }).addTo(map);
            }
        }

        //centerMapOnRide(driverPositionMarker, pickupMarker);

    } catch (error) {
        console.error("❌ Erreur mise à jour position chauffeur:", error);
    }
}

function centerMapOnRide(markerA, markerB) {
    const points = [];
    if (markerA) points.push(markerA.getLatLng());
    if (markerB) points.push(markerB.getLatLng());

    if (points.length < 2) return;

    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds.pad(0.3), { padding: [40, 40] });
}

async function getRouteGeoJSON(startLng, startLat, endLng, endLat) {
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
        const response = await fetch(url);
        const data = await response.json();
        return data.routes && data.routes[0] ? data.routes[0].geometry : null;
    } catch (error) {
        console.error("Erreur OSRM route:", error);
        return null;
    }
}

// HISTORIQUE
async function showHistory() {
    currentView = 'history';
    if (clientBtn) clientBtn.classList.remove('active');
    if (historyBtn) historyBtn.classList.add('active');
    document.getElementById("map").style.display = 'none';
    if (formElement) formElement.style.display = 'none';
    historyList.style.display = 'block';
    await loadUserRides();
}

function showMap() {
    currentView = 'map';
    if (historyBtn) historyBtn.classList.remove('active');
    if (clientBtn) clientBtn.classList.add('active');
    historyList.style.display = 'none';
    document.getElementById("map").style.display = 'block';
    if (formElement) formElement.style.display = 'block';
}

async function loadUserRides() {
    try {
        const response = await fetch('get_user_rides.php');
        if (response.status === 401) {
            window.location.href = "login_client.html";
            return;
        }
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const text = await response.text();
        try {
            userRides = JSON.parse(text);
        } catch (parseError) {
            throw new Error(`Réponse JSON invalide: ${text}`);
        }

        if (!Array.isArray(userRides)) {
            throw new Error(`Réponse inattendue du serveur : ${JSON.stringify(userRides)}`);
        }

        displayRides();
    } catch (error) {
        console.error('Erreur chargement courses:', error);
        ridesContainer.innerHTML = '<p>Erreur lors du chargement des courses.</p>';
    }
}

function displayRides() {
    if (userRides.length === 0) {
        ridesContainer.innerHTML = '<p>Aucune course trouvée.</p>';
        return;
    }

    ridesContainer.innerHTML = userRides.map(ride => `
        <div class="ride-item" onclick="selectRide(${ride.id})">
            <div class="details">
                <strong>${ride.pickup} → ${ride.destination}</strong>
                <div>Distance: ${ride.distance_km} km | Prix: ${ride.price_fcfa} FCFA</div>
                <div>Passagers: ${ride.passengers} | Créée: ${new Date(ride.created_at).toLocaleString()}</div>
            </div>
            <span class="status ${ride.status}">${ride.status === 'pending' ? 'En attente' : 'Acceptée'}</span>
        </div>
    `).join('');
}

function selectRide(rideId) {
    const ride = userRides.find(r => r.id == rideId);
    if (!ride) return;

    // Changer la vue vers la carte
    showMap();

    // Afficher cette course sur la carte
    displayRideOnMap(ride);
}

async function displayRideOnMap(ride) {
    // Nettoyer la carte
    if (routeLayer) map.removeLayer(routeLayer);
    if (pickupMarker) map.removeLayer(pickupMarker);
    if (destinationMarker) map.removeLayer(destinationMarker);
    if (driverPositionMarker) map.removeLayer(driverPositionMarker);
    if (driverRouteLayer) map.removeLayer(driverRouteLayer);

    // Positionner les marqueurs
    pickupCoords = { lat: ride.pickup_lat, lng: ride.pickup_lng };
    destinationCoords = { lat: ride.destination_lat, lng: ride.destination_lng };

    pickupMarker = L.marker([pickupCoords.lat, pickupCoords.lng])
        .addTo(map).bindPopup(`Départ: ${ride.pickup}`);

    destinationMarker = L.marker([destinationCoords.lat, destinationCoords.lng])
        .addTo(map).bindPopup(`Destination: ${ride.destination}`);

    // Calculer et afficher l'itinéraire sans recréer une course
    await drawRouteOnMap(pickupCoords, destinationCoords);

    // Si la course est acceptée, afficher le chauffeur
    if (ride.status === 'accepted') {
        currentRideId = ride.id;
        updateDriverRoute();
    }

    // Centrer la carte
    const bounds = L.latLngBounds([
        [pickupCoords.lat, pickupCoords.lng],
        [destinationCoords.lat, destinationCoords.lng]
    ]);
    map.fitBounds(bounds, { padding: [30, 30] });
}

async function drawRouteOnMap(fromCoords, toCoords) {
    if (!fromCoords || !toCoords) return;

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${fromCoords.lng},${fromCoords.lat};${toCoords.lng},${toCoords.lat}?overview=full&geometries=geojson`;
        const response = await fetch(url);
        const data = await response.json();

        if (!data.routes || !data.routes.length) return;

        const route = data.routes[0];
        if (routeLayer) {
            map.removeLayer(routeLayer);
        }

        routeLayer = L.geoJSON(route.geometry, {
            style: {
                color: "#27ae60",
                weight: 6,
                opacity: 0.8
            }
        }).addTo(map);
    } catch (error) {
        console.error("Erreur affichage itinéraire historique:", error);
    }
}
