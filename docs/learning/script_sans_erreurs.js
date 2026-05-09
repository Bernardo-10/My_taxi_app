// Version pedagogique de script.js.
// Objectif : lire le flux principal sans le bruit des gestions d'erreur.
// A ne pas utiliser en production.

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
    initUserHeader("login_client.html");
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

async function initUserHeader(loginPage) {
    const currentUserName = document.getElementById("currentUserName");
    const logoutBtn = document.getElementById("logoutBtn");

    const response = await fetch("current_user.php");
    const result = await response.json();
    currentUserName.textContent = result.user.name;

    logoutBtn.addEventListener("click", async () => {
        await fetch("logout.php", { method: "POST" });
        window.location.href = loginPage;
    });
}

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

        timeout = setTimeout(async () => {
            const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lat=5.5&lon=12.3`;
            const response = await fetch(url);
            const data = await response.json();

            const features = data.features.filter((feature) => {
                const country = (feature.properties.country || "").toLowerCase();
                const countryCode = (feature.properties.country_code || "").toLowerCase();
                return country.includes("cam") || countryCode === "cm" || !country;
            });

            renderSuggestions(inputId, features);
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

async function findRoute() {
    const pickupText = document.getElementById("pickup").value.trim();
    const destinationText = document.getElementById("destination").value.trim();

    if (!destinationCoords) {
        destinationCoords = await geocodeAddress(destinationText);
        updateMarker("destination", destinationCoords.lat, destinationCoords.lng);
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${pickupCoords.lng},${pickupCoords.lat};${destinationCoords.lng},${destinationCoords.lat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    const route = data.routes[0];

    const distanceKm = route.distance / 1000;
    const durationMin = Math.round(route.duration / 60);
    const passengers = parseInt(document.querySelector(".passengers input").value) || 1;
    const basePrice = distanceKm * 75;
    const discountRate = 0.10 * (passengers - 1);
    const finalDiscount = Math.min(discountRate, 0.7);
    const totalPrice = basePrice * passengers * (1 - finalDiscount);
    const priceFcfa = Math.round(totalPrice);

    if (routeLayer) map.removeLayer(routeLayer);

    routeLayer = L.geoJSON(route.geometry, {
        style: { color: "#27ae60", weight: 6 }
    }).addTo(map);

    map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });

    document.getElementById("routeDistance").textContent = `${distanceKm.toFixed(2)} km`;
    document.getElementById("routeDuration").textContent = `${durationMin} min`;
    document.getElementById("routePrice").textContent = `${priceFcfa} FCFA (${passengers} passagers)`;

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
        passengers
    });
}

async function geocodeAddress(query) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`;
    const response = await fetch(url);
    const data = await response.json();
    const feature = data.features[0];

    return {
        lat: feature.geometry.coordinates[1],
        lng: feature.geometry.coordinates[0]
    };
}

async function reverseGeocode(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
    const response = await fetch(url);
    const data = await response.json();
    return data.display_name;
}

async function sendToBackend(data) {
    const response = await fetch("backend.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });

    const result = await response.json();
    currentRideId = result.ride_id;
    startRideTracking();
    showWaitingMessage();
}

function updateRideStatusMessage(message) {
    rideStatusMessage.textContent = message;
}

function showWaitingMessage() {
    updateRideStatusMessage("Course envoyee, en attente d'acceptation du chauffeur...");
    refreshMapBtn.disabled = false;
}

function startRideTracking() {
    clearInterval(rideStatusCheckInterval);
    clearInterval(driverStatusInterval);

    rideAccepted = false;
    updateRideStatusMessage("En attente d'acceptation du chauffeur...");

    checkRideStatus();
    rideStatusCheckInterval = setInterval(checkRideStatus, 5000);
    driverStatusInterval = setInterval(updateDriverPosition, 10000);
}

async function checkRideStatus(forceRefresh = false) {
    const response = await fetch(`check_ride_status.php?ride_id=${currentRideId}`);
    const result = await response.json();

    if (result.ride_status === "accepted") {
        if (!rideAccepted || forceRefresh) {
            rideAccepted = true;
            updateRideStatusMessage(`Course acceptee par ${result.driver_name} (${result.driver_plate})`);
        }
        await updateDriverPosition();
    } else if (result.ride_status === "cancelled") {
        clearInterval(rideStatusCheckInterval);
        clearInterval(driverStatusInterval);
        rideAccepted = false;
        updateRideStatusMessage("Course annulee.");
    } else if (result.ride_status === "completed") {
        clearInterval(rideStatusCheckInterval);
        clearInterval(driverStatusInterval);
        updateRideStatusMessage("Course terminee. Merci !");
    } else {
        updateRideStatusMessage("Course toujours en attente d'acceptation...");
    }
}

async function updateDriverPosition() {
    const response = await fetch(`get_driver_location.php?ride_id=${currentRideId}`);
    const data = await response.json();

    const driverLat = parseFloat(data.driver_lat);
    const driverLng = parseFloat(data.driver_lng);

    if (driverPositionMarker) {
        driverPositionMarker.setLatLng([driverLat, driverLng]);
    } else {
        const taxiIcon = L.divIcon({
            html: '<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:30px;line-height:1;">Taxi</div>',
            className: "",
            iconSize: [40, 40],
            iconAnchor: [20, 38],
            popupAnchor: [0, -40]
        });

        driverPositionMarker = L.marker([driverLat, driverLng], { icon: taxiIcon })
            .addTo(map)
            .bindPopup("<strong>Votre chauffeur</strong><br>Il arrive vers vous !");
    }

    const posChanged = lastDriverLat === null ||
        Math.abs(driverLat - lastDriverLat) > 0.00005 ||
        Math.abs(driverLng - lastDriverLng) > 0.00005;

    lastDriverLat = driverLat;
    lastDriverLng = driverLng;

    if (posChanged && pickupCoords) {
        if (driverRouteLayer) map.removeLayer(driverRouteLayer);

        const route = await getRouteGeoJSON(driverLng, driverLat, pickupCoords.lng, pickupCoords.lat);
        driverRouteLayer = L.geoJSON(route, {
            style: { color: "#1d4ed8", weight: 5, opacity: 0.75, dashArray: "8, 6" }
        }).addTo(map);
    }
}

async function getRouteGeoJSON(startLng, startLat, endLng, endLat) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    return data.routes[0].geometry;
}

async function showHistory() {
    clientBtn.classList.remove("active");
    historyBtn.classList.add("active");
    document.getElementById("map").style.display = "none";
    formElement.style.display = "none";
    historyList.style.display = "block";
    await loadUserRides();
}

function showMap() {
    historyBtn.classList.remove("active");
    clientBtn.classList.add("active");
    historyList.style.display = "none";
    document.getElementById("map").style.display = "block";
    formElement.style.display = "block";
}

async function loadUserRides() {
    const response = await fetch("get_user_rides.php");
    userRides = await response.json();
    displayRides();
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

async function drawRouteOnMap(fromCoords, toCoords) {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromCoords.lng},${fromCoords.lat};${toCoords.lng},${toCoords.lat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    const route = data.routes[0];

    if (routeLayer) map.removeLayer(routeLayer);

    routeLayer = L.geoJSON(route.geometry, {
        style: { color: "#27ae60", weight: 6, opacity: 0.8 }
    }).addTo(map);
}
