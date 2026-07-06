/**
 * chauffeur-api.js — TaxiGo Chauffeur
 */

"use strict";

const DRIVER_API_BASE = "/backend";

/* ═══════════════════════════════════════════════
   CACHE GPS GLOBAL
═══════════════════════════════════════════════ */
let lastKnownPos = null;  // { lat, lng, timestamp }

/** Appelé par onGpsPosition() dans chauffeur-ui.js à chaque fix GPS. */
function cacheGpsPosition(lat, lng) {
    lastKnownPos = { lat, lng, timestamp: Date.now() };
}

/**
 * BUG #4 FIX — retourne la position sans timeout bloquant.
 *
 * Stratégie :
 *  - Si lastKnownPos existe (même périmé) → on l'utilise immédiatement.
 *    watchPosition() va le rafraîchir de lui-même, pas besoin d'attendre.
 *  - Si lastKnownPos === null (GPS jamais initialisé) → getCurrentPosition
 *    avec timeout 8s et maximumAge libéral pour ne pas bloquer.
 *
 * @returns {Promise<{lat: number, lng: number}>}
 */
function getDriverPosition() {
    return new Promise((resolve, reject) => {
        // Cache présent (frais ou périmé) → on l'utilise sans bloquer
        if (lastKnownPos !== null) {
            resolve({ lat: lastKnownPos.lat, lng: lastKnownPos.lng });
            return;
        }

        // Aucun fix GPS encore reçu → attente du premier fix
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                cacheGpsPosition(lat, lng);
                resolve({ lat, lng });
            },
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 8_000, maximumAge: 60_000 }
        );
    });
}

/* ═══════════════════════════════════════════════
   HELPERS UI
═══════════════════════════════════════════════ */

/**
 * Met un bouton en état chargement. Retourne restore().
 */
function setButtonLoading(btn, label = "…") {
    if (!btn) return () => {};
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<div class="btn-spinner"></div>${label}`;
    return () => {
        btn.disabled = false;
        btn.innerHTML = original;
    };
}

/* ═══════════════════════════════════════════════
   AUTHENTIFICATION & PROFIL
═══════════════════════════════════════════════ */

async function initUserHeader(loginPage) {
    const logoutBtn = document.getElementById("logoutBtn");
    let authenticated = true; // optimiste par défaut (voir catch réseau plus bas)

    try {
        // cache: "no-store" en défense supplémentaire : même si un jour un proxy
        // ou une ancienne version mise en cache traîne, on force ici un vrai
        // aller-retour réseau pour la vérification de session.
        const response = await fetch(`${DRIVER_API_BASE}/common/current_user.php`, { cache: "no-store" });

        if (response.status === 401) {
            authenticated = false;
            window.location.href = loginPage;
            return authenticated;
        }

        const result = await response.json();

        if (result.status === "success" && result.user) {
            const user    = result.user;
            const name    = user.name || "Chauffeur";
            const initial = name.charAt(0).toUpperCase();

            const ids = {
                avatarInitial  : initial,
                profileAvatarLg: initial,
                profileName    : name,
                profileRowName : name,
                profileRowPhone: user.phone || "—",
                profileRowEmail: user.email || "—",
                profileRowPlate: user.plate || "—",
                profileRowBrand: user.car_brand || "—",
                profileRowColor: user.car_color || "—",
            };
            Object.entries(ids).forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            });

            // Compatibilité ancien HTML
            const legacyEl = document.getElementById("currentUserName");
            if (legacyEl) legacyEl.textContent = name;

            // Initialiser le toggle depuis l'état serveur
            initToggleFromServer(user.is_online ? true : false, user.status);
        }
    } catch (error) {
        // Échec réseau (vraiment hors ligne) : on reste optimiste plutôt que de
        // bloquer tout le tableau de bord -- une vraie coupure réseau est déjà
        // gérée par ailleurs (polling, service worker pour les assets statiques).
        console.error("Erreur chargement utilisateur:", error);
    }

    if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
            const ok = await confirmAction({
                title: "Se déconnecter ?",
                confirmLabel: "Se déconnecter",
                cancelLabel: "Annuler",
                danger: true
            });
            if (!ok) return;

            const restore = setButtonLoading(logoutBtn, "Déconnexion…");
            try {
                await fetch(`${DRIVER_API_BASE}/common/logout.php`, { method: "POST" });
            } catch (e) {
                console.warn("Logout request failed:", e);
            } finally {
                window.location.href = loginPage;
            }
        });
    }

    return authenticated;
}

/* ═══════════════════════════════════════════════
   RÉCUPÉRATION DES COURSES
═══════════════════════════════════════════════ */

async function checkNewRides() {
    try {
        const res = await fetch(`${DRIVER_API_BASE}/chauffeur/get_rides.php`);

        if (res.status === 401) {
            window.location.href = "/chauffeur/login";
            return;
        }

        const rides = await res.json();
        const freshRides = Array.isArray(rides) ? rides : [];

        // Diffing (chantier polling optimisé, 4bis) : get_rides.php reste en
        // full-refresh, structure inchangée. On compare juste les ID pending
        // de l'ancien allRides à ceux de la réponse fraîche AVANT de l'écraser,
        // pour ne notifier que sur un ID réellement jamais vu — pas à chaque
        // poll simplement parce que la liste pending est non vide.
        notifyIfNewPendingRides(allRides, freshRides);

        allRides = freshRides;

        updateRideLists();
        updateNavBadges();
        updateRideMarkers();

        const dashPanel = document.getElementById("panelDashboard");
        if (dashPanel && !dashPanel.classList.contains("hidden")) {
            updateDashboard();
        }
    } catch (error) {
        console.error("Erreur checkNewRides:", error);
    }
}

/* ═══════════════════════════════════════════════
   UTILITAIRES GÉOGRAPHIQUES
═══════════════════════════════════════════════ */

function getDistanceFromLatLng(lat1, lng1, lat2, lng2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function calculateRoute(startLng, startLat, endLng, endLat) {
    const url = `https://router.project-osrm.org/route/v1/driving/` +
                `${startLng},${startLat};${endLng},${endLat}` +
                `?overview=full&geometries=geojson`;
    try {
        const res  = await fetch(url);
        const data = await res.json();
        if (data.routes?.length > 0) return data.routes[0].geometry;
    } catch (e) {
        console.error("Erreur calcul route:", e);
    }
    return null;
}

