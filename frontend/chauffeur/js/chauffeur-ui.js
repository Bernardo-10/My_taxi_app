/**
 * chauffeur-ui.js — TaxiGo Interface Chauffeur
 *
 * CORRECTIONS CETTE SESSION :
 *
 *  ✅ BUG #1 — Poll concurrent lors du toggle statut
 *     CAUSE  : schedulePoll() tournait même hors ligne toutes les 5s.
 *              Au retour en ligne, initStatusToggle() déclenchait checkNewRides()
 *              manuellement EN MÊME TEMPS que le poll récursif → 2 appels
 *              concurrents → renderPendingRides() x2 → DOM recréé pendant
 *              le clic sur "Accepter" → bouton détaché, acceptRide() échoue.
 *     FIX    : schedulePoll() sort immédiatement si !isOnline (pas de fetch,
 *              pas de render). Le toggle passe isOnline=true AVANT de lancer
 *              checkNewRides(), et schedulePoll() reprend naturellement au
 *              prochain cycle sans appel doublon.
 *
 *  ✅ BUG #6 — routeCache jamais purgé après désactivation du statut
 *     CAUSE  : En passant hors ligne, allRides est toujours peuplé mais
 *              renderPendingRides/renderActiveCourses ne sont plus appelés.
 *              Au retour en ligne, updateRideMarkers() compare le cache
 *              avec des courses désormais obsolètes → routes fantômes sur
 *              la carte, markers orphelins.
 *     FIX    : onStatusChange(false) vide allRides et purge les marqueurs
 *              et le routeCache explicitement.
 *
 *  ✅ BUG #7 — isCheckingRides jamais remis à false si checkNewRides() throw
 *     CAUSE  : Si le fetch dans checkNewRides() lève une exception réseau,
 *              isCheckingRides reste true → schedulePoll() ne relance jamais
 *              un vrai poll → les courses ne se chargent plus après une
 *              coupure réseau temporaire.
 *     FIX    : isCheckingRides est géré dans schedulePoll() via try/finally,
 *              PAS dans checkNewRides(). checkNewRides() est maintenant pur :
 *              il fetch, met à jour allRides et render. Toute exception
 *              remonte à schedulePoll() qui remet le flag à false dans finally.
 *
 *  ✅ CHANTIER 2 — Alertes plein écran qui réapparaissent au rafraîchissement
 *     CAUSE  : shownClientReports/shownCancellations étaient de simples
 *              Set() en mémoire, réinitialisés à chaque chargement de page.
 *     FIX    : persistance dans localStorage (loadShownAlerts/persistShownAlerts/
 *              markAlertShown), fenêtre de rétention 24h alignée sur la fenêtre
 *              serveur de get_rides.php pour cancelled_client.
 *
 *  ✅ CHANTIER 4 (v3) — Alerte "problème client" retirée du chauffeur
 *     CAUSE  : afficher au chauffeur lui-même l'alerte "cette course est
 *              surveillée" est contre-productif d'un point de vue sécurité —
 *              ça prévient la personne surveillée qu'elle l'est.
 *     FIX    : showClientProblemAlerts()/openClientProblemAlert() supprimées.
 *              L'alerte vit désormais côté admin (frontend/admin/js/admin-ui.js),
 *              avec un dédup serveur (rides.client_problem_resolved_at) plutôt
 *              que localStorage, pour rester cohérent entre plusieurs postes admin.
 *              get_rides.php ne renvoie plus client_problem_description/
 *              client_problem_at au chauffeur (whitelist de colonnes).
 */

/* ═══════════════════════════════════════════════
   ÉTAT GLOBAL
═══════════════════════════════════════════════ */
let map;
let driverMarker        = null;
let allRides            = [];
let rideMarkers         = [];
let destinationMarkers  = [];
let destinationMap      = new Map();
let routeLayers         = [];
let routeCache          = new Map();

// Flags concurrence
let isUpdatingRoutes    = false;
let isCheckingRides     = false;

// GPS
let gpsWatchId          = null;
let userMovedMap        = false;
let initialGpsDone      = false;

// Polling
let pollTimeout         = null;
let positionTimeout     = null;

// Tab / filter state
let activeTab           = "map";
let activeFilter        = "accepted";

// Report modal state
let reportRideId        = null;

// Persistance des alertes plein écran déjà vues (problème client, annulation
// client) dans localStorage, pour survivre à un rafraîchissement de page —
// même pattern que "taxigo_recents" côté client. Fenêtre de rétention de 24h,
// alignée sur la fenêtre serveur de get_rides.php pour cancelled_client.
const CANCELLATIONS_STORAGE_KEY  = "taxigo_shown_cancellations";
const SHOWN_ALERTS_MAX_AGE_MS    = 24 * 60 * 60 * 1000; // 24h

function loadShownAlerts(storageKey) {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(storageKey) || "{}"); }
    catch (e) { raw = {}; }

    const now = Date.now();
    const map = new Map();
    Object.entries(raw).forEach(([key, ts]) => {
        if (typeof ts === "number" && now - ts < SHOWN_ALERTS_MAX_AGE_MS) map.set(key, ts);
    });

    persistShownAlerts(storageKey, map); // purge les entrées expirées dès le chargement
    return map;
}

function persistShownAlerts(storageKey, map) {
    try {
        const obj = {};
        map.forEach((ts, key) => { obj[key] = ts; });
        localStorage.setItem(storageKey, JSON.stringify(obj));
    } catch (e) {
        // localStorage indisponible/plein : l'alerte reste dédupliquée pour
        // la session en cours, seule la persistance au refresh est perdue
    }
}

function markAlertShown(map, storageKey, key) {
    map.set(key, Date.now());
    persistShownAlerts(storageKey, map);
}

// Alerte annulation client (course déjà acceptée/arrivée/démarrée)
let shownCancellations  = loadShownAlerts(CANCELLATIONS_STORAGE_KEY);

// Statut en ligne
let isOnline            = false;
let isDisabled           = false;

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
    // On attend la confirmation de session AVANT d'initialiser quoi que ce
    // soit d'interactif (carte, toggle "en ligne", polling...). Auparavant
    // ces initialisations démarraient en parallèle de la vérification de
    // session : un chauffeur non connecté pouvait taper sur "Se mettre en
    // ligne" pendant cette fenêtre et voir une erreur générique au lieu
    // d'être simplement redirigé vers le login.
    const authenticated = await initUserHeader("/chauffeur/login");
    if (!authenticated) return; // redirection déjà lancée par initUserHeader()

    // Notifications push (FCM) — ne bloque jamais le reste de l'app si ça
    // échoue (permission refusée, SDK absent...), voir push-notifications.js.
    initPushNotifications("chauffeur");

    initMap();
    initNavigation();
    initSheetDrag();
    initStatusToggle();
    initRefreshFab();
    initProfileDrawer();
    initReportModal();
    initFilterPills();
    initWallet();
    initDocuments();

    const dateEl = document.getElementById("dashboardDate");
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString("fr-FR", {
            weekday: "long", day: "numeric", month: "long"
        });
    }

    schedulePoll();
    schedulePositionUpdate();

    window.addEventListener("beforeunload", cleanup);
});

function cleanup() {
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    if (pollTimeout)     clearTimeout(pollTimeout);
    if (positionTimeout) clearTimeout(positionTimeout);
}

