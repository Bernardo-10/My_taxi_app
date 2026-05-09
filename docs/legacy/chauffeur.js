let map;
let driverMarker;
let currentRide = null;
let allRides = [];
let rideMarkers = []; // Pour stocker les marqueurs des courses acceptées
let destinationMarkers = []; // Pour stocker les marqueurs de destination
let destinationMap = new Map(); // Pour regrouper les destinations identiques
let routeLayers = []; // Pour stocker les couches de routes
let routeCache = new Map(); // Cache pour éviter les recalculs inutiles {rideId: {routes: {...}, timestamp: ...}}
let isUpdatingRoutes = false; // Flag pour éviter les mises à jour simultanées

// 🚀 INIT
document.addEventListener("DOMContentLoaded", () => {
    initUserHeader("login_chauffeur.html");
    initMap();
    setTimeout(() => {
        map.invalidateSize();
    }, 500);
    setInterval(checkNewRides, 5000);
    setInterval(updateDriverPosition, 10000); // Mise à jour position toutes les 10 secondes

    // Gestion des onglets
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tabId = btn.dataset.tab;

            // Changer l'onglet actif
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(tabId).classList.add('active');

            // Rafraîchir les données selon l'onglet
            if (tabId === 'dashboardTab') {
                // Force un refresh pour que le dashboard ait toujours les bons paramètres
                await checkNewRides();
                updateDashboard();
            }

            if (tabId === 'chauffeurTab') {
                // Leaflet a besoin d'un invalidateSize quand la carte sort de display:none
                setTimeout(() => {
                    if (map) map.invalidateSize();
                }, 50);
            }
        });
    });

    // Bouton rafraîchir
    document.getElementById('refreshBtn').addEventListener('click', () => {
        checkNewRides();
        updateDashboard();
    });
});

// 🗺️ MAP
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