/* ═══════════════════════════════════════════════
   POSITION CHAUFFEUR
═══════════════════════════════════════════════ */

async function updateDriverPosition() {
    if (typeof isOnline !== "undefined" && !isOnline) return;
    if (!driverMarker) return;
    if (!lastKnownPos) return;

    const { lat, lng } = lastKnownPos;
    await updateDriverPositionInDB(lat, lng);
}

async function updateDriverPositionInDB(lat, lng) {
    const activeRides = (allRides || []).filter(
        r => r.status === "accepted" || r.status === "arrived" || r.status === "started"
    );

    const requests = [];

    for (const ride of activeRides) {
        requests.push(
            fetch(`${DRIVER_API_BASE}/chauffeur/update_ride_driver_position.php?ride_id=${ride.id}&lat=${lat}&lng=${lng}`)
        );
    }

    requests.push(
        fetch(`${DRIVER_API_BASE}/chauffeur/update_ride_driver_position.php?lat=${lat}&lng=${lng}`)
    );

    const results = await Promise.allSettled(requests.map(req => req.then(res => res.json())));

    results.forEach((result, index) => {
        if (result.status === "rejected") {
            console.error("Position update error:", result.reason);
            return;
        }

        const payload = result.value;
        if (!payload || payload.status !== "success") {
            const rideLabel = index < activeRides.length ? `#${activeRides[index].id}` : "chauffeur";
            console.warn(`Position update ${rideLabel}:`, payload?.message || "unknown error");
        }
    });
}

/* ═══════════════════════════════════════════════
   ACTIONS CHAUFFEUR
═══════════════════════════════════════════════ */

/**
 * BUG #5 FIX — une seule closure setButtonLoading, label muté manuellement.
 *
 * Avant : deux closures imbriquées (restore + restoreAccept).
 *         restore() n'était jamais appelé sur le chemin succès.
 * Après : restore() unique, appelé dans le finally global.
 *         Le label du bouton passe de "Localisation…" à "Acceptation…"
 *         via btn.innerHTML, sans créer de deuxième fermeture.
 */