/* ═══════════════════════════════════════════════
   POLLING RÉCURSIF
   BUG #1 FIX : sort immédiatement si hors ligne.
   BUG #7 FIX : isCheckingRides géré ici via try/finally,
                pas dans checkNewRides().
═══════════════════════════════════════════════ */
async function schedulePoll() {
    // BUG #1 FIX : ne pas fetcher quand hors ligne
    if (!isOnline) {
        pollTimeout = setTimeout(schedulePoll, 5000);
        return;
    }

    // BUG #7 FIX : si un fetch est déjà en cours, on attend le prochain cycle
    if (isCheckingRides) {
        pollTimeout = setTimeout(schedulePoll, 5000);
        return;
    }

    isCheckingRides = true;
    try {
        await refreshDriverStatus();
        if (!isDisabled) {
            await checkNewRides();
        }
    } catch (err) {
        // Erreur réseau silencieuse — log seulement
        console.warn("Poll error (temporary):", err?.message);
    } finally {
        // BUG #7 FIX : always reset, même si checkNewRides() throw
        isCheckingRides = false;
        pollTimeout = setTimeout(schedulePoll, 5000);
    }
}

async function schedulePositionUpdate() {
    await updateDriverPosition();
    positionTimeout = setTimeout(schedulePositionUpdate, 10000);
}

async function refreshDriverStatus() {
    try {
        const res = await fetch(`${DRIVER_API_BASE}/common/current_user.php`, { cache: "no-store" });
        if (res.status === 401) {
            window.location.href = "/chauffeur/login";
            return;
        }

        const result = await res.json();
        if (result.status !== "success" || !result.user) return;

        const serverStatus = result.user.status;
        const serverOnline = result.user.is_online ? true : false;
        const previouslyDisabled = isDisabled;

        if (serverStatus !== "active") {
            isDisabled = true;
            if (isOnline) {
                isOnline = false;
                onGoOffline();
            }
            const btn = document.getElementById("statusToggle");
            if (btn) btn.disabled = true;
            const label = document.getElementById("statusLabel");
            const profileStatus = document.getElementById("profileRowStatus");
            if (label) label.textContent = "Compte désactivé";
            if (profileStatus) profileStatus.textContent = "Compte désactivé";
            if (!previouslyDisabled) {
                showToast("Votre compte a été désactivé par l'administrateur. Contactez l'admin.", "error", 5000);
            }
            return;
        }

        if (isDisabled) {
            isDisabled = false;
            const btn = document.getElementById("statusToggle");
            if (btn) btn.disabled = false;
        }

        // Si l'admin a forcé la mise hors ligne
        if (!serverOnline && isOnline) {
            isOnline = false;
            onGoOffline();
            const btn = document.getElementById("statusToggle");
            if (btn) btn.classList.remove("online");
            const label = document.getElementById("statusLabel");
            const profileStatus = document.getElementById("profileRowStatus");
            if (label) label.textContent = "Hors ligne";
            if (profileStatus) profileStatus.textContent = "Hors ligne";
            showToast("Votre statut a été changé hors ligne par l'administrateur.", "info", 4000);
        }
    } catch (error) {
        console.warn("refreshDriverStatus error:", error);
    }
}