// MAP
function initMap() {
    map = L.map("map").setView([4.05, 9.76], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

    navigator.geolocation.watchPosition((pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        if (!driverMarker) {
            driverMarker = L.marker([lat, lng], {
                icon: L.divIcon({
                    html: '🚕',
                    className: 'driver-marker',
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

// 🔔 CHECK RIDES
async function checkNewRides() {
    const res = await fetch("get_rides.php");
    if (res.status === 401) {
        window.location.href = "login_chauffeur.html";
        return;
    }
    const rides = await res.json();

    allRides = rides;
    updateRideLists();
    updateRideMarkers(); // Ajouter les marqueurs des courses acceptées

    // Si l'onglet dashboard est actif, on met aussi à jour ses paramètres
    const dashboardTabEl = document.getElementById('dashboardTab');
    if (dashboardTabEl && dashboardTabEl.classList.contains('active')) {
        updateDashboard();
    }
}

// 📋 UPDATE LISTS
function updateRideLists() {
    const pendingContainer = document.getElementById("pendingRides");
    const acceptedContainer = document.getElementById("acceptedRides");

    pendingContainer.innerHTML = "";
    acceptedContainer.innerHTML = "";

    const pendingRides = allRides.filter(ride => ride.status === 'pending');
    const acceptedRides = allRides.filter(ride => ride.status === 'accepted');

    if (pendingRides.length === 0) {
        pendingContainer.innerHTML = '<div class="empty-state">Aucune course en attente</div>';
    } else {
        pendingRides.forEach(ride => {
            const rideCard = createRideCard(ride, 'pending');
            pendingContainer.appendChild(rideCard);
        });
    }

    if (acceptedRides.length === 0) {
        acceptedContainer.innerHTML = '<div class="empty-state">Aucune course acceptée</div>';
    } else {
        acceptedRides.forEach(ride => {
            const rideCard = createRideCard(ride, 'accepted');
            acceptedContainer.appendChild(rideCard);
        });
    }
}

// 🗺️ UPDATE RIDE MARKERS AND ROUTES
async function updateRideMarkers() {
    // Éviter les mises à jour simultanées
    if (isUpdatingRoutes) return;
    isUpdatingRoutes = true;

    try {
        const driverPos = driverMarker ? driverMarker.getLatLng() : null;
        if (!driverPos) return;

        const driverLat = driverPos.lat;
        const driverLng = driverPos.lng;

        // Traiter les courses acceptées
        const acceptedRides = allRides.filter(ride => ride.status === 'accepted');
        const acceptedRideIds = new Set(acceptedRides.map(r => r.id));

        // Nettoyer les routes des courses qui ne sont plus acceptées
        routeCache.forEach((_, rideId) => {
            if (!acceptedRideIds.has(rideId)) {
                routeCache.delete(rideId);
            }
        });

        // Gérer les marqueurs
        rideMarkers.forEach(marker => map.removeLayer(marker));
        rideMarkers = [];
        
        destinationMarkers.forEach(marker => map.removeLayer(marker));
        destinationMarkers = [];
        
        destinationMap.clear();

        // Ajouter les marqueurs et routes
        for (const ride of acceptedRides) {
            const pickupLat = parseFloat(ride.pickup_lat);
            const pickupLng = parseFloat(ride.pickup_lng);
            const destLat = parseFloat(ride.destination_lat);
            const destLng = parseFloat(ride.destination_lng);

            if (isNaN(pickupLat) || isNaN(pickupLng) || isNaN(destLat) || isNaN(destLng)) {
                continue;
            }

            // 1. Marqueur de départ (pickup)
            const pickupMarker = L.marker([pickupLat, pickupLng], {
                icon: L.divIcon({
                    html: '📍',
                    className: 'pickup-marker',
                    iconSize: [30, 30],
                    iconAnchor: [15, 30]
                })
            }).addTo(map).bindPopup(`<strong>Départ - Course #${ride.id}</strong><br>${ride.pickup}`);

            rideMarkers.push(pickupMarker);

            // 2. Marqueur de destination - regrouper les destinations identiques
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

            // 3. Vérifier si les routes ont changé pour cette course
            const cacheKey = `${ride.id}`;
            let needsUpdate = true;

            if (routeCache.has(cacheKey)) {
                const cached = routeCache.get(cacheKey);
                // Vérifier si la position du chauffeur a changé significativement (> 100m)
                const distance = getDistanceFromLatLng(
                    driverLat, driverLng,
                    cached.driverLat, cached.driverLng
                );
                if (distance < 0.1) { // Moins de 100m
                    needsUpdate = false;
                    // Re-ajouter les couches de route existantes sans recalculer
                    if (cached.layers) {
                        cached.layers.forEach(layer => layer.addTo(map));
                    }
                }
            }

            // Si mise à jour nécessaire, recalculer les routes
            if (needsUpdate) {
                try {
                    const pickupRoute = await calculateRoute(driverLng, driverLat, pickupLng, pickupLat);
                    const destRoute = await calculateRoute(pickupLng, pickupLat, destLng, destLat);

                    const layers = [];

                    if (pickupRoute) {
                        const pickupLayer = L.geoJSON(pickupRoute, {
                            style: {
                                color: '#f39c12',
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
                                color: '#27ae60',
                                weight: 5,
                                opacity: 0.8
                            }
                        }).addTo(map);
                        layers.push(destLayer);
                        routeLayers.push(destLayer);
                    }

                    // Mettre en cache
                    routeCache.set(cacheKey, {
                        driverLat,
                        driverLng,
                        layers,
                        timestamp: Date.now()
                    });
                } catch (error) {
                    console.error('Erreur calcul route pour course', ride.id, error);
                }
            }
        }

        // Mettre à jour les popups des destinations
        destinationMap.forEach((destInfo) => {
            const coursesText = destInfo.count > 1 
                ? `${destInfo.count} courses vers cette destination<br>Courses: ${destInfo.rides.join(', ')}`
                : `Course #${destInfo.rides[0]}`;
            
            destInfo.marker.bindPopup(`<strong>Destination</strong><br>${destInfo.destination}<br>${coursesText}`);
        });

        // Note: La vue de la carte n'est plus ajustée automatiquement pour permettre à l'utilisateur de contrôler le zoom et la position
    } finally {
        isUpdatingRoutes = false;
    }
}

// 📏 HELPER: Calculer la distance entre deux points (en km)
function getDistanceFromLatLng(lat1, lng1, lat2, lng2) {
    const R = 6371; // Rayon de la Terre en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// 🛣️ CALCULATE ROUTE
async function calculateRoute(startLng, startLat, endLng, endLat) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.routes && data.routes.length > 0) {
            return data.routes[0].geometry;
        }
    } catch (error) {
        console.error('Erreur calcul route:', error);
    }

    return null;
}
function createRideCard(ride, status) {
    const card = document.createElement("div");
    card.className = `ride-card ${status}`;

    let actions = '';
    if (status === 'pending') {
        actions = `<button class="btn btn-accept" onclick="acceptRide(${ride.id})">Accepter</button>
                   <button class="btn btn-refuse" onclick="refuseRide(${ride.id})">Refuser</button>`;
    } else if (status === 'accepted') {
        actions = `<button class="btn btn-cancel" onclick="cancelRide(${ride.id})">Annuler</button>
                   <button class="btn btn-complete" onclick="completeRide(${ride.id})">Terminée</button>`;
    }

    const statusText = status === 'accepted' ? 'Acceptée' : status === 'completed' ? 'Terminée' : 'En attente';

    card.innerHTML = `
        <h4>Course #${ride.id}</h4>
        <p><strong>📍 Départ:</strong> ${ride.pickup}</p>
        <p><strong>➡️ Arrivée:</strong> ${ride.destination}</p>
        <p><strong>👥 Passagers:</strong> ${ride.passengers}</p>
        <p><strong>📏 Distance:</strong> ${ride.distance_km} km</p>
        <p><strong>💰 Prix:</strong> ${ride.price_fcfa} FCFA</p>
        <span class="ride-status ${status}">${statusText}</span>
        ${actions ? `<div class="actions">${actions}</div>` : ''}
    `;

    return card;
}

// 📍 UPDATE DRIVER POSITION
async function updateDriverPosition() {
    try {
        if (driverMarker) {
            navigator.geolocation.getCurrentPosition(
                async (pos) => {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;

                    console.log(`📍 Position mise à jour: Lat=${lat}, Lng=${lng}`);

                    driverMarker.setLatLng([lat, lng]);

                    // Envoyer la position à la base de données pour les courses acceptées
                    await updateDriverPositionInDB(lat, lng);
                },
                (err) => {
                    console.warn("⚠️ Erreur GPS lors de la mise à jour:", err.message);
                }
            );
        }
    } catch (error) {
        console.error('❌ Erreur mise à jour position chauffeur:', error);
    }
}

// 💾 UPDATE POSITION IN DATABASE
async function updateDriverPositionInDB(lat, lng) {
    try {
        // Récupérer les courses acceptées par ce chauffeur
        const ridesResponse = await fetch('get_rides.php');
        const rides = await ridesResponse.json();

        const acceptedRides = rides.filter(ride => ride.status === 'accepted');

        console.log(`🚗 Mise à jour ${acceptedRides.length} course(s) acceptée(s)`);

        // Mettre à jour la position pour chaque course acceptée
        for (const ride of acceptedRides) {
            try {
                const response = await fetch(`update_ride_driver_position.php?ride_id=${ride.id}&lat=${lat}&lng=${lng}`);
                const result = await response.json();
                
                if (result.status === "success") {
                    console.log(`✅ Position mise à jour pour la course #${ride.id}`);
                } else {
                    console.warn(`⚠️ Erreur mise à jour course #${ride.id}:`, result.message);
                }
            } catch (error) {
                console.error(`❌ Erreur pour course #${ride.id}:`, error);
            }
        }
    } catch (error) {
        console.error('❌ Erreur mise à jour position en base:', error);
    }
}

// ✅ ACCEPT
async function acceptRide(id) {
    console.log("🎯 Tentative d'acceptation de la course:", id);
    
    // Récupérer la position GPS réelle du chauffeur au moment de l'acceptation
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const driverLat = pos.coords.latitude;
            const driverLng = pos.coords.longitude;
            const accuracy = pos.coords.accuracy;

            console.log(`✅ Position GPS obtenue: Lat=${driverLat}, Lng=${driverLng}, Accuracy=${accuracy}m`);

            try {
                const response = await fetch("accept_ride.php", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({ id, driver_lat: driverLat, driver_lng: driverLng })
                });

                const result = await response.json();
                console.log("📡 Réponse serveur:", result);

                if (result.status === "ok") {
                    alert("Course acceptée 🚕");
                    checkNewRides();
                } else {
                    alert("Erreur: " + (result.message || "Impossible d'accepter la course"));
                }
            } catch (error) {
                console.error("❌ Erreur lors de l'envoi:", error);
                alert("Erreur de connexion au serveur");
            }
        },
        (err) => {
            console.error("❌ Géolocalisation échouée:", err);
            console.error("Code erreur:", err.code, "Message:", err.message);
            alert("Impossible de récupérer votre position. Activez le GPS et acceptez l'accès à la localisation.");
        },
        { 
            enableHighAccuracy: true, 
            timeout: 10000, 
            maximumAge: 0 
        }
    );
}

// ❌ REFUSE
async function refuseRide(id) {
    await fetch("refuse_ride.php", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id })
    });

    alert("Course refusée");
    checkNewRides(); // Refresh lists and markers
}

// 🚫 CANCEL
async function cancelRide(id) {
    await fetch("cancel_ride.php", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id })
    });

    alert("Course annulée");
    checkNewRides(); // Refresh lists and markers
}