async function acceptRide(id, btn) {
    const restore = setButtonLoading(btn, "Localisation…");

    try {
        const { lat: driverLat, lng: driverLng } = await getDriverPosition();

        // Changer uniquement le label — pas de nouvelle closure
        if (btn && !btn.disabled === false) {
            btn.innerHTML = `<div class="btn-spinner"></div>Acceptation…`;
        }

        const response = await fetch(`${DRIVER_API_BASE}/chauffeur/accept_ride.php`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ id, driver_lat: driverLat, driver_lng: driverLng })
        });
        const result = await response.json();

        if (result.status === "success" || result.status === "ok") {
            showToast("Course acceptée ! En route vers le départ. 🚕", "success");
            await checkNewRides();
            if (typeof switchTab === "function") switchTab("courses");
        } else {
            showToast(result.message || "Impossible d'accepter la course", "error");
        }
    } catch (err) {
        if (err?.code === 3 || err?.code === 2) {
            showToast("GPS indisponible. Activez la localisation.", "error");
        } else {
            showToast("Erreur de connexion au serveur", "error");
        }
    } finally {
        // restore() appelé UNE SEULE fois — chemin succès ET erreur
        restore();
    }
}

async function refuseRide(id, btn) {
    const restore = setButtonLoading(btn, "…");
    try {
        await fetch(`${DRIVER_API_BASE}/chauffeur/refuse_ride.php`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ id })
        });
        showToast("Course refusée", "info");
        await checkNewRides();
    } catch {
        showToast("Erreur lors du refus", "error");
    } finally {
        restore();
    }
}

async function cancelRide(id, btn) {
    const ok = await confirmAction({
        title: "Annuler cette course ?",
        message: "Le client sera prévenu de l'annulation.",
        confirmLabel: "Annuler la course",
        cancelLabel: "Retour",
        danger: true
    });
    if (!ok) return;

    const restore = setButtonLoading(btn, "Annulation…");
    try {
        const res    = await fetch(`${DRIVER_API_BASE}/chauffeur/cancel_ride.php`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ id })
        });
        const result = await res.json();
        if (result.status === "success") {
            showToast("Course annulée", "info");
            await checkNewRides();
        } else {
            showToast(result.message || "Impossible d'annuler", "error");
        }
    } catch {
        showToast("Erreur de connexion", "error");
    } finally {
        restore();
    }
}

async function startRide(id, btn) {
    const restore = setButtonLoading(btn, "Démarrage…");
    try {
        const res    = await fetch(`${DRIVER_API_BASE}/chauffeur/start_ride.php`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ id })
        });
        const result = await res.json();
        if (result.status === "success") {
            showToast("Bonne route ! Course démarrée. 🚗", "success");
            await checkNewRides();
            if (typeof setRideFilter === "function") setRideFilter("started");
        } else {
            showToast(result.message || "Impossible de démarrer", "error");
        }
    } catch {
        showToast("Erreur de connexion", "error");
    } finally {
        restore();
    }
}

async function arriveRide(id, btn) {
    const restore = setButtonLoading(btn, "Arrivee...");
    try {
        let lat, lng;
        try {
            ({ lat, lng } = await getDriverPosition());   // ← nouveau : position GPS fraîche en cache (watchPosition), déjà utilisée pour acceptRide
        } catch (gpsErr) {
            showToast("Impossible d'obtenir votre position GPS. Activez la localisation pour confirmer l'arrivee.", "error");
            return;
        }

        const res    = await fetch(`${DRIVER_API_BASE}/chauffeur/arrive_ride.php`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ id, lat, lng })      // ← lat/lng ajoutés au payload
        });
        const result = await res.json();
        if (result.status === "success") {
            showToast("Arrivee confirmee. Le client est prevenu.", "success");
            await checkNewRides();
            if (typeof setRideFilter === "function") setRideFilter("arrived");
        } else {
            showToast(result.message || "Impossible de confirmer l'arrivee", "error");
        }
    } catch {
        showToast("Erreur de connexion", "error");
    } finally {
        restore();
    }
}