/* ═══════════════════════════════════════════════
   MAP
═══════════════════════════════════════════════ */
function initMap() {
    map = L.map("map", { zoomControl: false }).setView([4.05, 9.76], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    L.control.zoom({ position: "topright" }).addTo(map);

    map.on("movestart", (e) => {
        if (!e.originalEvent) return;
        userMovedMap = true;
    });

    if (!navigator.geolocation) {
        showToast("La géolocalisation n'est pas disponible", "error");
        return;
    }

    gpsWatchId = navigator.geolocation.watchPosition(
        onGpsPosition,
        (err) => console.warn("GPS watch error:", err.message),
        { enableHighAccuracy: true, maximumAge: 0 }
    );
}

function onGpsPosition(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    // Alimente le cache GPS utilisé par acceptRide() dans chauffeur-api.js
    cacheGpsPosition(lat, lng);

    if (!driverMarker) {
        const icon = L.divIcon({
            html: '<div class="driver-marker-dot">🚕</div>',
            className: "driver-marker-icon",
            iconSize: [40, 40],
            iconAnchor: [20, 40]
        });
        driverMarker = L.marker([lat, lng], { icon }).addTo(map);

        if (!initialGpsDone) {
            map.setView([lat, lng], 15);
            initialGpsDone = true;
        }
    } else {
        driverMarker.setLatLng([lat, lng]);

        if (!userMovedMap) {
            map.setView([lat, lng], map.getZoom());
        }
    }
}

/* ═══════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════ */
function initNavigation() {
    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
}

function switchTab(tab) {
    activeTab = tab;

    document.querySelectorAll(".nav-btn").forEach(b => {
        const isActive = b.dataset.tab === tab;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-current", isActive ? "page" : "false");
    });

    const mapEl          = document.getElementById("map");
    const sheet          = document.getElementById("mapBottomSheet");
    const fabEl          = document.getElementById("refreshFab");
    const panelCourses   = document.getElementById("panelCourses");
    const panelDashboard = document.getElementById("panelDashboard");

    if (tab === "map") {
        mapEl.classList.remove("hidden");
        sheet.classList.remove("hidden");
        fabEl.classList.remove("hidden");
        panelCourses.classList.add("hidden");
        panelDashboard.classList.add("hidden");
        setTimeout(() => map.invalidateSize(), 50);
    } else if (tab === "courses") {
        mapEl.classList.add("hidden");
        sheet.classList.add("hidden");
        fabEl.classList.add("hidden");
        panelCourses.classList.remove("hidden");
        panelDashboard.classList.add("hidden");
        renderActiveCourses();
    } else if (tab === "dashboard") {
        mapEl.classList.add("hidden");
        sheet.classList.add("hidden");
        fabEl.classList.add("hidden");
        panelCourses.classList.add("hidden");
        panelDashboard.classList.remove("hidden");
        updateDashboard();
    }
}

/* ═══════════════════════════════════════════════
   STATUS TOGGLE
   BUG #1 FIX (historique) : pas d'appel manuel séparé à checkNewRides() ici
                — ça créait un second chemin d'appel concurrent au poll
                récursif, d'où le double render qui cassait "Accepter".
   ÉVOLUTION (latence au passage en ligne) : on ne laisse plus schedulePoll()
                reprendre "au prochain cycle naturel" (jusqu'à 5s d'attente,
                voir pollTimeout) — on annule ce timeout et on rappelle
                schedulePoll() tout de suite. Ça reste un seul chemin d'appel
                (schedulePoll(), avec sa propre garde isCheckingRides) : pas
                de second call path, donc BUG #1 ne peut pas revenir.
   BUG #6 FIX : onGoOffline() purge allRides et les marqueurs.
   FIX is_online : le toggle envoie la demande au serveur via setDriverStatus().
═══════════════════════════════════════════════ */

/**
 * Initialise l'état du toggle depuis la valeur is_online retournée
 * par current_user.php.
 */
function initToggleFromServer(serverIsOnline, serverStatus) {
    isOnline = serverIsOnline;
    isDisabled = serverStatus !== "active";
    const btn = document.getElementById("statusToggle");
    if (!btn) return;

    btn.classList.toggle("online", isOnline && !isDisabled);
    btn.setAttribute("aria-pressed", isOnline && !isDisabled);
    btn.disabled = isDisabled;

    const label = document.getElementById("statusLabel");
    const profileStatus = document.getElementById("profileRowStatus");
    let labelText;

    if (isDisabled) {
        labelText = "Compte désactivé";
        btn.classList.remove("online");
        if (isOnline) {
            isOnline = false;
            onGoOffline();
        }
    } else {
        labelText = isOnline ? "En ligne" : "Hors ligne";
        if (!isOnline) {
            onGoOffline();
        }
    }

    if (label) label.textContent = labelText;
    if (profileStatus) profileStatus.textContent = labelText;
}

function initStatusToggle() {
    const btn = document.getElementById("statusToggle");
    if (!btn) return;

    btn.addEventListener("click", async () => {
        // Chantier notifications natives côté chauffeur (13/07/2026) : demande
        // de permission faite ici, sur un vrai geste utilisateur (obligatoire
        // sur iOS Safari), même pattern que initFindRideBtn() côté client.
        // Sans effet si déjà accordée/refusée — ne redemande jamais deux fois.
        if (typeof window.requestNotifyPermission === "function") {
            window.requestNotifyPermission();
        }

        // Tentative de passage hors ligne → vérifier les courses actives
        if (isOnline) {
            const activeRides = allRides.filter(
                r => r.status === "accepted" || r.status === "arrived" || r.status === "started"
            );
            if (activeRides.length > 0) {
                const nb = activeRides.length;
                showToast(
                    `Impossible — ${nb} course${nb > 1 ? "s" : ""} en cours. Terminez-la${nb > 1 ? "s" : ""} d'abord.`,
                    "warning",
                    4000
                );
                // Vibration déjà déclenchée par showToast() ci-dessus (pattern générique).
                btn.classList.add("shake");
                setTimeout(() => btn.classList.remove("shake"), 500);
                return;
            }
        }

        if (isDisabled) {
            showToast("Votre compte a été désactivé par l'administrateur. Contactez l'admin.", "error", 5000);
            // Vibration déjà déclenchée par showToast() ci-dessus (pattern générique).
            return;
        }

        // Mise à jour UI immédiate (optimiste)
        const newOnline = !isOnline;
        isOnline = newOnline;
        btn.classList.toggle("online", newOnline);
        btn.setAttribute("aria-pressed", newOnline);

        const label = document.getElementById("statusLabel");
        const profileStatus = document.getElementById("profileRowStatus");
        const labelText = newOnline ? "En ligne" : "Hors ligne";
        if (label) label.textContent = labelText;
        if (profileStatus) profileStatus.textContent = labelText;

        try {
            // Envoyer au serveur
            await setDriverStatus(newOnline);

            if (newOnline) {
                showToast("Vous êtes maintenant en ligne", "success");

                // Ne pas attendre le prochain tick naturel de schedulePoll()
                // (jusqu'à 5s, voir pollTimeout) : on l'annule et on relance
                // la boucle tout de suite pour que les courses pending déjà
                // en attente apparaissent le plus vite possible. Un seul
                // chemin d'appel (schedulePoll() lui-même, avec sa garde
                // isCheckingRides) — voir le commentaire au-dessus de ce bloc.
                if (pollTimeout) clearTimeout(pollTimeout);
                schedulePoll();
            } else {
                showToast("Vous êtes hors ligne", "info");
                onGoOffline();
            }
        } catch (err) {
            // Session expirée : la redirection est déjà en cours (voir
            // setDriverStatus/chauffeur-api.js) -- inutile d'afficher un toast
            // ou de rollback une UI que l'utilisateur ne verra plus.
            if (err?.message?.includes("Session expirée")) return;

            // Échec → rollback de l'UI
            isOnline = !newOnline;
            btn.classList.toggle("online", isOnline);
            btn.setAttribute("aria-pressed", isOnline);
            if (label) label.textContent = isOnline ? "En ligne" : "Hors ligne";
            if (profileStatus) profileStatus.textContent = isOnline ? "En ligne" : "Hors ligne";
            showToast(err?.message || "Erreur de connexion au serveur", "error");
        }
    });
}

/**
 * BUG #6 FIX — purge l'état visible quand le chauffeur passe hors ligne.
 * Sans cela, les courses et marqueurs restent affichés jusqu'au prochain poll
 * qui ne vient jamais (poll bloqué par !isOnline).
 */
function onGoOffline() {
    // Vider la liste des courses
    allRides = [];
    renderPendingRides();
    if (activeTab === "courses") renderActiveCourses();
    updateNavBadges();

    // Purger les marqueurs et routes de la carte
    rideMarkers.forEach(m => map.removeLayer(m));
    rideMarkers = [];
    destinationMarkers.forEach(m => map.removeLayer(m));
    destinationMarkers = [];
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
    routeCache.clear();
    destinationMap.clear();
}

/* ═══════════════════════════════════════════════
   REFRESH FAB
═══════════════════════════════════════════════ */
function initRefreshFab() {
    const fab = document.getElementById("refreshFab");
    if (!fab) return;
    fab.addEventListener("click", async () => {
        const icon = fab.querySelector("i");
        if (icon) icon.style.animation = "spin .4s ease";
        setTimeout(() => { if (icon) icon.style.animation = ""; }, 400);

        if (!isOnline) {
            showToast("Passez en ligne pour voir les courses", "info");
            return;
        }

        await checkNewRides();
        showToast("Carte mise à jour", "info");
    });
}

/* ═══════════════════════════════════════════════
   SHEET DRAG (collapse / expand)
═══════════════════════════════════════════════ */
function initSheetDrag() {
    const area  = document.getElementById("sheetDragArea");
    const sheet = document.getElementById("mapBottomSheet");
    if (!area || !sheet) return;

    area.addEventListener("click", () => sheet.classList.toggle("collapsed"));

    let startY = 0;
    area.addEventListener("touchstart", e => { startY = e.touches[0].clientY; }, { passive: true });
    area.addEventListener("touchend", e => {
        const dy = e.changedTouches[0].clientY - startY;
        if (dy > 40)  sheet.classList.add("collapsed");
        if (dy < -40) sheet.classList.remove("collapsed");
    }, { passive: true });
}

/* ═══════════════════════════════════════════════
   PROFILE DRAWER
═══════════════════════════════════════════════ */
function initProfileDrawer() {
    const avatarBtn    = document.getElementById("avatarBtn");
    const closeBtn     = document.getElementById("profileCloseBtn");

    if (avatarBtn) {
        avatarBtn.addEventListener("click", openProfile);
        avatarBtn.addEventListener("keydown", e => { if (e.key === "Enter") openProfile(); });
    }
    if (closeBtn) closeBtn.addEventListener("click", closeProfile);
}

function openProfile() {
    const panel = document.getElementById("profilePanel");
    if (panel) { panel.classList.add("open"); panel.setAttribute("aria-hidden", "false"); }
}

function closeProfile() {
    const panel = document.getElementById("profilePanel");
    if (panel) { panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); }
}

// ═══════════════════════════════════════════════
// PORTEFEUILLE
// ═══════════════════════════════════════════════
function openWallet() {
  const panel = document.getElementById('walletPanel');
  if (panel) {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    loadWalletData();
  }
}

function closeWallet() {
  const panel = document.getElementById('walletPanel');
  if (panel) {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }
}

