let map;
let driverMarker;
let currentRide = null;
let allRides = [];
let rideMarkers = [];
let destinationMarkers = [];
let destinationMap = new Map();
let routeLayers = [];
let routeCache = new Map();
let isUpdatingRoutes = false;

document.addEventListener("DOMContentLoaded", () => {
    initUserHeader("login.html");
    initMap();

    setTimeout(() => {
        map.invalidateSize();
    }, 500);

    setInterval(checkNewRides, 5000);
    setInterval(updateDriverPosition, 10000);

    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            const tabId = btn.dataset.tab;

            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

            btn.classList.add("active");
            document.getElementById(tabId).classList.add("active");

            if (tabId === "dashboardTab") {
                await checkNewRides();
                updateDashboard();
            }

            if (tabId === "chauffeurTab") {
                setTimeout(() => {
                    if (map) map.invalidateSize();
                }, 50);
            }
        });
    });

    document.getElementById("refreshBtn").addEventListener("click", () => {
        checkNewRides();
        updateDashboard();
    });
});

function initMap() {
    map = L.map("map").setView([4.05, 9.76], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

    navigator.geolocation.watchPosition((pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        if (!driverMarker) {
            driverMarker = L.marker([lat, lng], {
                icon: L.divIcon({
                    html: "🚕",
                    className: "driver-marker",
                    iconSize: [40, 40],
                    iconAnchor: [20, 40]
                })
            }).addTo(map);
        } else {
            driverMarker.setLatLng([lat, lng]);
        }

        map.setView([lat, lng], 15);
    });
}

function updateRideLists() {
    const pendingContainer = document.getElementById("pendingRides");
    const acceptedContainer = document.getElementById("acceptedRides");

    pendingContainer.innerHTML = "";
    acceptedContainer.innerHTML = "";

    const pendingRides = allRides.filter(ride => ride.status === "pending");
    const acceptedRides = allRides.filter(ride => ride.status === "accepted");

    if (pendingRides.length === 0) {
        pendingContainer.innerHTML = '<div class="empty-state">Aucune course en attente</div>';
    } else {
        pendingRides.forEach(ride => {
            const rideCard = createRideCard(ride, "pending");
            pendingContainer.appendChild(rideCard);
        });
    }

    if (acceptedRides.length === 0) {
        acceptedContainer.innerHTML = '<div class="empty-state">Aucune course acceptée</div>';
    } else {
        acceptedRides.forEach(ride => {
            const rideCard = createRideCard(ride, "accepted");
            acceptedContainer.appendChild(rideCard);
        });
    }
}

async function updateRideMarkers() {
    if (isUpdatingRoutes) return;
    isUpdatingRoutes = true;

    try {
        const driverPos = driverMarker ? driverMarker.getLatLng() : null;
        if (!driverPos) return;

        const driverLat = driverPos.lat;
        const driverLng = driverPos.lng;
        const acceptedRides = allRides.filter(ride => ride.status === "accepted");
        const acceptedRideIds = new Set(acceptedRides.map(r => r.id));

        routeCache.forEach((_, rideId) => {
            if (!acceptedRideIds.has(rideId)) {
                routeCache.delete(rideId);
            }
        });

        rideMarkers.forEach(marker => map.removeLayer(marker));
        rideMarkers = [];

        destinationMarkers.forEach(marker => map.removeLayer(marker));
        destinationMarkers = [];

        destinationMap.clear();

        for (const ride of acceptedRides) {
            const pickupLat = parseFloat(ride.pickup_lat);
            const pickupLng = parseFloat(ride.pickup_lng);
            const destLat = parseFloat(ride.destination_lat);
            const destLng = parseFloat(ride.destination_lng);

            if (isNaN(pickupLat) || isNaN(pickupLng) || isNaN(destLat) || isNaN(destLng)) {
                continue;
            }

            const pickupMarker = L.marker([pickupLat, pickupLng], {
                icon: L.divIcon({
                    html: "📍",
                    className: "pickup-marker",
                    iconSize: [30, 30],
                    iconAnchor: [15, 30]
                })
            }).addTo(map).bindPopup(`<strong>Départ - Course #${ride.id}</strong><br>${ride.pickup}`);

            rideMarkers.push(pickupMarker);

            const destKey = `${destLat},${destLng}`;

            if (!destinationMap.has(destKey)) {
                const destMarker = L.marker([destLat, destLng], {
                    icon: L.icon({
                        iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
                        shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
                        iconSize: [25, 41],
                        iconAnchor: [12, 41],
                        popupAnchor: [1, -34],
                        shadowSize: [41, 41]
                    })
                }).addTo(map);

                destinationMarkers.push(destMarker);
                destinationMap.set(destKey, { marker: destMarker, count: 1, rides: [ride.id], destination: ride.destination });
            } else {
                const destInfo = destinationMap.get(destKey);
                destInfo.count += 1;
                destInfo.rides.push(ride.id);
            }

            const cacheKey = `${ride.id}`;
            let needsUpdate = true;

            if (routeCache.has(cacheKey)) {
                const cached = routeCache.get(cacheKey);
                const distance = getDistanceFromLatLng(
                    driverLat, driverLng,
                    cached.driverLat, cached.driverLng
                );

                if (distance < 0.1) {
                    needsUpdate = false;
                    if (cached.layers) {
                        cached.layers.forEach(layer => layer.addTo(map));
                    }
                }
            }

            if (needsUpdate) {
                try {
                    const pickupRoute = await calculateRoute(driverLng, driverLat, pickupLng, pickupLat);
                    const destRoute = await calculateRoute(pickupLng, pickupLat, destLng, destLat);
                    const layers = [];

                    if (pickupRoute) {
                        const pickupLayer = L.geoJSON(pickupRoute, {
                            style: {
                                color: "#f39c12",
                                weight: 5,
                                opacity: 0.8
                            }
                        }).addTo(map);
                        layers.push(pickupLayer);
                        routeLayers.push(pickupLayer);
                    }

                    if (destRoute) {
                        const destLayer = L.geoJSON(destRoute, {
                            style: {
                                color: "#27ae60",
                                weight: 5,
                                opacity: 0.8
                            }
                        }).addTo(map);
                        layers.push(destLayer);
                        routeLayers.push(destLayer);
                    }

                    routeCache.set(cacheKey, {
                        driverLat,
                        driverLng,
                        layers,
                        timestamp: Date.now()
                    });
                } catch (error) {
                    console.error("Erreur calcul route pour course", ride.id, error);
                }
            }
        }

        destinationMap.forEach((destInfo) => {
            const coursesText = destInfo.count > 1
                ? `${destInfo.count} courses vers cette destination<br>Courses: ${destInfo.rides.join(", ")}`
                : `Course #${destInfo.rides[0]}`;

            destInfo.marker.bindPopup(`<strong>Destination</strong><br>${destInfo.destination}<br>${coursesText}`);
        });
    } finally {
        isUpdatingRoutes = false;
    }
}

function createRideCard(ride, status) {
    const card = document.createElement("div");
    card.className = `ride-card ${status}`;

    let actions = "";
    if (status === "pending") {
        actions = `<button class="btn btn-accept" onclick="acceptRide(${ride.id})">Accepter</button>
                   <button class="btn btn-refuse" onclick="refuseRide(${ride.id})">Refuser</button>`;
    } else if (status === "accepted") {
        actions = `<button class="btn btn-cancel" onclick="cancelRide(${ride.id})">Annuler</button>
                   <button class="btn btn-complete" onclick="completeRide(${ride.id})">Terminée</button>`;
    }

    const statusText = status === "accepted" ? "Acceptée" : status === "completed" ? "Terminée" : "En attente";

    card.innerHTML = `
        <h4>Course #${ride.id}</h4>
        <p><strong>📍 Départ:</strong> ${ride.pickup}</p>
        <p><strong>➡️ Arrivée:</strong> ${ride.destination}</p>
        <p><strong>👥 Passagers:</strong> ${ride.passengers}</p>
        <p><strong>📏 Distance:</strong> ${ride.distance_km} km</p>
        <p><strong>💰 Prix:</strong> ${ride.price_fcfa} FCFA</p>
        <span class="ride-status ${status}">${statusText}</span>
        ${actions ? `<div class="actions">${actions}</div>` : ""}
    `;

    return card;
}

function updateDashboard() {
    const completedRides = allRides.filter(ride => ride.status === "completed");
    const acceptedRides = allRides.filter(ride => ride.status === "accepted");

    document.getElementById("statsCompleted").textContent = completedRides.length;

    const totalAmount = completedRides.reduce((sum, ride) => sum + parseInt(ride.price_fcfa), 0);
    document.getElementById("statsTotal").textContent = totalAmount.toLocaleString() + " FCFA";

    const averageAmount = completedRides.length > 0 ? Math.round(totalAmount / completedRides.length) : 0;
    document.getElementById("statsAverage").textContent = averageAmount.toLocaleString() + " FCFA";

    const totalDistance = completedRides.reduce((sum, ride) => sum + parseFloat(ride.distance_km), 0);
    document.getElementById("statsDistance").textContent = totalDistance.toFixed(1) + " km";

    document.getElementById("statsAccepted").textContent = acceptedRides.length;

    const completedContainer = document.getElementById("completedRides");
    if (completedContainer) {
        completedContainer.innerHTML = "";

        if (completedRides.length === 0) {
            completedContainer.innerHTML = '<div class="empty-state">Aucune course terminée</div>';
        } else {
            completedRides.forEach(ride => {
                const rideCard = createRideCard(ride, "completed");
                completedContainer.appendChild(rideCard);
            });
        }
    }
}
