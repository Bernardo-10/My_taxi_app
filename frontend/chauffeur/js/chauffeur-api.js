const DRIVER_API_BASE = "../../../backend";

async function initUserHeader(loginPage) {
    const currentUserName = document.getElementById("currentUserName");
    const logoutBtn = document.getElementById("logoutBtn");

    try {
        const response = await fetch(`${DRIVER_API_BASE}/common/current_user.php`);
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
                await fetch(`${DRIVER_API_BASE}/common/logout.php`, { method: "POST" });
            } finally {
                window.location.href = loginPage;
            }
        });
    }
}

async function checkNewRides() {
    const res = await fetch(`${DRIVER_API_BASE}/chauffeur/get_rides.php`);
    if (res.status === 401) {
        window.location.href = "login.html";
        return;
    }

    const rides = await res.json();
    allRides = rides;
    updateRideLists();
    updateRideMarkers();

    const dashboardTabEl = document.getElementById("dashboardTab");
    if (dashboardTabEl && dashboardTabEl.classList.contains("active")) {
        updateDashboard();
    }
}

function getDistanceFromLatLng(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function calculateRoute(startLng, startLat, endLng, endLat) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.routes && data.routes.length > 0) {
            return data.routes[0].geometry;
        }
    } catch (error) {
        console.error("Erreur calcul route:", error);
    }

    return null;
}

async function updateDriverPosition() {
    try {
        if (driverMarker) {
            navigator.geolocation.getCurrentPosition(
                async (pos) => {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;

                    driverMarker.setLatLng([lat, lng]);
                    await updateDriverPositionInDB(lat, lng);
                },
                (err) => {
                    console.warn("Erreur GPS lors de la mise à jour:", err.message);
                }
            );
        }
    } catch (error) {
        console.error("Erreur mise à jour position chauffeur:", error);
    }
}

async function updateDriverPositionInDB(lat, lng) {
    try {
        const ridesResponse = await fetch(`${DRIVER_API_BASE}/chauffeur/get_rides.php`);
        const rides = await ridesResponse.json();
        const acceptedRides = rides.filter(ride => ride.status === "accepted");

        for (const ride of acceptedRides) {
            try {
                const response = await fetch(`${DRIVER_API_BASE}/chauffeur/update_ride_driver_position.php?ride_id=${ride.id}&lat=${lat}&lng=${lng}`);
                const result = await response.json();

                if (result.status !== "success") {
                    console.warn(`Erreur mise à jour course #${ride.id}:`, result.message);
                }
            } catch (error) {
                console.error(`Erreur pour course #${ride.id}:`, error);
            }
        }
    } catch (error) {
        console.error("Erreur mise à jour position en base:", error);
    }
}

async function acceptRide(id) {
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const driverLat = pos.coords.latitude;
            const driverLng = pos.coords.longitude;

            try {
                const response = await fetch(`${DRIVER_API_BASE}/chauffeur/accept_ride.php`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id, driver_lat: driverLat, driver_lng: driverLng })
                });

                const result = await response.json();

                if (result.status === "ok") {
                    alert("Course acceptée 🚕");
                    checkNewRides();
                } else {
                    alert("Erreur: " + (result.message || "Impossible d'accepter la course"));
                }
            } catch (error) {
                console.error("Erreur lors de l'envoi:", error);
                alert("Erreur de connexion au serveur");
            }
        },
        (err) => {
            console.error("Géolocalisation échouée:", err);
            alert("Impossible de récupérer votre position. Activez le GPS et acceptez l'accès à la localisation.");
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        }
    );
}

async function refuseRide(id) {
    await fetch(`${DRIVER_API_BASE}/chauffeur/refuse_ride.php`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });

    alert("Course refusée");
    checkNewRides();
}

async function cancelRide(id) {
    await fetch(`${DRIVER_API_BASE}/chauffeur/cancel_ride.php`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });

    alert("Course annulée");
    checkNewRides();
}

async function completeRide(id) {
    await fetch(`${DRIVER_API_BASE}/chauffeur/complete_ride.php`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });

    alert("Course terminée ✅");
    checkNewRides();
    updateDashboard();
}
