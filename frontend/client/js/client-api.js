const CLIENT_API_BASE = "../../../backend";

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
        const passengers = parseInt(document.querySelector(".passengers input").value) || 1;
        const basePrice = distanceKm * 75;
        const discountRate = 0.10 * (passengers - 1);
        const finalDiscount = Math.min(discountRate, 0.7);
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
            window.location.href = "login.html";
            return result;
        }

        if (result.status === "success" && result.ride_id) {
            currentRideId = result.ride_id;
            startRideTracking();
            showWaitingMessage();

            const cancelBtn = document.getElementById("cancelRideBtn");
            if (cancelBtn) {
                cancelBtn.style.display = "block";
                cancelBtn.disabled = false;
            }
        }

        return result;
    } catch (error) {
        console.error("Erreur backend:", error);
        return { status: "error", message: "Erreur de connexion" };
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

    driverStatusInterval = setInterval(updateDriverPosition, 10000);
}

async function checkRideStatus(forceRefresh = false) {
    if (!currentRideId) return;

    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/check_ride_status.php?ride_id=${currentRideId}`);
        const result = await response.json();

        if (result.status !== "success") {
            updateRideStatusMessage("Impossible de vérifier le statut de la course.");
            return;
        }

        if (result.ride_status === "accepted") {
            if (!rideAccepted || forceRefresh) {
                rideAccepted = true;
                updateRideStatusMessage(`✅ Course acceptée par ${result.driver_name || "le chauffeur"} (${result.driver_plate || ""}) 🚕`);
            }
            await updateDriverPosition();
        } else if (result.ride_status === "cancelled_client") {
            clearInterval(rideStatusCheckInterval);
            clearInterval(driverStatusInterval);
            rideAccepted = false;
            updateRideStatusMessage("❌ Vous avez annulé la course.");
        } else if (result.ride_status === "cancelled") {
            clearInterval(rideStatusCheckInterval);
            clearInterval(driverStatusInterval);
            rideAccepted = false;
            updateRideStatusMessage("❌ Course annulée par le chauffeur.");
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
        return;
    }

    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/get_driver_location.php?ride_id=${currentRideId}`);
        const data = await response.json();

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

        if (driverPositionMarker) {
            driverPositionMarker.setLatLng([driverLat, driverLng]);
        } else {
            const taxiIcon = L.divIcon({
                html: '<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:30px;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.6));">🚕</div>',
                className: "",
                iconSize: [40, 40],
                iconAnchor: [20, 38],
                popupAnchor: [0, -40]
            });
            driverPositionMarker = L.marker([driverLat, driverLng], { icon: taxiIcon })
                .addTo(map)
                .bindPopup("<strong>🚕 Votre chauffeur</strong><br>Il arrive vers vous !");
            driverPositionMarker.openPopup();
        }

        const posChanged = (lastDriverLat === null) ||
            (Math.abs(driverLat - lastDriverLat) > 0.00005) ||
            (Math.abs(driverLng - lastDriverLng) > 0.00005);

        lastDriverLat = driverLat;
        lastDriverLng = driverLng;

        if (posChanged && pickupCoords) {
            if (driverRouteLayer) {
                map.removeLayer(driverRouteLayer);
                driverRouteLayer = null;
            }

            const route = await getRouteGeoJSON(driverLng, driverLat, pickupCoords.lng, pickupCoords.lat);
            if (route) {
                driverRouteLayer = L.geoJSON(route, {
                    style: { color: "#1d4ed8", weight: 5, opacity: 0.75, dashArray: "8, 6" }
                }).addTo(map);
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
        return data.routes && data.routes[0] ? data.routes[0].geometry : null;
    } catch (error) {
        console.error("Erreur OSRM route:", error);
        return null;
    }
}

async function loadUserRides() {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/get_user_rides.php`);

        if (response.status === 401) {
            window.location.href = "login.html";
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

document.addEventListener("DOMContentLoaded", () => {
    const cancelBtn = document.getElementById("cancelRideBtn");
    if (!cancelBtn) return;

    // Désactivé tant qu'il n'y a pas une course active (currentRideId)
    cancelBtn.disabled = true;

    cancelBtn.addEventListener("click", async () => {
        if (!currentRideId) {
            updateRideStatusMessage("Aucune course à annuler.");
            return;
        }

        const ok = window.confirm("Annuler cette course ?");
        if (!ok) return;

        try {
            const response = await fetch(`${CLIENT_API_BASE}/client/cancel_ride.php`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ride_id: currentRideId })
            });

            const result = await response.json();

            if (result.status === "success") {
                // On arrête la course côté UI immédiatement
                updateRideStatusMessage("❌ Vous avez annulé la course.");
                currentRideId = null;
                rideAccepted = false;

                const rideStatusIntervalId = rideStatusCheckInterval;
                const driverStatusIntervalId = driverStatusInterval;

                if (rideStatusIntervalId) clearInterval(rideStatusIntervalId);
                if (driverStatusIntervalId) clearInterval(driverStatusIntervalId);

                // Masquer le bouton
                cancelBtn.style.display = "none";
                cancelBtn.disabled = true;

                // Rafraîchir l'historique
                await loadUserRides();
            } else {
                updateRideStatusMessage(result.message || "Annulation impossible.");
            }
        } catch (error) {
            console.error("Erreur annulation:", error);
            updateRideStatusMessage("Erreur lors de l'annulation.");
        }
    });
});
