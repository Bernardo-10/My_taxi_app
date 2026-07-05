const CLIENT_API_BASE = "/backend";

async function initUserHeader(loginPage) {
    const currentUserName = document.getElementById("currentUserName");
    const logoutBtn = document.getElementById("logoutBtn");

    try {
        const response = await fetch(`${CLIENT_API_BASE}/common/current_user.php`);
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
                await fetch(`${CLIENT_API_BASE}/common/logout.php`, { method: "POST" });
            } finally {
                window.location.href = loginPage;
            }
        });
    }
}

async function loadAutocompleteSuggestions(inputId, query) {
    try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lat=5.5&lon=12.3`;
        const response = await fetch(url);
        const data = await response.json();

        let features = data.features || [];
        features = features.filter(f => {
            const country = (f.properties.country || "").toLowerCase();
            const countryCode = (f.properties.country_code || "").toLowerCase();
            return country.includes("cam") || countryCode === "cm" || !country;
        });

        renderSuggestions(inputId, features);
    } catch (error) {
        console.error("Erreur autocomplete :", error);
    }
}

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
        const passengers = parseInt(document.getElementById("passengers")?.value, 10) || 1;
        const basePrice = distanceKm * 75;
        const totalPrice = basePrice * passengers;
        const priceFcfa = Math.round(totalPrice);

        // Stocker la géométrie sans tracer sur la carte (le tracé vert
        // n'apparaîtra que pendant la course — état "started")
        if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }

        // Ajuster la vue sur pickup ↔ destination sans tracer de ligne
        if (pickupCoords && destinationCoords) {
            map.fitBounds(L.latLngBounds(
                [pickupCoords.lat, pickupCoords.lng],
                [destinationCoords.lat, destinationCoords.lng]
            ), { padding: [40, 40] });
        }

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
            passengers: passengers
        });
    } catch (error) {
        console.error("Erreur itinéraire :", error);
        alert("Erreur lors du calcul.");
    }
}

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

async function sendToBackend(data) {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/backend.php`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.status === 401) {
            window.location.href = "/client/login";
            return result;
        }

        if (result.status === "success" && result.ride_id) {
            currentRideId = result.ride_id;
            showWaitingMessage();
            startRideTracking();

            const cancelBtn = document.getElementById("cancelRideBtn");
            if (cancelBtn) {
                cancelBtn.style.display = "block";
                cancelBtn.disabled = false;
            }
        }

        // Une course active existe déjà côté serveur (double onglet, double-clic...) :
        // au lieu de laisser l'échec silencieux, on rebascule sur cette course
        // existante via la même logique que la reprise après rafraîchissement.
        if (response.status === 409 && result.existing_ride_id) {
            if (typeof showToast === "function") {
                showToast("Une course est déjà en cours");
            }
            if (typeof initActiveRideRecovery === "function") {
                await initActiveRideRecovery();
            }
        }

        return result;
    } catch (error) {
        console.error("Erreur backend:", error);
        return { status: "error", message: "Erreur de connexion" };
    }
}

// Appelée une seule fois au chargement de la page (voir initActiveRideRecovery
// dans client-ui.js) pour savoir si une course est toujours en cours côté serveur
// après un rafraîchissement forcé.
async function fetchActiveRide() {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/get_active_ride.php`);
        const result = await response.json();

        if (response.status === 401) {
            window.location.href = "/client/login";
            return null;
        }

        if (result.status !== "success" || !result.has_active_ride) {
            return null;
        }

        return result;
    } catch (error) {
        console.error("Erreur récupération course active:", error);
        return null;
    }
}

// ── CHAUFFEURS DISPONIBLES (chantier 3, v4) ────────────────────────
// Appelée en boucle par startNearbyDriversPolling() (client-ui.js) tant que
// AppState.rideState === "idle". Retourne uniquement les chauffeurs
// réellement disponibles (filtré côté serveur, voir nearby_drivers.php) :
// pas de téléphone, pas de chauffeurs en course.
async function fetchNearbyDrivers() {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/nearby_drivers.php`);
        const result = await response.json();

        if (result.status !== "success") return [];
        return result.drivers || [];
    } catch (error) {
        console.error("Erreur récupération chauffeurs à proximité:", error);
        return [];
    }
}

