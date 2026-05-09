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
let currentView = "map";

document.addEventListener("DOMContentLoaded", () => {
    initUserHeader("login.html");
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

    historyBtn = document.getElementById("historyBtn");
    clientBtn = document.getElementById("clientBtn");
    backToMapBtn = document.getElementById("backToMapBtn");
    historyList = document.getElementById("historyList");
    formElement = document.querySelector(".form");
    ridesContainer = document.getElementById("ridesContainer");

    historyBtn.addEventListener("click", showHistory);
    clientBtn.addEventListener("click", showMap);
    backToMapBtn.addEventListener("click", showMap);
});

function initMap() {
    map = L.map("map").setView([4.0511, 9.7679], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    getUserLocation();
    watchUserPosition();
}

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

        timeout = setTimeout(() => {
            loadAutocompleteSuggestions(inputId, query);
        }, 300);
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(`#${inputId}-suggestions`) && e.target !== input) {
            suggestionsBox.innerHTML = "";
        }
    });
}

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

function updateMarker(type, lat, lng) {
    if (type === "pickup") {
        if (pickupMarker) map.removeLayer(pickupMarker);

        pickupMarker = L.marker([lat, lng], {
            draggable: true
        }).addTo(map).bindPopup("Déplacez-moi");

        pickupMarker.on("dragend", async function () {
            const newPos = pickupMarker.getLatLng();
            pickupCoords = {
                lat: newPos.lat,
                lng: newPos.lng
            };

            const address = await reverseGeocode(newPos.lat, newPos.lng);
            document.getElementById("pickup").value = address || "Position ajustée";

            pickupMarker
                .bindPopup("Position mise à jour")
                .openPopup();
        });
    } else {
        if (destinationMarker) map.removeLayer(destinationMarker);

        destinationMarker = L.marker([lat, lng]).addTo(map)
            .bindPopup("Destination");
    }

    map.setView([lat, lng], 14);
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

function showHistory() {
    currentView = "history";
    if (clientBtn) clientBtn.classList.remove("active");
    if (historyBtn) historyBtn.classList.add("active");
    document.getElementById("map").style.display = "none";
    if (formElement) formElement.style.display = "none";
    historyList.style.display = "block";
    loadUserRides();
}

function showMap() {
    currentView = "map";
    if (historyBtn) historyBtn.classList.remove("active");
    if (clientBtn) clientBtn.classList.add("active");
    historyList.style.display = "none";
    document.getElementById("map").style.display = "block";
    if (formElement) formElement.style.display = "block";
}

function displayRides() {
    const completedRides = userRides.filter(ride => ride.status === "completed");

    if (userRides.length === 0) {
        ridesContainer.innerHTML = "<p>Aucune course trouvée.</p>";
        return;
    }

    ridesContainer.innerHTML = completedRides.map(ride => `
        <div class="ride-item" onclick="selectRide(${ride.id})">
            <div class="details">
                <strong>${ride.pickup} → ${ride.destination}</strong>
                <div>Distance: ${ride.distance_km} km | Prix: ${ride.price_fcfa} FCFA</div>
                <div>Passagers: ${ride.passengers} | Créée: ${new Date(ride.created_at).toLocaleString()}</div>
            </div>
            <span class="status ${ride.status}">${ride.status === "completed" ? "Terminée" : "En attente"}</span>
        </div>
    `).join("");
}

function selectRide(rideId) {
    const ride = userRides.find(r => r.id == rideId);
    if (!ride) return;

    showMap();
    displayRideOnMap(ride);
}

async function displayRideOnMap(ride) {
    if (routeLayer) map.removeLayer(routeLayer);
    if (pickupMarker) map.removeLayer(pickupMarker);
    if (destinationMarker) map.removeLayer(destinationMarker);
    if (driverPositionMarker) map.removeLayer(driverPositionMarker);
    if (driverRouteLayer) map.removeLayer(driverRouteLayer);

    pickupCoords = { lat: ride.pickup_lat, lng: ride.pickup_lng };
    destinationCoords = { lat: ride.destination_lat, lng: ride.destination_lng };

    pickupMarker = L.marker([pickupCoords.lat, pickupCoords.lng])
        .addTo(map).bindPopup(`Départ: ${ride.pickup}`);

    destinationMarker = L.marker([destinationCoords.lat, destinationCoords.lng])
        .addTo(map).bindPopup(`Destination: ${ride.destination}`);

    await drawRouteOnMap(pickupCoords, destinationCoords);

    if (ride.status === "accepted") {
        currentRideId = ride.id;
        rideAccepted = true;
        updateDriverPosition();
    }

    const bounds = L.latLngBounds([
        [pickupCoords.lat, pickupCoords.lng],
        [destinationCoords.lat, destinationCoords.lng]
    ]);
    map.fitBounds(bounds, { padding: [30, 30] });
}

function centerMapOnRide(markerA, markerB) {
    const points = [];
    if (markerA) points.push(markerA.getLatLng());
    if (markerB) points.push(markerB.getLatLng());

    if (points.length < 2) return;

    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds.pad(0.3), { padding: [40, 40] });
}
