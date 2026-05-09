// Version pedagogique UI du client.
// Contient surtout les fonctions qui manipulent l'affichage, le DOM et la carte.

let map;
let routeLayer = null;
let pickupMarker = null;
let destinationMarker = null;
let driverRouteLayer = null;
let driverPositionMarker = null;

let pickupCoords = null;
let destinationCoords = null;
let currentRideId = null;
let rideStatusCheckInterval = null;
let driverStatusInterval = null;
let rideAccepted = false;
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

document.addEventListener("DOMContentLoaded", () => {
    initUserHeader("login.html");
    initMap();
    initAutocomplete("pickup");
    initAutocomplete("destination");

    document.getElementById("findRideBtn").addEventListener("click", findRoute);

    refreshMapBtn = document.getElementById("refreshMapBtn");
    rideStatusMessage = document.getElementById("rideStatusMessage");
    refreshMapBtn.disabled = true;
    refreshMapBtn.addEventListener("click", () => checkRideStatus(true));

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
    navigator.geolocation.getCurrentPosition((position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        pickupCoords = { lat, lng };
        map.setView([lat, lng], 16);
        updateMarker("pickup", lat, lng);

        pickupMarker
            .bindPopup(`Vous etes ici (+/-${Math.round(accuracy)} m)`)
            .openPopup();

        document.getElementById("pickup").value = "Ma position actuelle";
    });
}

function watchUserPosition() {
    navigator.geolocation.watchPosition((position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        pickupCoords = { lat, lng };

        if (pickupMarker) {
            pickupMarker.setLatLng([lat, lng]);
        } else {
            updateMarker("pickup", lat, lng);
        }
    });
}

function initAutocomplete(inputId) {
    const input = document.getElementById(inputId);
    const suggestionsBox = document.getElementById(`${inputId}-suggestions`);
    let timeout = null;

    input.addEventListener("input", () => {
        const query = input.value.trim();
        clearTimeout(timeout);

        if (query.length < 3) {
            suggestionsBox.innerHTML = "";
            return;
        }

        timeout = setTimeout(() => {
            loadAutocompleteSuggestions(inputId, query);
        }, 300);
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest(`#${inputId}-suggestions`) && event.target !== input) {
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

        pickupMarker = L.marker([lat, lng], { draggable: true })
            .addTo(map)
            .bindPopup("Deplacez-moi");

        pickupMarker.on("dragend", async () => {
            const newPos = pickupMarker.getLatLng();
            pickupCoords = { lat: newPos.lat, lng: newPos.lng };

            const address = await reverseGeocode(newPos.lat, newPos.lng);
            document.getElementById("pickup").value = address || "Position ajustee";

            pickupMarker.bindPopup("Position mise a jour").openPopup();
        });
    } else {
        if (destinationMarker) map.removeLayer(destinationMarker);

        destinationMarker = L.marker([lat, lng])
            .addTo(map)
            .bindPopup("Destination");
    }

    map.setView([lat, lng], 14);
}

function updateRideStatusMessage(message) {
    rideStatusMessage.textContent = message;
}

function showWaitingMessage() {
    updateRideStatusMessage("Course envoyee, en attente d'acceptation du chauffeur...");
    refreshMapBtn.disabled = false;
}

function showHistory() {
    clientBtn.classList.remove("active");
    historyBtn.classList.add("active");
    document.getElementById("map").style.display = "none";
    formElement.style.display = "none";
    historyList.style.display = "block";
    loadUserRides();
}

function showMap() {
    historyBtn.classList.remove("active");
    clientBtn.classList.add("active");
    historyList.style.display = "none";
    document.getElementById("map").style.display = "block";
    formElement.style.display = "block";
}

function displayRides() {
    if (userRides.length === 0) {
        ridesContainer.innerHTML = "<p>Aucune course trouvee.</p>";
        return;
    }

    ridesContainer.innerHTML = userRides.map(ride => `
        <div class="ride-item" onclick="selectRide(${ride.id})">
            <div class="details">
                <strong>${ride.pickup} -> ${ride.destination}</strong>
                <div>Distance: ${ride.distance_km} km | Prix: ${ride.price_fcfa} FCFA</div>
                <div>Passagers: ${ride.passengers} | Creee: ${new Date(ride.created_at).toLocaleString()}</div>
            </div>
            <span class="status ${ride.status}">${ride.status}</span>
        </div>
    `).join("");
}

function selectRide(rideId) {
    const ride = userRides.find(r => r.id == rideId);
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
        .addTo(map)
        .bindPopup(`Depart: ${ride.pickup}`);

    destinationMarker = L.marker([destinationCoords.lat, destinationCoords.lng])
        .addTo(map)
        .bindPopup(`Destination: ${ride.destination}`);

    await drawRouteOnMap(pickupCoords, destinationCoords);

    const bounds = L.latLngBounds([
        [pickupCoords.lat, pickupCoords.lng],
        [destinationCoords.lat, destinationCoords.lng]
    ]);
    map.fitBounds(bounds, { padding: [30, 30] });
}