async function completeRide(id, btn) {
    const restore = setButtonLoading(btn, "Finalisation…");
    try {
        await performCompleteRide(id, false);
        showToast("Course terminée ! Bravo. ✅", "success");
        await checkNewRides();
        updateDashboard();
    } catch (err) {
        if (err && err.needsConfirmation) {
            const ok = await confirmAction({
                title: "Terminer malgré la distance ?",
                message: `Vous êtes à environ ${err.distance} m de la destination prévue. Confirmez seulement si le client est bien descendu ici.`,
                confirmLabel: "Terminer quand même",
                cancelLabel: "Annuler",
                danger: false
            });
            if (ok) {
                try {
                    await performCompleteRide(id, true);
                    showToast("Course terminée ! Bravo. ✅", "success");
                    await checkNewRides();
                    updateDashboard();
                } catch {
                    showToast("Impossible de terminer", "error");
                }
            }
        } else {
            showToast(err?.message || "Erreur de connexion", "error");
        }
    } finally {
        restore();
    }
}

/**
 * Effectue l'appel réseau de finalisation de course, avec la position GPS
 * fraîche du chauffeur (même pattern que arriveRide()). Si le serveur juge
 * le chauffeur trop loin de la destination et que force=false, lève une
 * erreur marquée needsConfirmation pour que completeRide() propose la
 * modale de confirmation plutôt que d'afficher une simple erreur.
 *
 * GPS indisponible : lat/lng restent null — le serveur ne bloque jamais sur
 * une donnée GPS absente (cf. complete_ride.php), la course se termine donc
 * normalement, sans confirmation, dans ce cas.
 */
async function performCompleteRide(id, force) {
    let lat = null, lng = null;
    try {
        ({ lat, lng } = await getDriverPosition());
    } catch (gpsErr) {
        // Échec silencieux — voir commentaire ci-dessus.
    }

    const res    = await fetch(`${DRIVER_API_BASE}/chauffeur/complete_ride.php`, {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify({ id, lat, lng, force })
    });
    const result = await res.json();

    if (result.status === "success") return;

    if (result.status === "needs_confirmation") {
        const err = new Error(result.message || "Confirmation requise");
        err.needsConfirmation = true;
        err.distance = result.distance;
        throw err;
    }

    throw new Error(result.message || "Impossible de terminer");
}

function reportProblem(id) {
    openReportModal(id);
}

async function submitReportAPI(id, problem, btn) {
    const restore = setButtonLoading(btn, "Envoi…");
    try {
        const res    = await fetch(`${DRIVER_API_BASE}/chauffeur/report_problem.php`, {
            method : "POST",
            headers: { "Content-Type": "application/json" },
            body   : JSON.stringify({ id, problem: problem.trim() })
        });
        const result = await res.json();
        if (result.status === "success") {
            showToast("Problème signalé. Merci. ⚠️", "success");
            closeReportModal();
            await checkNewRides();
        } else {
            showToast(result.message || "Impossible de signaler", "error");
        }
    } catch {
        showToast("Erreur de connexion", "error");
    } finally {
        restore();
    }
}

/* ═══════════════════════════════════════════════
   STATUT EN LIGNE / HORS LIGNE
═══════════════════════════════════════════════ */

/**
 * Met à jour le statut is_online du chauffeur côté serveur.
 * Appelé par le toggle dans chauffeur-ui.js.
 */
async function setDriverStatus(isOnline) {
    try {
        const res = await fetch(`${DRIVER_API_BASE}/chauffeur/set_driver_status.php`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_online: isOnline }),
            cache: "no-store"
        });

        if (res.status === 401) {
            window.location.href = "/chauffeur/login";
            // Erreur dédiée (jamais affichée : la page a déjà commencé à naviguer)
            // pour interrompre proprement le bloc appelant sans passer par le
            // message générique "Erreur de connexion au serveur".
            throw new Error("Session expirée, redirection vers la connexion.");
        }

        const result = await res.json();
        if (result.status !== "success") {
            throw new Error(result.message || "Échec de la mise à jour du statut");
        }
        return result;
    } catch (err) {
        console.error("setDriverStatus error:", err);
        throw err;
    }
}