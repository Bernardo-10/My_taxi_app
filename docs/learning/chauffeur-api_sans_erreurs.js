// Version pedagogique API du chauffeur.
// Contient les appels fetch et les fonctions qui parlent au backend ou a des APIs externes.

const CHAUFFEUR_API = {
    currentUser: "../../../backend/common/current_user.php",
    logout: "../../../backend/common/logout.php",
    rides: "../../../backend/chauffeur/get_rides.php",
    updateRideDriverPosition: "../../../backend/chauffeur/update_ride_driver_position.php",
    acceptRide: "../../../backend/chauffeur/accept_ride.php",
    refuseRide: "../../../backend/chauffeur/refuse_ride.php",
    cancelRide: "../../../backend/chauffeur/cancel_ride.php",
    completeRide: "../../../backend/chauffeur/complete_ride.php",
    osrmRoute: "https://router.project-osrm.org/route/v1/driving"
};

async function initUserHeader(loginPage) {
    const currentUserName = document.getElementById("currentUserName");
    const logoutBtn = document.getElementById("logoutBtn");

    const response = await fetch(CHAUFFEUR_API.currentUser);
    const result = await response.json();
    currentUserName.textContent = result.user.name;

    logoutBtn.addEventListener("click", async () => {
        await fetch(CHAUFFEUR_API.logout, { method: "POST" });
        window.location.href = loginPage;
    });
}

async function checkNewRides() {
    const res = await fetch(CHAUFFEUR_API.rides);
    allRides = await res.json();
    updateRideLists();
    updateRideMarkers();

    const dashboardTabEl = document.getElementById("dashboardTab");
    if (dashboardTabEl.classList.contains("active")) {
        updateDashboard();
    }
}

function getDistanceFromLatLng(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function calculateRoute(startLng, startLat, endLng, endLat) {
    const url = `${CHAUFFEUR_API.osrmRoute}/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    return data.routes[0].geometry;
}

async function updateDriverPosition() {
    navigator.geolocation.getCurrentPosition(async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        driverMarker.setLatLng([lat, lng]);
        await updateDriverPositionInDB(lat, lng);
    });
}

async function updateDriverPositionInDB(lat, lng) {
    const ridesResponse = await fetch(CHAUFFEUR_API.rides);
    const rides = await ridesResponse.json();
    const acceptedRides = rides.filter(ride => ride.status === "accepted");

    for (const ride of acceptedRides) {
        const response = await fetch(`${CHAUFFEUR_API.updateRideDriverPosition}?ride_id=${ride.id}&lat=${lat}&lng=${lng}`);
        await response.json();
    }
}

async function acceptRide(id) {
    navigator.geolocation.getCurrentPosition(async (pos) => {
        const driverLat = pos.coords.latitude;
        const driverLng = pos.coords.longitude;

        const response = await fetch(CHAUFFEUR_API.acceptRide, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, driver_lat: driverLat, driver_lng: driverLng })
        });

        await response.json();
        alert("Course acceptee");
        checkNewRides();
    });
}

async function refuseRide(id) {
    await fetch(CHAUFFEUR_API.refuseRide, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });

    alert("Course refusee");
    checkNewRides();
}

async function cancelRide(id) {
    await fetch(CHAUFFEUR_API.cancelRide, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });

    alert("Course annulee");
    checkNewRides();
}

async function completeRide(id) {
    await fetch(CHAUFFEUR_API.completeRide, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
    });

    alert("Course terminee");
    checkNewRides();
    updateDashboard();
}