async function loadWalletData() {
  const balanceEl = document.getElementById('walletBalance');
  const container = document.getElementById('walletTransactions');
  if (!balanceEl || !container) return;

  try {
    const data = await fetchWallet();
    if (data.status === 'success') {
      balanceEl.textContent = data.balance.toLocaleString('fr-FR') + ' FCFA';
      renderTransactions(data.transactions, container);
    } else {
      showToast('Erreur chargement du portefeuille', 'error');
    }
  } catch (e) {
    showToast('Erreur réseau', 'error');
  }
}

function formatDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderTransactions(transactions, container) {
  if (!container) return;
  if (!transactions || transactions.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-title">Aucune transaction</div></div>';
    return;
  }

  container.innerHTML = transactions.map(tx => {
    const sign = tx.amount_fcfa >= 0 ? '+' : '';
    const typeLabel = tx.type === 'commission' ? 'Commission' :
                      tx.type === 'recharge' ? 'Recharge' : 'Ajustement';
    const statusClass = tx.status === 'completed' ? 'completed' :
                        tx.status === 'pending' ? 'pending' : 'rejected';
    const dateFormatted = formatDate(tx.created_at);
    return `
      <div class="transaction-item">
        <div class="tx-info">
          <span class="tx-type">${typeLabel}</span>
          <span class="tx-date">${dateFormatted}</span>
        </div>
        <div class="tx-amount ${tx.amount_fcfa >= 0 ? 'positive' : 'negative'}">
          ${sign}${Math.abs(tx.amount_fcfa)} FCFA
        </div>
        <span class="tx-status ${statusClass}">${tx.status}</span>
        ${tx.description ? `<div class="tx-desc">${tx.description}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ── Modale de recharge ────────────────────────
function openRechargeModal() {
  const modal = document.getElementById('rechargeModal');
  if (modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('rechargeAmount')?.focus();
  }
}

function closeRechargeModal() {
  const modal = document.getElementById('rechargeModal');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

async function submitRechargeRequest(event) {
  event.preventDefault();
  const amount = parseInt(document.getElementById('rechargeAmount')?.value || '0');
  const operator = document.getElementById('rechargeOperator')?.value || '';
  const reference = document.getElementById('rechargeReference')?.value.trim() || '';

  if (amount <= 0) {
    showToast('Montant invalide (doit être > 0)', 'error');
    return;
  }
  if (!operator) {
    showToast('Sélectionnez un opérateur', 'error');
    return;
  }

  const submitBtn = event.target.querySelector('.modal-submit');
  const restore = setButtonLoading ? setButtonLoading(submitBtn, 'Envoi…') : (() => {});
  try {
    const res = await requestRecharge({ amount, operator, reference });
    if (res.status === 'success') {
      showToast('Demande envoyée, en attente de validation', 'success');
      closeRechargeModal();
      // Rafraîchir le portefeuille si ouvert
      if (document.getElementById('walletPanel')?.classList.contains('open')) {
        loadWalletData();
      }
    } else {
      showToast(res.message || 'Erreur lors de la demande', 'error');
    }
  } catch (e) {
    showToast('Erreur réseau', 'error');
  } finally {
    restore();
  }
}

// ═══════════════════════════════════════════════
// MES DOCUMENTS (KYC — renouvellement)
// ═══════════════════════════════════════════════

// Métadonnées d'affichage par groupe de document. `hasVerso: false` pour
// la carte grise (photo unique), cohérent avec le schéma backend
// (carte_grise_photo, une seule colonne, contrairement aux 4 autres
// groupes qui ont *_photo_recto et *_photo_verso).
const DOCUMENT_GROUPS = {
  cni:          { label: "CNI",                  numberLabel: "Numéro de CNI",             hasVerso: true  },
  carte_grise:  { label: "Carte grise",           numberLabel: "N° d'immatriculation",      hasVerso: false },
  permit:       { label: "Permis de conduire",    numberLabel: "Numéro de permis",          hasVerso: true  },
  capacity:     { label: "Carte de capacité",     numberLabel: "Numéro de carte",           hasVerso: true  },
  license:      { label: "Licence professionnelle", numberLabel: "Numéro de licence",       hasVerso: true  }
};

// Seuils d'alerte proactive (en jours avant expiration) — cf. rapport KYC,
// §3.2 : rien au-delà de 15j, alerte discrète 15-3j, alerte insistante <3j.
const DOC_ALERT_WARN_DAYS  = 15;
const DOC_ALERT_URGENT_DAYS = 3;

function openDocuments() {
  const panel = document.getElementById("documentsPanel");
  if (panel) {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    loadMyDocuments();
  }
}

function closeDocuments() {
  const panel = document.getElementById("documentsPanel");
  if (panel) {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }
}

async function loadMyDocuments() {
  const container = document.getElementById("documentsList");
  const banner = document.getElementById("documentsBanner");
  if (!container) return;

  try {
    const data = await fetchMyDocuments();
    if (data.status !== "success" || !data.documents) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Erreur de chargement</div></div>';
      return;
    }
    renderDocumentsList(data.documents, container);
    updateDocumentsAlertDot(data.documents);
    if (banner) banner.innerHTML = "";
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Erreur réseau</div></div>';
  }
}

// Le petit point rouge sur le bouton "Mes documents" du profil — visible
// sans avoir à ouvrir le tiroir, dès qu'un document est sous le seuil
// d'alerte ou déjà rejeté. Volontairement discret (pas de popup), voir
// rapport KYC §3.2.
function updateDocumentsAlertDot(documents) {
  const dot = document.getElementById("documentsAlertDot");
  if (!dot) return;
  const needsAttention = Object.values(documents).some(doc =>
    (typeof doc.days_until_expiration === "number" && doc.days_until_expiration <= DOC_ALERT_WARN_DAYS) ||
    (doc.pending && doc.pending.status === "rejected")
  );
  dot.hidden = !needsAttention;
}

function renderDocumentsList(documents, container) {
  container.innerHTML = Object.entries(DOCUMENT_GROUPS).map(([key, meta]) => {
    const doc = documents[key] || {};
    return renderDocumentCard(key, meta, doc);
  }).join("");

  // Boutons "Modifier" — un listener par carte plutôt qu'un onclick inline,
  // pour rester cohérent avec le reste du fichier (voir initReportModal()).
  container.querySelectorAll("[data-doc-edit]").forEach(btn => {
    btn.addEventListener("click", () => openRenewalModal(btn.dataset.docEdit, documents[btn.dataset.docEdit]));
  });
}

function renderDocumentCard(key, meta, doc) {
  const hasPending = doc.pending && doc.pending.status === "pending";
  const isRejected = doc.pending && doc.pending.status === "rejected";

  let statusPill = '<span class="doc-status-pill approved">À jour</span>';
  if (hasPending) statusPill = '<span class="doc-status-pill pending">En vérification</span>';
  else if (isRejected) statusPill = '<span class="doc-status-pill rejected">Rejeté</span>';

  const daysLeft = doc.days_until_expiration;
  let expiryWarning = "";
  if (typeof daysLeft === "number" && daysLeft <= DOC_ALERT_WARN_DAYS && !hasPending) {
    const urgent = daysLeft <= DOC_ALERT_URGENT_DAYS;
    const text = daysLeft <= 0
      ? "Ce document est expiré"
      : `Expire dans ${daysLeft} jour${daysLeft > 1 ? "s" : ""}`;
    expiryWarning = `<div class="doc-expiry-warning" style="${urgent ? "" : "color:var(--c-amber-d)"}">
      <i class="ti ti-alert-triangle" aria-hidden="true"></i> ${text}
    </div>`;
  }

  const thumbs = [doc.photo_recto, meta.hasVerso ? doc.photo_verso : null]
    .filter(Boolean)
    .map(url => `<img class="doc-thumb" src="${url}" alt="${meta.label}" loading="lazy" />`)
    .join("");

  let pendingBanner = "";
  if (hasPending) {
    pendingBanner = `<div class="doc-pending-banner"><i class="ti ti-clock" aria-hidden="true"></i> Renouvellement envoyé, en attente de vérification par l'admin.</div>`;
  } else if (isRejected) {
    pendingBanner = `<div class="doc-rejected-banner">Renouvellement rejeté.
      <span class="doc-reject-reason">${escapeHtml(doc.pending.rejection_reason || "Motif non précisé")}</span>
    </div>`;
  }

  // Bouton "Modifier" masqué tant qu'un renouvellement est déjà en
  // attente, pour éviter les doublons de soumission (cf. rapport KYC §2.4).
  const editBtn = hasPending
    ? ""
    : `<button class="doc-btn-edit" type="button" data-doc-edit="${key}">
         <i class="ti ti-edit" aria-hidden="true"></i> ${isRejected ? "Resoumettre" : "Modifier"}
       </button>`;

  return `
    <div class="doc-card">
      <div class="doc-card-header">
        <span class="doc-card-title">${meta.label}</span>
        ${statusPill}
      </div>
      <div class="profile-row">
        <span class="profile-row-label">${meta.numberLabel}</span>
        <span class="profile-row-val">${escapeHtml(doc.number || "—")}</span>
      </div>
      <div class="profile-row">
        <span class="profile-row-label">Expiration</span>
        <span class="profile-row-val">${doc.expiration ? formatDateOnly(doc.expiration) : "—"}</span>
      </div>
      ${thumbs ? `<div class="doc-thumbs">${thumbs}</div>` : ""}
      ${expiryWarning}
      ${pendingBanner}
      ${editBtn}
    </div>
  `;
}

function formatDateOnly(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// escapeHtml() existe déjà côté client (client-ui.js) — absente ici tant
// que le fichier commun frontend/js/escape-html.js (chantier XSS, cf.
// audit sécurité) n'est pas extrait. Définie localement en attendant,
// pour ne pas insérer client_problem_description-like data brute.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ── Modale de renouvellement ──────────────────
function openRenewalModal(docKey, doc) {
  const meta = DOCUMENT_GROUPS[docKey];
  if (!meta) return;

  document.getElementById("renewalModalTitle").textContent = `Renouveler — ${meta.label}`;
  document.getElementById("renewalDocumentGroup").value = docKey;
  document.getElementById("renewalNumberLabel").textContent = meta.numberLabel;
  document.getElementById("renewalNumber").value = doc?.number || "";
  document.getElementById("renewalExpiration").value = doc?.expiration ? doc.expiration.slice(0, 10) : "";
  document.getElementById("renewalPhotoRecto").value = "";
  document.getElementById("renewalPhotoVerso").value = "";

  const versoLabel = document.getElementById("renewalPhotoVersoLabel");
  const versoInput = document.getElementById("renewalPhotoVerso");
  versoLabel.hidden = !meta.hasVerso;
  versoInput.hidden = !meta.hasVerso;
  versoInput.required = false; // jamais obligatoire (carte grise n'en a pas, et resoumission tolère de garder l'ancienne verso)

  const modal = document.getElementById("documentRenewalModal");
  if (modal) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
}

function closeRenewalModal() {
  const modal = document.getElementById("documentRenewalModal");
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
  document.getElementById("documentRenewalForm")?.reset();
}

async function submitDocumentRenewalForm(event) {
  event.preventDefault();
  const form = document.getElementById("documentRenewalForm");
  const submitBtn = document.getElementById("renewalSubmitBtn");
  const restore = typeof setButtonLoading === "function" ? setButtonLoading(submitBtn, "Envoi…") : (() => {});

  try {
    const formData = new FormData(form);
    const res = await submitDocumentRenewal(formData);
    if (res.status === "success") {
      showToast("Document envoyé, en attente de vérification.", "success");
      closeRenewalModal();
      loadMyDocuments();
    } else {
      showToast(res.message || "Erreur lors de l'envoi.", "error");
    }
  } catch (e) {
    showToast("Erreur réseau — vérifiez votre connexion et réessayez.", "error");
  } finally {
    restore();
  }
}

// ── Initialisation des événements ─────────────
function initDocuments() {
  const openBtn = document.getElementById("documentsOpenBtn");
  const closeBtn = document.getElementById("documentsCloseBtn");
  const cancelBtn = document.getElementById("renewalCancelBtn");
  const form = document.getElementById("documentRenewalForm");
  const modalOverlay = document.getElementById("documentRenewalModal");

  if (openBtn) openBtn.addEventListener("click", openDocuments);
  if (closeBtn) closeBtn.addEventListener("click", closeDocuments);
  if (cancelBtn) cancelBtn.addEventListener("click", closeRenewalModal);
  if (form) form.addEventListener("submit", submitDocumentRenewalForm);
  if (modalOverlay) modalOverlay.addEventListener("click", e => {
    if (e.target === modalOverlay) closeRenewalModal();
  });

  // Vérification silencieuse au chargement (badge discret uniquement,
  // pas d'alerte plein écran) — cf. rapport KYC §3.3, point 1.
  loadDocumentsAlertOnly();

  // Re-vérification au retour au premier plan — cf. rapport KYC §3.3,
  // point 2. Une date d'expiration ne change qu'une fois par jour, donc
  // un simple check à chaque retour d'arrière-plan suffit ; pas besoin
  // d'un intervalle dédié qui tournerait en continu pour rien.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadDocumentsAlertOnly();
    }
  });
}

// Charge uniquement de quoi renseigner le badge (pas d'ouverture du
// tiroir) — appelé au chargement de page et au retour au premier plan.
async function loadDocumentsAlertOnly() {
  try {
    const data = await fetchMyDocuments();
    if (data.status === "success" && data.documents) {
      updateDocumentsAlertDot(data.documents);
    }
  } catch (e) {
    // silencieux — le badge reste dans son dernier état connu
  }
}

// ── Initialisation des événements ─────────────
function initWallet() {
  const openBtn = document.getElementById('walletHeaderBtn');
  const closeBtn = document.getElementById('walletCloseBtn');
  const rechargeOpenBtn = document.getElementById('rechargeOpenBtn');
  const rechargeCancelBtn = document.getElementById('rechargeCancelBtn');
  const modalOverlay = document.getElementById('rechargeModal');

  if (openBtn) openBtn.addEventListener('click', openWallet);
  if (closeBtn) closeBtn.addEventListener('click', closeWallet);
  if (rechargeOpenBtn) rechargeOpenBtn.addEventListener('click', openRechargeModal);
  if (rechargeCancelBtn) rechargeCancelBtn.addEventListener('click', closeRechargeModal);
  if (modalOverlay) modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeRechargeModal();
  });

  // Fermer le tiroir wallet avec le bouton de navigation "Retour" (si présent)
  // On peut aussi fermer via le clic en dehors du panneau (pas implémenté)
}