// ✅ COMPLETE
async function completeRide(id) {
    await fetch("complete_ride.php", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ id })
    });

    alert("Course terminée ✅");
    checkNewRides(); // Refresh lists and markers
    updateDashboard(); // Update dashboard stats
}

// 📊 UPDATE DASHBOARD
function updateDashboard() {
    const completedRides = allRides.filter(ride => ride.status === 'completed');
    const acceptedRides = allRides.filter(ride => ride.status === 'accepted');

    // Nombre de courses terminées
    document.getElementById('statsCompleted').textContent = completedRides.length;

    // Montant total
    const totalAmount = completedRides.reduce((sum, ride) => sum + parseInt(ride.price_fcfa), 0);
    document.getElementById('statsTotal').textContent = totalAmount.toLocaleString() + ' FCFA';

    // Montant moyen
    const averageAmount = completedRides.length > 0 ? Math.round(totalAmount / completedRides.length) : 0;
    document.getElementById('statsAverage').textContent = averageAmount.toLocaleString() + ' FCFA';

    // Distance totale
    const totalDistance = completedRides.reduce((sum, ride) => sum + parseFloat(ride.distance_km), 0);
    document.getElementById('statsDistance').textContent = totalDistance.toFixed(1) + ' km';

    // Courses acceptées en cours
    document.getElementById('statsAccepted').textContent = acceptedRides.length;

    // Afficher l'historique des courses terminées
    const completedContainer = document.getElementById("completedRides");
    if (completedContainer) {
        completedContainer.innerHTML = "";

        if (completedRides.length === 0) {
            completedContainer.innerHTML = '<div class="empty-state">Aucune course terminée</div>';
        } else {
            completedRides.forEach(ride => {
                const rideCard = createRideCard(ride, 'completed');
                completedContainer.appendChild(rideCard);
            });
        }
    }
}
