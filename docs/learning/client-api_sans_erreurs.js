// Version pedagogique API du client.
// Contient les appels fetch et les fonctions qui parlent au backend ou a des APIs externes.

const CLIENT_API = {
    currentUser: "../../../backend/common/current_user.php",
    logout: "../../../backend/common/logout.php",
    createRide: "../../../backend/client/backend.php",
    rideStatus: "../../../backend/client/check_ride_status.php",
    driverLocation: "../../../backend/client/get_driver_location.php",
    userRides: "../../../backend/client/get_user_rides.php",
    photon: "https://photon.komoot.io/api/",
    nominatimReverse: "https://nominatim.openstreetmap.org/reverse",
    osrmRoute: "https://router.project-osrm.org/route/v1/driving"
};

async function initUserHeader(loginPage) {
    const currentUserName = document.getElementById("currentUserName");
    const logoutBtn = document.getElementById("logoutBtn");

    const response = await fetch(CLIENT_API.currentUser);
    const result = await response.json();
    currentUserName.textContent = result.user.name;

    logoutBtn.addEventListener("click", async () => {
        await fetch(CLIENT_API.logout, { method: "POST" });
        window.location.href = loginPage;
    });
}

async function loadAutocompleteSuggestions(inputId, query) {
    const url = `${CLIENT_API.photon}?q=${encodeURIComponent(query)}&limit=5&lat=5.5&lon=12.3`;
    const response = await fetch(url);
    const data = await response.json();

    const features = data.features.filter((feature) => {
        const country = (feature.properties.country || "").toLowerCase();
        const countryCode = (feature.properties.country_code || "").toLowerCase();
        return country.includes("cam") || countryCode === "cm" || !country;
    });

    renderSuggestions(inputId, features);
}

async function findRoute() {
    const pickupText = document.getElementById("pickup").value.trim();
    const destinationText = document.getElementById("destination").value.trim();

    if (!destinationCoords) {
        destinationCoords = await geocodeAddress(destinationText);
        updateMarker("destination", destinationCoords.lat, destinationCoords.lng);
    }

    const url = `${CLIENT_API.osrmRoute}/${pickupCoords.lng},${pickupCoords.lat};${destinationCoords.lng},${destinationCoords.lat}?overview=full&geometries=geojson`;
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
    const url = `${CLIENT_API.photon}?q=${encodeURIComponent(query)}&limit=1`;
    const response = await fetch(url);
    const data = await response.json();
    const feature = data.features[0];

    return {
        lat: feature.geometry.coordinates[1],
        lng: feature.geometry.coordinates[0]
    };
}

async function reverseGeocode(lat, lng) {
    const url = `${CLIENT_API.nominatimReverse}?format=json&lat=${lat}&lon=${lng}`;
    const response = await fetch(url);
    const data = await response.json();
    return data.display_name;
}

async function sendToBackend(data) {
    const response = await fetch(CLIENT_API.createRide, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });

    const result = await response.json();
    currentRideId = result.ride_id;
    startRideTracking();
    showWaitingMessage();
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
    const response = await fetch(`${CLIENT_API.rideStatus}?ride_id=${currentRideId}`);
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
    const response = await fetch(`${CLIENT_API.driverLocation}?ride_id=${currentRideId}`);
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
    const url = `${CLIENT_API.osrmRoute}/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    return data.routes[0].geometry;
}

async function loadUserRides() {
    const response = await fetch(CLIENT_API.userRides);
    userRides = await response.json();
    displayRides();
}

async function drawRouteOnMap(fromCoords, toCoords) {
    const url = `${CLIENT_API.osrmRoute}/${fromCoords.lng},${fromCoords.lat};${toCoords.lng},${toCoords.lat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    const route = data.routes[0];

    if (routeLayer) map.removeLayer(routeLayer);

    routeLayer = L.geoJSON(route.geometry, {
        style: { color: "#27ae60", weight: 6, opacity: 0.8 }
    }).addTo(map);
}