/* ═══════════════════════════════════════════════
   FILTER PILLS (onglet Courses)
═══════════════════════════════════════════════ */
function initFilterPills() {
    document.querySelectorAll(".filter-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            setRideFilter(pill.dataset.filter);
        });
    });
}

function setRideFilter(filter) {
    if (!["accepted", "arrived", "started"].includes(filter)) return;

    activeFilter = filter;
    document.querySelectorAll(".filter-pill").forEach(pill => {
        pill.classList.toggle("active-pill", pill.dataset.filter === filter);
    });

    if (activeTab !== "courses") {
        switchTab("courses");
        return;
    }

    renderActiveCourses();
}

/* ═══════════════════════════════════════════════
   REPORT MODAL
═══════════════════════════════════════════════ */
function initReportModal() {
    const cancelBtn = document.getElementById("reportCancelBtn");
    const submitBtn = document.getElementById("reportSubmitBtn");
    const overlay   = document.getElementById("reportModal");

    if (cancelBtn) cancelBtn.addEventListener("click", closeReportModal);
    if (overlay)   overlay.addEventListener("click", e => { if (e.target === overlay) closeReportModal(); });

    if (submitBtn) {
        submitBtn.addEventListener("click", async () => {
            const text = (document.getElementById("reportTextarea")?.value || "").trim();
            if (!text) { showToast("Veuillez décrire le problème", "error"); return; }
            await submitReportAPI(reportRideId, text, submitBtn);
        });
    }
}