function startRideTracking() {
    if (rideStatusCheckInterval) {
        clearInterval(rideStatusCheckInterval);
    }

    const cancelBtn = document.getElementById("cancelRideBtn");
    if (cancelBtn) {
        cancelBtn.style.display = "block";
        cancelBtn.disabled = false;
    }

    rideAccepted = false;
    updateRideStatusMessage("En attente d'acceptation du chauffeur...");
    checkRideStatus();
    rideStatusCheckInterval = setInterval(checkRideStatus, 5000);

    if (driverStatusInterval) {
        clearInterval(driverStatusInterval);
    }

    // Premier appel immédiat, puis toutes les 10s (était 20s — trop long)
    driverStatusInterval = setInterval(updateDriverPosition, 10000);
}

async function checkRideStatus(forceRefresh = false) {
    if (!currentRideId) return null;

    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/check_ride_status.php?ride_id=${currentRideId}`);
        const result = await response.json();

        if (result.status !== "success") {
            updateRideStatusMessage("Impossible de vérifier le statut de la course.");
            return null;
        }

        const rideData = {
            status: result.ride_status,
            driver: {
                name: result.driver_name || "Votre chauffeur",
                plate: result.driver_plate || "-",
                color: result.driver_color || "",
                rating: result.driver_rating || "4.8",
                phone: result.driver_phone || result.driver_tel || "",
                lat: parseFloat(result.driver_lat),
                lng: parseFloat(result.driver_lng)
            },
            pickup: {
                lat: parseFloat(result.pickup_lat),
                lng: parseFloat(result.pickup_lng)
            },
            destination: {
                lat: parseFloat(result.destination_lat),
                lng: parseFloat(result.destination_lng)
            }
        };

        // Appeler la fonction UI pour mettre à jour l'affichage selon le statut
        if (typeof onRideStatusUpdate === "function") {
            onRideStatusUpdate(rideData);
        }

        // Gestion des transitions
        if (rideData.status === "accepted" && !rideAccepted) {
            rideAccepted = true;
            onRideAccepted(rideData.driver);
        } 
        else if (rideData.status === "arrived") {
            rideAccepted = true;
            if (typeof onRideArrived === "function") onRideArrived(rideData);
        }
        else if (rideData.status === "started") {
            rideAccepted = true;
            // On notifie l'UI que la course a commencé
            if (typeof onRideStarted === "function") onRideStarted(rideData);
        }
        else if (rideData.status === "completed") {
            clearInterval(rideStatusCheckInterval); rideStatusCheckInterval = null;
            clearInterval(driverStatusInterval);    driverStatusInterval = null;
            if (typeof onRideCompleted === "function") onRideCompleted();
        }
        else if (rideData.status === "cancelled_client" || rideData.status === "cancelled") {
            clearInterval(rideStatusCheckInterval); rideStatusCheckInterval = null;
            clearInterval(driverStatusInterval);    driverStatusInterval = null;
            if (typeof onRideCancelled === "function") onRideCancelled();
        }

        return rideData;
    } catch (error) {
        console.error("Erreur vérification statut de course:", error);
        updateRideStatusMessage("Erreur lors de la vérification du statut.");
        return null;
    }
}

// Vrai tant qu'une course est en cours et n'a pas été nettoyée entre-temps
// (onRideCompleted/onRideCancelled). Sert à re-vérifier après un await, car
// clearInterval() n'annule pas un appel déjà en vol au moment du cleanup.
function rideStillActive() {
    return !!currentRideId && typeof AppState !== "undefined" && AppState.rideState !== "idle";
}

async function updateDriverPosition() {
    if (!currentRideId || !rideAccepted) {
        return;
    }

    // Bail-out si la course est déjà terminée/annulée (appel async en vol après cleanup)
    if (typeof AppState !== "undefined" && AppState.rideState === "idle") {
        return;
    }

    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/get_driver_location.php?ride_id=${currentRideId}`);
        const data = await response.json();

        // Re-vérifier après l'await : un onRideCompleted()/onRideCancelled() a pu
        // nettoyer (resetMapPanel) pendant l'attente réseau. Sans ce re-check, on
        // recrée le marqueur taxi + son popup juste après leur suppression.
        if (!rideStillActive()) return;

        if (data.status !== "success") {
            updateRideStatusMessage("Attente de la position du chauffeur...");
            return;
        }

        const driverLat = parseFloat(data.driver_lat);
        const driverLng = parseFloat(data.driver_lng);

        if (isNaN(driverLat) || isNaN(driverLng)) {
            updateRideStatusMessage("Position chauffeur invalide");
            return;
        }

        // Déclarer state en premier — utilisé à la fois pour le popup et les tracés
        const state = (typeof AppState !== "undefined") ? AppState.rideState : "accepted";

        // Texte du popup selon l'état courant
        const popupTexts = {
            accepted: "Il arrive vers vous !",
            arrived:  "Il est arrivé ✅",
            started:  "Course commencée 🚗"
        };
        const popupMsg = popupTexts[state] || "Il arrive vers vous !";

        // Marqueur taxi — uniquement pour accepted et arrived (en started, le client est dans le taxi)
        if (state !== "started") {
            if (driverPositionMarker) {
                driverPositionMarker.setLatLng([driverLat, driverLng]);
                driverPositionMarker.setPopupContent(`<strong>Votre chauffeur</strong><br>${popupMsg}`);
            } else {
                const taxiIcon = L.divIcon({
                    html: '<div class="driver-marker-dot" aria-label="Chauffeur">🚕</div>',
                    className: "driver-marker-icon",
                    iconSize: [40, 40],
                    iconAnchor: [20, 40],
                    popupAnchor: [0, -40]
                });
                driverPositionMarker = L.marker([driverLat, driverLng], { icon: taxiIcon })
                    .addTo(map)
                    .bindPopup(`<strong>Votre chauffeur</strong><br>${popupMsg}`);
                driverPositionMarker.openPopup();
            }
        }

        const posChanged = (lastDriverLat === null) ||
            (Math.abs(driverLat - lastDriverLat) > 0.00005) ||
            (Math.abs(driverLng - lastDriverLng) > 0.00005);

        lastDriverLat = driverLat;
        lastDriverLng = driverLng;

        if (state === "accepted") {
            // ── Chauffeur → Pickup : ligne bleue pleine (crossfade, sans clignotement)
            if (pickupCoords && posChanged) {
                const route = await getRouteGeoJSON(driverLng, driverLat, pickupCoords.lng, pickupCoords.lat);
                if (route && rideStillActive()) {
                    if (typeof updateDriverETA === "function") updateDriverETA(route.distance, route.duration);
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#3b82f6", weight: 5, opacity: 0.9, dashArray: null }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            }

        } else if (state === "arrived") {
            // ── Chauffeur → Client : vraie route OSRM en pointillés gris
            // On trace si la position a changé OU si le tracé n'existe pas encore
            if (pickupCoords && (posChanged || !driverRouteLayer)) {
                const route = await getRouteGeoJSON(driverLng, driverLat, pickupCoords.lng, pickupCoords.lat);
                if (route && rideStillActive()) {
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#9ca3af", weight: 4, opacity: 0.85, dashArray: "8, 10" }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            }

        } else if (state === "started") {
            // ── Client (pickup) → Destination : ligne verte pleine
            // pickupCoords est mis à jour en temps réel par watchUserPosition
            // On force le tracé à chaque appel si le tracé n'existe pas encore
            if (destinationCoords && pickupCoords && !driverRouteLayer) {
                const route = await getRouteGeoJSON(pickupCoords.lng, pickupCoords.lat, destinationCoords.lng, destinationCoords.lat);
                if (route && rideStillActive()) {
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#1db954", weight: 5, opacity: 0.9, dashArray: null }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            } else if (destinationCoords && pickupCoords && posChanged) {
                // Recalcul si le chauffeur (et donc le client) a bougé significativement
                const route = await getRouteGeoJSON(pickupCoords.lng, pickupCoords.lat, destinationCoords.lng, destinationCoords.lat);
                if (route && rideStillActive()) {
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#1db954", weight: 5, opacity: 0.9, dashArray: null }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            }
        }

    } catch (error) {
        console.error("Erreur mise à jour position chauffeur:", error);
    }
}

async function getRouteGeoJSON(startLng, startLat, endLng, endLat) {
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
        const response = await fetch(url);
        const data = await response.json();
        return data.routes && data.routes[0] ? data.routes[0] : null;
    } catch (error) {
        console.error("Erreur OSRM route:", error);
        return null;
    }
}

async function loadUserRides() {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/get_user_rides.php`);

        if (response.status === 401) {
            window.location.href = "/client/login";
            return;
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const text = await response.text();
        userRides = JSON.parse(text);

        if (!Array.isArray(userRides)) {
            throw new Error(`Réponse inattendue du serveur : ${JSON.stringify(userRides)}`);
        }

        displayRides();
    } catch (error) {
        console.error("Erreur chargement courses:", error);
        ridesContainer.innerHTML = "<p>Erreur lors du chargement des courses.</p>";
    }
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