function openReportModal(rideId) {
    reportRideId = rideId;
    const modal = document.getElementById("reportModal");
    const sub   = document.getElementById("reportModalSub");
    const ta    = document.getElementById("reportTextarea");
    if (sub)   sub.textContent = `Course #${rideId}`;
    if (ta)    ta.value = "";
    if (modal) {
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        setTimeout(() => ta?.focus(), 300);
    }
}

function closeReportModal() {
    const modal = document.getElementById("reportModal");
    if (modal) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
    }
    reportRideId = null;
}

/* ═══════════════════════════════════════════════
   TOAST SYSTEM
═══════════════════════════════════════════════ */
const TOAST_ICONS = {
    success: "ti ti-check",
    error:   "ti ti-x",
    info:    "ti ti-info-circle",
    warning: "ti ti-alert-triangle",
};

// Vibration générique appliquée à tous les toasts (chantier son/vibration,
// 06/07/2026) — pattern court unique, décision actée avec Bernardo. Les
// événements qui ont un son/pattern dédié (nouvelle course, annulation)
// appellent notifyFeedback() juste après leur propre showToast() : cet appel
// plus spécifique remplace immédiatement la vibration générique ci-dessous
// (les deux appels ne "s'additionnent" pas, le second écrase le premier).
const GENERIC_TOAST_VIBRATE_PATTERN = [35];

function showToast(message, type = "info", duration = 3000) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const icon = document.createElement("i");
    icon.className = TOAST_ICONS[type] || "ti ti-info-circle";
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(text);
    stack.appendChild(toast);

    if (typeof window.notifyFeedback === "function") {
        window.notifyFeedback({ vibrate: GENERIC_TOAST_VIBRATE_PATTERN });
    }

    setTimeout(() => {
        toast.classList.add("out");
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
    }, duration);
}

/* ═══════════════════════════════════════════════
   RENDER FUNCTIONS
═══════════════════════════════════════════════ */

function updateRideLists() {
    renderPendingRides();
    if (activeTab === "courses") renderActiveCourses();
    updateNavBadges();
    updateFilterCounts();
    showClientCancellationAlerts();
}

// Diffing (chantier polling optimisé, 4bis) : appelée depuis checkNewRides()
// (chauffeur-api.js) juste avant que allRides ne soit remplacé par la réponse
// fraîche — compare les ID pending des deux tableaux et ne notifie que sur un
// ID absent de l'ancien. Ne modifie rien : allRides continue d'être peuplé
// par remplacement complet ailleurs, cette fonction ne fait que décider s'il
// faut notifier.
function notifyIfNewPendingRides(previousRides, freshRides) {
    const previousPendingIds = new Set(
        (previousRides || [])
            .filter(r => r.status === "pending")
            .map(r => String(r.id))
    );

    const newPendingRides = (freshRides || [])
        .filter(r => r.status === "pending" && !previousPendingIds.has(String(r.id)));

    if (newPendingRides.length === 0) return;

    const nb = newPendingRides.length;

    // Décision actée le 06/07/2026 : trajet affiché uniquement quand une
    // seule course arrive à la fois (cas le plus fréquent en régime normal).
    // Si plusieurs arrivent dans le même cycle de poll (typiquement à la
    // connexion, plusieurs pending déjà en attente), on garde le message
    // groupé — afficher N toasts avec trajet + son4 chacun serait plus
    // fatigant qu'utile pour le chauffeur.
    let message;
    if (nb === 1) {
        const ride = newPendingRides[0];
        const pickup = ride.pickup || "?";
        const destination = ride.destination || "?";
        message = `Nouvelle course : ${pickup} → ${destination}`;
    } else {
        message = `${nb} nouvelles courses disponibles !`;
    }

    showToast(message, "success", 4000);

    // Un seul appel notifyFeedback ici, que nb soit 1 ou > 1 — le son4 ne
    // doit jouer qu'une fois par cycle de détection, jamais une fois par
    // course individuelle (évite la cacophonie au moment de la connexion).
    // notify: {...} ajouté le 13/07/2026 — jusqu'ici réservé au client
    // (voir commentaire en tête de notify-feedback.js), le chauffeur en
    // profite maintenant pour les nouvelles courses : seul événement qui
    // justifie vraiment de réveiller l'attention si l'onglet n'est pas au
    // premier plan (même limite que côté client : ne fonctionne que tant
    // que l'onglet reste ouvert quelque part, pas app totalement fermée —
    // ça, c'est le rôle du FCM ci-dessous).
    if (typeof window.notifyFeedback === "function") {
        window.notifyFeedback({
            sound: "new_ride",
            vibrate: [140, 70, 140],
            notify: { title: "Nouvelle course disponible", body: message, tag: "taxigo-ride" }
        });
    }
}

function renderPendingRides() {
    const container = document.getElementById("pendingRides");
    if (!container) return;

    const pending = allRides.filter(r => r.status === "pending");

    const badge    = document.getElementById("pendingBadge");
    const navBadge = document.getElementById("navPendingBadge");
    if (badge) {
        badge.textContent = pending.length;
        badge.className   = "pending-badge" + (pending.length === 0 ? " zero" : "");
    }
    if (navBadge) {
        navBadge.textContent = pending.length || "";
        navBadge.classList.toggle("show", pending.length > 0);
    }

    const sheet = document.getElementById("mapBottomSheet");
    if (pending.length > 0 && sheet?.classList.contains("collapsed")) {
        sheet.classList.remove("collapsed");
    }

    container.innerHTML = "";

    if (pending.length === 0) {
        container.appendChild(emptyState(
            "🚦",
            "Aucune course en attente",
            isOnline ? "Patientez…" : "Passez en ligne pour recevoir des demandes"
        ));
        return;
    }

    pending.forEach(ride => container.appendChild(createRideCard(ride)));
}

function renderActiveCourses() {
    const container = document.getElementById("activeRidesList");
    const subEl     = document.getElementById("activeCoursesSub");
    if (!container) return;

    const active = allRides.filter(r => r.status === "accepted" || r.status === "arrived" || r.status === "started");

    let filtered = active;
    if (activeFilter === "accepted") filtered = active.filter(r => r.status === "accepted");
    if (activeFilter === "arrived")  filtered = active.filter(r => r.status === "arrived");
    if (activeFilter === "started")  filtered = active.filter(r => r.status === "started");

    if (subEl) {
        subEl.textContent = active.length > 0
            ? `${active.length} course${active.length > 1 ? "s" : ""} active${active.length > 1 ? "s" : ""}`
            : "Aucune course active";
    }

    container.innerHTML = "";

    if (filtered.length === 0) {
        container.appendChild(emptyState(
            "🚕",
            "Aucune course ici",
            activeFilter === "accepted" ? "Acceptez une course depuis la carte" : "Changez le filtre"
        ));
        return;
    }

    filtered.forEach(ride => container.appendChild(createRideCard(ride)));
}

function updateFilterCounts() {
    const accepted = allRides.filter(r => r.status === "accepted").length;
    const arrived  = allRides.filter(r => r.status === "arrived").length;
    const started  = allRides.filter(r => r.status === "started").length;

    setText("acceptedFilterCount", accepted);
    setText("arrivedFilterCount", arrived);
    setText("startedFilterCount", started);
}

function updateNavBadges() {
    const active         = allRides.filter(r => r.status === "accepted" || r.status === "arrived" || r.status === "started");
    const navActiveBadge = document.getElementById("navActivesBadge");
    if (navActiveBadge) {
        navActiveBadge.textContent = active.length || "";
        navActiveBadge.classList.toggle("show", active.length > 0);
    }
}

/* ─── Ride Card ─────────────────────────────── */

function createRideCard(ride) {
    const status = ride.status;

    const card = document.createElement("article");
    card.className = `ride-card ${status}`;
    card.setAttribute("role", "listitem");

    // Header
    const header = document.createElement("div");
    header.className = "ride-card-header";

    const idEl = document.createElement("span");
    idEl.className   = "ride-id";
    idEl.textContent = `Course #${ride.id}`;

    const badge = document.createElement("span");
    badge.className   = `ride-status-badge ${badgeClass(status)}`;
    badge.textContent = statusLabel(status);

    header.appendChild(idEl);
    header.appendChild(badge);

    // Route
    const route = document.createElement("div");
    route.className = "ride-route";

    const rowPickup = document.createElement("div");
    rowPickup.className = "route-row";
    const dotPickup = document.createElement("span");
    dotPickup.className = "route-dot dot-pickup";
    const labelPickup = document.createElement("span");
    labelPickup.className   = "route-label";
    labelPickup.textContent = ride.pickup;
    rowPickup.appendChild(dotPickup);
    rowPickup.appendChild(labelPickup);

    const connector = document.createElement("div");
    connector.className      = "route-connector";
    connector.style.marginLeft = "3px";

    const rowDest = document.createElement("div");
    rowDest.className = "route-row";
    const dotDest = document.createElement("span");
    dotDest.className = "route-dot dot-dest";
    const labelDest = document.createElement("span");
    labelDest.className   = "route-label";
    labelDest.textContent = ride.destination;
    rowDest.appendChild(dotDest);
    rowDest.appendChild(labelDest);

    route.appendChild(rowPickup);
    route.appendChild(connector);
    route.appendChild(rowDest);

    // Meta
    const meta = document.createElement("div");
    meta.className = "ride-meta";

    [
        { val: `👥 ${ride.passengers}` },
        { val: `📏 ${parseFloat(ride.distance_km).toFixed(1)} km` },
    ].forEach(({ val }) => {
        const item = document.createElement("span");
        item.className   = "ride-meta-item";
        item.textContent = val;
        meta.appendChild(item);
    });

    const priceItem = document.createElement("span");
    priceItem.className   = "ride-meta-item ride-price";
    priceItem.textContent = `${parseInt(ride.price_fcfa).toLocaleString()} FCFA`;
    meta.appendChild(priceItem);

    // Actions
    const actions = document.createElement("div");
    actions.className = "ride-actions";

    if (status === "pending") {
        actions.appendChild(makeActionBtn("btn-accept", "✓ Accepter", btn => acceptRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-refuse", "✕ Refuser",  btn => refuseRide(ride.id, btn)));
    } else if (status === "accepted") {
        actions.appendChild(makeActionBtn("btn-start",  "Arrivé", btn => arriveRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-cancel", "✕ Annuler",   btn => cancelRide(ride.id, btn)));
    } else if (status === "arrived") {
        actions.appendChild(makeActionBtn("btn-start",  "🚀 Commencer", btn => startRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-cancel", "✕ Annuler",   btn => cancelRide(ride.id, btn)));
    } else if (status === "started") {
        actions.appendChild(makeActionBtn("btn-complete", "✅ Terminer",  btn => completeRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-problem",  "⚠ Problème", () => reportProblem(ride.id)));
    }

    card.appendChild(header);
    card.appendChild(route);
    card.appendChild(meta);
    if (actions.children.length > 0) card.appendChild(actions);

    return card;
}

function makeActionBtn(cls, label, handler) {
    const btn = document.createElement("button");
    btn.className = `action-btn ${cls}`;
    btn.type      = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => handler(btn));
    return btn;
}

function emptyState(icon, title, desc) {
    const el = document.createElement("div");
    el.className = "empty-state";
    const iconEl = document.createElement("div");
    iconEl.className = "empty-icon"; iconEl.textContent = icon;
    const titleEl = document.createElement("div");
    titleEl.className = "empty-title"; titleEl.textContent = title;
    const descEl = document.createElement("div");
    descEl.className = "empty-desc"; descEl.textContent = desc;
    el.appendChild(iconEl); el.appendChild(titleEl); el.appendChild(descEl);
    return el;
}

function badgeClass(status) {
    return { pending: "badge-pending", accepted: "badge-accepted",
             arrived: "badge-arrived",
             started: "badge-started", completed: "badge-completed" }[status] || "";
}

function statusLabel(status) {
    return { pending: "En attente", accepted: "Acceptée",
             arrived: "Arrivée",
             started: "En cours",   completed: "Terminée" }[status] || status;
}

/* ═══════════════════════════════════════════════
   MAP MARKERS & ROUTES
═══════════════════════════════════════════════ */
async function updateRideMarkers() {
    if (isUpdatingRoutes) return;
    isUpdatingRoutes = true;

    try {
        const driverPos = driverMarker ? driverMarker.getLatLng() : null;
        if (!driverPos) return;

        const { lat: driverLat, lng: driverLng } = driverPos;
        const activeRides = allRides.filter(r => r.status === "accepted" || r.status === "arrived" || r.status === "started");
        const activeIds   = new Set(activeRides.map(r => r.id));

        routeCache.forEach((_, id) => { if (!activeIds.has(id)) routeCache.delete(id); });

        rideMarkers.forEach(m => map.removeLayer(m));         rideMarkers = [];
        destinationMarkers.forEach(m => map.removeLayer(m));  destinationMarkers = [];
        routeLayers.forEach(l => map.removeLayer(l));          routeLayers = [];
        destinationMap.clear();

        for (const ride of activeRides) {
            const pickupLat = parseFloat(ride.pickup_lat);
            const pickupLng = parseFloat(ride.pickup_lng);
            const destLat   = parseFloat(ride.destination_lat);
            const destLng   = parseFloat(ride.destination_lng);

            if ([pickupLat, pickupLng, destLat, destLng].some(isNaN)) continue;

            if (ride.status === "accepted" || ride.status === "arrived") {
                const pm = L.marker([pickupLat, pickupLng], {
                    icon: L.divIcon({ html: "📍", className: "pickup-marker", iconSize: [30, 30], iconAnchor: [15, 30] })
                }).addTo(map);
                pm.bindPopup(createSafePopup(`Départ — Course #${ride.id}`, ride.pickup));
                rideMarkers.push(pm);
            }

            const destKey = `${destLat.toFixed(5)},${destLng.toFixed(5)}`;
            if (!destinationMap.has(destKey)) {
                const dm = L.marker([destLat, destLng], {
                    icon: L.icon({
                        iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
                        shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
                        iconSize: [25, 41], iconAnchor: [12, 41], shadowSize: [41, 41]
                    })
                }).addTo(map);
                destinationMarkers.push(dm);
                destinationMap.set(destKey, { marker: dm, rides: [ride.id], destination: ride.destination });
            } else {
                destinationMap.get(destKey).rides.push(ride.id);
            }

            const cacheKey = String(ride.id);
            const cached   = routeCache.get(cacheKey);
            const moved    = !cached || getDistanceFromLatLng(driverLat, driverLng, cached.driverLat, cached.driverLng) >= 0.1;

            if (!moved && cached.layers) {
                cached.layers.forEach(l => l.addTo(map));
            } else {
                const layers = [];

                if (ride.status === "accepted" || ride.status === "arrived") {
                    const r1 = await calculateRoute(driverLng, driverLat, pickupLng, pickupLat);
                    if (r1) {
                        const l = L.geoJSON(r1, { style: { color: "#f59e0b", weight: 5, opacity: .85 } }).addTo(map);
                        layers.push(l); routeLayers.push(l);
                    }
                    const r2 = await calculateRoute(pickupLng, pickupLat, destLng, destLat);
                    if (r2) {
                        const l = L.geoJSON(r2, { style: { color: "#10b981", weight: 5, opacity: .8, dashArray: "6,4" } }).addTo(map);
                        layers.push(l); routeLayers.push(l);
                    }
                } else if (ride.status === "started") {
                    const r = await calculateRoute(driverLng, driverLat, destLng, destLat);
                    if (r) {
                        const l = L.geoJSON(r, { style: { color: "#3b82f6", weight: 5, opacity: .85 } }).addTo(map);
                        layers.push(l); routeLayers.push(l);
                    }
                }

                routeCache.set(cacheKey, { driverLat, driverLng, layers, ts: Date.now() });
            }
        }

        destinationMap.forEach(info => {
            const popupEl  = document.createElement("div");
            const titleEl  = document.createElement("strong");
            titleEl.textContent = "Destination";
            const locEl    = document.createElement("p");
            locEl.style.margin  = "4px 0";
            locEl.textContent   = info.destination;
            const ridesEl  = document.createElement("p");
            ridesEl.style.margin  = "0";
            ridesEl.textContent   = info.rides.length > 1
                ? `${info.rides.length} courses : #${info.rides.join(", #")}`
                : `Course #${info.rides[0]}`;
            popupEl.appendChild(titleEl);
            popupEl.appendChild(locEl);
            popupEl.appendChild(ridesEl);
            info.marker.bindPopup(popupEl);
        });

    } finally {
        isUpdatingRoutes = false;
    }
}

function createSafePopup(title, body) {
    const el = document.createElement("div");
    const t  = document.createElement("strong");
    t.textContent = title;
    const b  = document.createElement("div");
    b.style.marginTop = "4px";
    b.textContent     = body;
    el.appendChild(t);
    el.appendChild(b);
    return el;
}

/* ═══════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════ */
function updateDashboard() {
    const completed = allRides.filter(r => r.status === "completed");
    const active    = allRides.filter(r => r.status === "accepted" || r.status === "arrived" || r.status === "started");
    const total     = completed.reduce((s, r) => {
        const price      = parseInt(r.price_fcfa || 0);
        const commission = Math.round(price * 0.20);
        return s + (price - commission);
    }, 0);
    const avg       = completed.length ? Math.round(total / completed.length) : 0;
    const dist      = completed.reduce((s, r) => s + parseFloat(r.distance_km || 0), 0);

    setText("statsCompleted", completed.length);
    setText("statsActive",    active.length);
    setText("statsTotal",     total.toLocaleString() + " FCFA");
    setText("statsAverage",   avg.toLocaleString() + " FCFA");
    setText("statsDistance",  dist.toFixed(1) + " km");

    const historyEl = document.getElementById("completedRides");
    if (!historyEl) return;
    historyEl.innerHTML = "";

    if (completed.length === 0) {
        historyEl.appendChild(emptyState("📋", "Aucune course terminée", ""));
        return;
    }

    completed.slice().reverse().forEach(ride => historyEl.appendChild(createRideCard(ride)));
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

/* ═══════════════════════════════════════════════
   ALERTE ANNULATION CLIENT
   La course a été acceptée/arrivée/démarrée puis
   annulée par le client (status -> cancelled_client).
   get_rides.php renvoie ces courses jusqu'à 24h après
   cancelled_at pour laisser le temps au polling (5s)
   de les voir même si l'app était en arrière-plan.
   Dédupliqué par ride.id : une seule alerte par course,
   même si elle reste dans allRides pendant 24h.
═══════════════════════════════════════════════ */
function showClientCancellationAlerts() {
    (allRides || []).forEach(ride => {
        if (ride.status !== "cancelled_client") return;
        const key = String(ride.id); // JSON.stringify convertit les clés en chaînes ; on normalise dès l'écriture pour que .has() reste cohérent après un rechargement depuis localStorage
        if (shownCancellations.has(key)) return;

        markAlertShown(shownCancellations, CANCELLATIONS_STORAGE_KEY, key);
        openClientCancellationAlert(ride);
    });
}

// Chantier son/vibration (06/07/2026) : remplace l'ancienne alerte plein
// écran bloquante par un toast — la déduplication (shownCancellations +
// localStorage, gérée par showClientCancellationAlerts() ci-dessus) est
// inchangée, seul l'affichage change. Le point de départ (ride.pickup) est
// déjà renvoyé par get_rides.php, aucun changement backend nécessaire.
function openClientCancellationAlert(ride) {
    const pickup = ride.pickup || `course #${ride.id}`;
    const body = `Course à ${pickup} annulée`;
    showToast(body, "warning", 5000);

    if (typeof window.notifyFeedback === "function") {
        window.notifyFeedback({
            sound: "cancelled",
            vibrate: [100, 60, 100, 60, 100],
            notify: { title: "Course annulée", body, tag: "taxigo-ride" }
        });
    }
}

/* ═══════════════════════════════════════════════
   UTILITAIRES GÉOMÉTRIE
═══════════════════════════════════════════════ */
function getDistanceFromLatLng(lat1, lng1, lat2, lng2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
                 Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                 Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}