/* ============================================================
   TaxiGo Admin — admin-ui.js
   Gestion de l'interface : navigation, rendu des sections,
   carte temps réel, tableaux, filtres.
   ============================================================ */

"use strict";

/* ── État global ──────────────────────────────────────────── */
const AdminState = {
    currentSection: "dashboard",
    adminUser: null,
    driversMap: null,          // instance Leaflet
    driverMarkers: {},         // { id: marker }
    refreshInterval: null,     // pour la carte live
    ridesInterval: null,       // intervalle section courses
    chauffeursInterval: null,  // intervalle section chauffeurs
    ridesFilter: { status: "", q: "", date_from: "", date_to: "" },
    chauffeursFilter: { q: "", status: "" },
    clientsFilter: { q: "", status: "" },
    dashboardInterval: null,

    // Chantier 4 (v3) — polling global des signalements client
    problemsInterval: null,
    problemLastShownAt: new Map(), // alertKey ("client-12" / "driver-12") -> timestamp (ms) du dernier affichage (sert au rappel toutes les 5 min)
    problemAlertQueue: [],
    problemAlertShowingId: null,   // id du signalement actuellement affiché (null = aucune modale)
    unresolvedProblems: [],        // derniers signalements non traités reçus (alimente le bouton de rappel de la barre du haut)

    // Portefeuille
    walletsFilter: { chauffeur_id: 0, type: '', status: '' },
    walletsInterval: null,
    walletsBadgeInterval: null, // badge sidebar (navWalletsBadge), indépendant de la section active
    shownRechargeIds: new Set(), // recharges déjà signalées (son+vibration) — évite de re-notifier à chaque poll de 30s
    rechargeWatchStarted: false, // évite de notifier pour des recharges déjà en attente au premier chargement
    walletsCache: [],            // dernière liste de portefeuilles reçue (re-rendu sans refetch)
    walletsDetailCache: {},      // historique déjà chargé, par chauffeur_id (évite le spinner au poll de 30 s)

    // Vérification chauffeur (KYC) — même principe que shownRechargeIds :
    // ne notifier (son+vibration) qu'une fois par élément réellement nouveau.
    shownKycPendingIds: new Set(),  // ids chauffeurs vus en kyc_status='pending'
    shownRenewalIds: new Set(),     // ids de renouvellements de documents déjà signalés
    shownExpiredDocIds: new Set(),  // ids chauffeurs déjà signalés pour document expiré
    kycWatchStarted: false          // évite de notifier pour des dossiers déjà en attente au premier chargement
};

/* ── DOM ready ────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", async () => {
    const admin = await checkAdminAuth();
    if (!admin) return;
    AdminState.adminUser = admin;

    renderAdminUser(admin);
    initNavigation();
    initSidebarMobile();
    initLogout();
    initGlobalProblemWatch();
    initWalletsBadgeWatch();
    if (typeof initPushNotifications === "function") initPushNotifications("admin");
    showSection("dashboard");
});

/* ── Auth header ─────────────────────────────────────────── */
function renderAdminUser(admin) {
    const name    = admin.username || "Admin";
    const initial = name.charAt(0).toUpperCase();
    const elName  = document.getElementById("adminName");
    const elInit  = document.getElementById("adminInitial");
    if (elName)  elName.textContent  = name;
    if (elInit)  elInit.textContent  = initial;
}

/* ── Navigation sidebar ──────────────────────────────────── */
function initNavigation() {
    document.querySelectorAll(".nav-item[data-section]").forEach(btn => {
        btn.addEventListener("click", () => {
            const section = btn.dataset.section;
            showSection(section);
            // ferme sidebar sur mobile
            document.querySelector(".sidebar").classList.remove("open");
            document.querySelector(".sidebar-overlay").classList.remove("open");
        });
    });
}

function showSection(name) {
    AdminState.currentSection = name;

    document.querySelectorAll(".nav-item[data-section]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.section === name);
    });

    document.querySelectorAll(".page-section").forEach(el => {
        el.classList.toggle("active", el.id === `section-${name}`);
    });

    const titles = {
        dashboard:  "Tableau de bord",
        map:        "Carte en temps réel",
        rides:      "Courses",
        chauffeurs: "Chauffeurs",
        clients:    "Clients",
        wallets:    "Portefeuille chauffeurs"
    };

    updateRidesFilterOptions();
    const el = document.getElementById("topbarTitle");
    if (el) el.textContent = titles[name] || name;

    // Arrêter les intervalles des autres sections
    if (name !== "map" && AdminState.refreshInterval) {
        clearInterval(AdminState.refreshInterval);
        AdminState.refreshInterval = null;
    }
    if (name !== "dashboard" && AdminState.dashboardInterval) {
        clearInterval(AdminState.dashboardInterval);
        AdminState.dashboardInterval = null;
    }
    if (name !== "rides" && AdminState.ridesInterval) {
        clearInterval(AdminState.ridesInterval);
        AdminState.ridesInterval = null;
    }
    if (name !== "chauffeurs" && AdminState.chauffeursInterval) {
        clearInterval(AdminState.chauffeursInterval);
        AdminState.chauffeursInterval = null;
    }
    if (name !== "wallets" && AdminState.walletsInterval) {
        clearInterval(AdminState.walletsInterval);
        AdminState.walletsInterval = null;
    }
    if (name !== "kyc" && KycState.interval) {
        clearInterval(KycState.interval);
        KycState.interval = null;
    }

    switch (name) {
        case "dashboard":  loadDashboard();  break;
        case "map":        loadMapSection(); break;
        case "rides":      loadRides();      break;
        case "chauffeurs": loadChauffeurs(); break;
        case "clients":    loadClients();    break;
        case "wallets":    loadWallets();    break;
        case "kyc":        loadKyc();        break;
    }
}

/* ── Mobile sidebar ───────────────────────────────────────── */
function initSidebarMobile() {
    const toggle  = document.getElementById("menuToggle");
    const overlay = document.querySelector(".sidebar-overlay");
    const sidebar = document.querySelector(".sidebar");

    toggle?.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        overlay.classList.toggle("open");
        refreshMapAfterSidebarToggle();
    });
    overlay?.addEventListener("click", () => {
        sidebar.classList.remove("open");
        overlay.classList.remove("open");
        refreshMapAfterSidebarToggle();
    });
}

function refreshMapAfterSidebarToggle() {
    if (AdminState.currentSection !== "map" || !AdminState.driversMap) return;
    setTimeout(() => AdminState.driversMap.invalidateSize(), 260);
}

function initLogout() {
    document.getElementById("logoutBtn")?.addEventListener("click", async () => {
        const ok = await confirmAction({
            title: "Déconnecter l'administrateur ?",
            confirmLabel: "Déconnecter",
            cancelLabel: "Annuler",
            danger: true
        });
        if (ok) logoutAdmin();
    });
}

/* ══════════════════════════════════════════════════════════
   SIGNALEMENTS CLIENT — alerte globale plein écran
══════════════════════════════════════════════════════════ */
function initGlobalProblemWatch() {
    checkClientProblems();
    if (AdminState.problemsInterval) clearInterval(AdminState.problemsInterval);
    AdminState.problemsInterval = setInterval(checkClientProblems, 15000);
}

// Badge "Portefeuille chauffeurs" (navWalletsBadge) : nombre de recharges
// en attente, tous chauffeurs confondus. Même principe que
// initGlobalProblemWatch()/navProblemsBadge et refreshKycBadge()/navKycBadge
// (admin-kyc.js) : indépendant de la section affichée, actualisé dès le
// chargement du dashboard puis en polling — pas seulement en entrant dans
// la section "Portefeuille". list_wallet_transactions.php supporte déjà
// le filtre type=recharge&status=pending ; limit=1 suffit, seul
// pagination.total nous intéresse ici (pas de re-téléchargement de la
// liste complète juste pour un chiffre).
function initWalletsBadgeWatch() {
    refreshWalletsBadge();
    if (AdminState.walletsBadgeInterval) clearInterval(AdminState.walletsBadgeInterval);
    AdminState.walletsBadgeInterval = setInterval(refreshWalletsBadge, 30000);
}

async function refreshWalletsBadge() {
    try {
        // limit plus large qu'avant (on avait limit:1, suffisant pour le
        // compteur mais insuffisant pour repérer LESQUELLES sont nouvelles).
        const data  = await fetchWalletTransactions({ type: "recharge", status: "pending", limit: 50 });
        const count = (data.pagination && data.pagination.total) || 0;
        const badge = document.getElementById("navWalletsBadge");
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? "inline-block" : "none";
        }

        const isFirstCheck = !AdminState.rechargeWatchStarted;
        AdminState.rechargeWatchStarted = true;

        const transactions = data.transactions || [];
        const newOnes = transactions.filter(t => !AdminState.shownRechargeIds.has(t.id));
        transactions.forEach(t => AdminState.shownRechargeIds.add(t.id));

        // Au tout premier chargement (arrivée sur le dashboard), on ne
        // notifie pas pour des recharges déjà en attente depuis avant —
        // seulement pour celles qui arrivent APRÈS, pendant que l'admin
        // est connecté. (Les signalements client suivent une autre
        // logique : rappel toutes les 5 min, voir checkClientProblems.)
        if (!isFirstCheck && newOnes.length > 0 && window.notifyFeedback) {
            window.notifyFeedback({ sound: "admin_alert", vibrate: [80, 40, 80] });
        }
    } catch (e) {
        // silencieux — prochain cycle réessaiera
    }
}

const PROBLEM_ALERT_REPEAT_MS = 5 * 60 * 1000; // un signalement non résolu revient toutes les 5 minutes

// Son + vibration d'alerte (premier affichage ET rappels)
function playProblemAlertFeedback() {
    if (window.notifyFeedback) {
        window.notifyFeedback({ sound: "admin_alert", vibrate: [80, 40, 80] });
    }
}

async function checkClientProblems() {
    let problems;
    try { problems = await fetchProblems(); }
    catch (e) { return; }

    // Une même course peut avoir un signalement client ET un signalement chauffeur :
    // chacun devient une alerte à part, identifiée par alertKey ("client-12", "driver-12")
    // et non plus par l'id de la course seul.
    const unresolved = [];
    (problems || []).forEach(p => {
        if (p.client_problem_description && !p.client_problem_resolved_at) {
            unresolved.push({ ...p, kind: "client", alertKey: `client-${p.id}` });
        }
        if (p.problem_description && !p.problem_resolved_at) {
            unresolved.push({ ...p, kind: "driver", alertKey: `driver-${p.id}` });
        }
    });

    updateProblemsBadge(unresolved.length);
    AdminState.unresolvedProblems = unresolved;
    updateProblemsReminder(unresolved.length);

    // Nettoyage : un signalement résolu ailleurs (ex. section Signalements)
    // ne doit ni rester en file d'attente ni garder un minuteur de rappel.
    const unresolvedIds = new Set(unresolved.map(p => p.alertKey));
    AdminState.problemAlertQueue = AdminState.problemAlertQueue.filter(r => unresolvedIds.has(r.alertKey));
    for (const id of AdminState.problemLastShownAt.keys()) {
        if (!unresolvedIds.has(id)) AdminState.problemLastShownAt.delete(id);
    }

    unresolved.forEach(ride => {
        const lastShown = AdminState.problemLastShownAt.get(ride.alertKey);
        const isDue = lastShown === undefined || (Date.now() - lastShown >= PROBLEM_ALERT_REPEAT_MS);
        if (!isDue) return;

        // Déjà à l'écran depuis 5 min sans réaction : inutile de la rouvrir,
        // on rejoue seulement le son + la vibration pour la rendre perceptible.
        if (AdminState.problemAlertShowingId === ride.alertKey) {
            AdminState.problemLastShownAt.set(ride.alertKey, Date.now());
            playProblemAlertFeedback();
            return;
        }
        // Déjà dans la file d'attente : elle s'affichera à son tour
        if (AdminState.problemAlertQueue.some(r => r.alertKey === ride.alertKey)) return;

        enqueueProblemAlert(ride);
    });
}

function updateProblemsBadge(count) {
    const badge = document.getElementById("navProblemsBadge");
    if (!badge) return;
    badge.textContent = count;
    badge.style.display = count > 0 ? "inline-block" : "none";
}

// Bouton "N signalements à traiter" dans la barre du haut, visible depuis toutes les sections
// tant qu'il reste des signalements non traités : permet de rouvrir la fenêtre et de
// cliquer "Marquer comme traité" SANS attendre le prochain rappel de 5 minutes.
function updateProblemsReminder(count) {
    let btn = document.getElementById("problemsReminder");
    if (count === 0) {
        if (btn) btn.remove();
        return;
    }
    if (!btn) {
        const topbar = document.querySelector(".topbar");
        if (!topbar) return;
        btn = document.createElement("button");
        btn.id = "problemsReminder";
        btn.type = "button";
        btn.className = "problems-reminder";
        btn.addEventListener("click", reopenUnresolvedProblems);
        topbar.appendChild(btn);
    }
    btn.textContent = count === 1
        ? "🚨 1 signalement à traiter"
        : `🚨 ${count} signalements à traiter`;
}

// Réouvre (silencieusement) tous les signalements non traités, un par un via la file.
function reopenUnresolvedProblems() {
    AdminState.unresolvedProblems.forEach(ride => {
        if (AdminState.problemAlertShowingId === ride.alertKey) return;
        if (AdminState.problemAlertQueue.some(r => r.alertKey === ride.alertKey)) return;
        AdminState.problemAlertQueue.push({ ...ride, _manual: true }); // _manual : pas de son
    });
    processProblemAlertQueue();
}

function enqueueProblemAlert(ride) {
    AdminState.problemAlertQueue.push(ride);
    processProblemAlertQueue();
}

function processProblemAlertQueue() {
    if (AdminState.problemAlertShowingId !== null || AdminState.problemAlertQueue.length === 0) return;
    const ride = AdminState.problemAlertQueue.shift();
    AdminState.problemAlertShowingId = ride.alertKey;
    openAdminClientProblemAlert(ride);
}

// Ferme la modale SANS résoudre le signalement (croix ✕ ou clic sur le fond).
// problemLastShownAt n'est pas touché : c'est lui qui déclenche le rappel dans 5 min.
function dismissProblemAlert() {
    const overlay = document.getElementById("clientProblemAlert");
    if (overlay) overlay.remove();
    AdminState.problemAlertShowingId = null;
    processProblemAlertQueue(); // affiche la suivante en file, s'il y en a
}

// Affiche une alerte de signalement. ride.kind vaut "client" ou "driver" (lot F4) :
// le texte, la date et l'action « traité » changent selon l'auteur du signalement.
function openAdminClientProblemAlert(ride) {
    const isDriver = ride.kind === "driver";
    // À chaque affichage (premier ou rappel) : on note l'heure + son/vibration
    AdminState.problemLastShownAt.set(ride.alertKey, Date.now());
    if (!ride._manual) playProblemAlertFeedback(); // ouverture demandée par l'admin : pas de son

    const existing = document.getElementById("clientProblemAlert");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "clientProblemAlert";
    overlay.className = "client-problem-alert";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", isDriver ? "Signalement chauffeur" : "Signalement client");

    const box = document.createElement("div");
    box.className = "client-problem-box";

    const titleRow = document.createElement("div");
    titleRow.className = "client-problem-title-row";

    const title = document.createElement("div");
    title.className = "client-problem-title";
    title.textContent = isDriver ? "⚠ Signalement chauffeur" : "⚠ Signalement client";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "client-problem-close";
    closeBtn.setAttribute("aria-label", "Fermer (le signalement restera actif)");
    closeBtn.innerHTML = '<i class="ti ti-x"></i>';
    closeBtn.addEventListener("click", dismissProblemAlert);

    titleRow.appendChild(title);
    titleRow.appendChild(closeBtn);

    const warning = document.createElement("div");
    warning.className = "client-problem-warning";
    warning.textContent = isDriver
        ? "Un chauffeur a signalé un problème pendant une course. La course continue d'être suivie. Contactez le client et le chauffeur avant de marquer ce signalement comme traité."
        : "Un client a signalé un problème pendant une course. Vérifiez la situation avant de marquer ce signalement comme traité.";

    const rideRef = document.createElement("div");
    rideRef.className = "client-problem-ride";
    rideRef.textContent = `Course #${ride.id}` +
        (ride.client_name ? ` — ${ride.client_name}` : "") +
        (isDriver && ride.client_phone ? ` (${ride.client_phone})` : "") +
        (ride.driver_name ? ` · Chauffeur : ${ride.driver_name}` : "") +
        (isDriver && ride.driver_phone ? ` (${ride.driver_phone})` : "");

    const msg = document.createElement("div");
    msg.className = "client-problem-message";
    msg.textContent = isDriver ? ride.problem_description : ride.client_problem_description;

    const meta = document.createElement("div");
    meta.className = "client-problem-meta";
    meta.textContent = `Signalé le ${formatDate(isDriver ? ride.problem_at : ride.client_problem_at)}`;

    const action = document.createElement("button");
    action.className = "client-problem-action";
    action.type = "button";
    action.textContent = "Marquer comme traité";
    action.addEventListener("click", async () => {
        action.disabled = true;
        action.textContent = "…";
        try {
            const res = isDriver ? await resolveDriverProblem(ride.id) : await resolveClientProblem(ride.id);
            if (res.status !== "success") {
                showToast(res.message || "Erreur", "error");
                action.disabled = false;
                action.textContent = "Marquer comme traité";
                return;
            }
        } catch (e) {
            showToast("Erreur réseau", "error");
            action.disabled = false;
            action.textContent = "Marquer comme traité";
            return;
        }
        overlay.remove();
        AdminState.problemLastShownAt.delete(ride.alertKey); // résolu -> plus de rappel
        AdminState.unresolvedProblems = AdminState.unresolvedProblems.filter(r => r.alertKey !== ride.alertKey);
        updateProblemsReminder(AdminState.unresolvedProblems.length);
        AdminState.problemAlertShowingId = null;
        processProblemAlertQueue();
        checkClientProblems();
    });

    box.appendChild(titleRow);
    box.appendChild(warning);
    box.appendChild(rideRef);
    box.appendChild(msg);
    box.appendChild(meta);
    box.appendChild(action);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Clic sur le fond sombre = fermer sans résoudre
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) dismissProblemAlert();
    });

    action.focus();
}

/* ══════════════════════════════════════════════════════════
   SECTION : DASHBOARD
══════════════════════════════════════════════════════════ */
async function loadDashboard() {
    const el = document.getElementById("section-dashboard");
    el.innerHTML = `<div style="display:flex;justify-content:center;padding:60px"><div class="spinner"></div></div>`;

    let stats;
    try { stats = await fetchStats(); }
    catch (e) {
        el.innerHTML = `<p style="color:var(--c-red);padding:20px">Erreur de chargement des statistiques.</p>`;
        return;
    }

    el.innerHTML = `
    <div class="stats-grid">
        ${statCard("Clients", stats.clients_total, "blue", `${stats.clients_actifs} actifs`)}
        ${statCard("Chauffeurs en ligne", stats.chauffeurs_en_ligne, "amber", `${stats.chauffeurs_actifs} actifs au total`)}
        ${statCard("Courses totales", stats.courses_total, "", `${stats.taux_completion}% complétées`)}
        ${statCard("En attente", stats.courses_pending, "red", "courses pending")}
        ${statCard("En cours", stats.courses_en_cours, "blue", "accepted / started")}
        ${statCard("Terminées", stats.courses_completees, "green", "courses complétées")}
        ${statCard("Annulées", stats.courses_annulees, "red",
            `${stats.courses_annulees_clients || 0} par le client · ${(stats.courses_annulees - (stats.courses_annulees_clients || 0))} par le chauffeur`)}
        ${statCard("Volume total des courses", formatFcfa(stats.chiffre_affaires_fcfa), "green", "courses terminées")}
        ${statCard("Commissions collectées (20%)", formatFcfa(stats.commission_total_fcfa), "amber", "portefeuille chauffeurs")}
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Activité — 7 derniers jours</span>
      </div>
      <div class="card-body">
        ${renderSparkChart(stats.courbes_7j)}
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Dernières courses</span>
        <button class="btn btn-primary" onclick="showSection('rides')" style="font-size:12px;padding:6px 12px">Voir tout</button>
      </div>
      <div id="dash-recent-rides"><div class="empty-state"><div class="spinner"></div></div></div>
    </div>
    `;

    try {
        const rides = await fetchRides({ limit: 10 });
        document.getElementById("dash-recent-rides").innerHTML = renderRidesTable(rides, true);
    } catch(e) {}

    if (AdminState.dashboardInterval) clearInterval(AdminState.dashboardInterval);
    AdminState.dashboardInterval = setInterval(refreshDashboardStats, 20000);
}

async function refreshDashboardStats() {
    const el = document.getElementById("section-dashboard");
    if (!el || !document.getElementById("section-dashboard")?.classList.contains("active")) return;

    try {
        const stats = await fetchStats();
        if (stats) {
            updateStatValue("Chauffeurs en ligne", stats.chauffeurs_en_ligne, `${stats.chauffeurs_actifs} actifs au total`);
            updateStatValue("Annulées", stats.courses_annulees,
                `${stats.courses_annulees_clients || 0} par le client · ${(stats.courses_annulees - (stats.courses_annulees_clients || 0))} par le chauffeur`);
            updateStatValue("En attente", stats.courses_pending, "courses pending");
            updateStatValue("En cours", stats.courses_en_cours, "accepted / started");
            updateStatValue("Terminées", stats.courses_completees, "courses complétées");
            updateStatValue("Courses totales", stats.courses_total, `${stats.taux_completion}% complétées`);
            updateStatValue("Clients", stats.clients_total, `${stats.clients_actifs} actifs`);
            updateStatValue("Volume total des courses", formatFcfa(stats.chiffre_affaires_fcfa), "courses terminées");
            updateStatValue("Commissions collectées (20%)", formatFcfa(stats.commission_total_fcfa), "portefeuille chauffeurs");
        }

        const rideWrap = document.getElementById("dash-recent-rides");
        if (rideWrap) {
            const rides = await fetchRides({ limit: 10 });
            rideWrap.innerHTML = renderRidesTable(rides, true);
        }
    } catch(e) {}
}

function updateStatValue(label, value, sub) {
    const cards = document.querySelectorAll(".stat-card");
    for (const card of cards) {
        const labelEl = card.querySelector(".stat-label");
        if (labelEl && labelEl.textContent === label) {
            const valEl = card.querySelector(".stat-value");
            const subEl = card.querySelector(".stat-sub");
            if (valEl) valEl.textContent = value;
            if (subEl && sub) subEl.textContent = sub;
            break;
        }
    }
}

function statCard(label, value, color, sub) {
    return `<div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${color}">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ""}
    </div>`;
}

function renderSparkChart(data) {
    if (!data || !data.length) {
        return `<p style="color:var(--c-text-3);font-size:13px">Aucune donnée disponible.</p>`;
    }
    const max = Math.max(...data.map(d => d.nb)) || 1;
    const bars = data.map(d => {
        const h = Math.max(8, Math.round((d.nb / max) * 80));
        const label = d.jour.slice(5);
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
          <div style="font-size:11px;color:var(--c-text-3)">${d.nb}</div>
          <div style="height:${h}px;width:100%;background:var(--c-amber);border-radius:4px 4px 0 0;opacity:.85"></div>
          <div style="font-size:10px;color:var(--c-text-3)">${label}</div>
        </div>`;
    }).join("");
    return `<div style="display:flex;align-items:flex-end;gap:6px;height:120px">${bars}</div>`;
}

/* ══════════════════════════════════════════════════════════
   SECTION : CARTE TEMPS RÉEL
══════════════════════════════════════════════════════════ */
async function loadMapSection() {
    const el = document.getElementById("section-map");

    if (!AdminState.driversMap) {
        await new Promise(r => setTimeout(r, 80));
        initDriversMap();
    } else {
        AdminState.driversMap.invalidateSize();
    }

    await refreshDriversOnMap();

    if (AdminState.refreshInterval) clearInterval(AdminState.refreshInterval);
    AdminState.refreshInterval = setInterval(refreshDriversOnMap, 15000);

    updateMapRefreshBadge();
}

function initDriversMap() {
    const map = L.map("map-drivers", { zoomControl: true }).setView([4.0511, 9.7679], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19
    }).addTo(map);
    AdminState.driversMap = map;
}

async function refreshDriversOnMap() {
    let drivers;
    try {
        drivers = await fetchDriverPositions();
    } catch (e) {
        return;
    }

    const map    = AdminState.driversMap;
    const seen   = new Set();

    drivers.forEach(driver => {
        seen.add(driver.id);
        const lat = driver.driver_lat;
        const lng = driver.driver_lng;
        // Par chauffeur : orange dès que CE chauffeur a 5 courses ou plus
        // au statut 'started' (pas accepted/arrived).
        const isActive   = driver.courses_started >= 5;
        const iconHtml   = `<div class="driver-pin ${isActive ? 'active' : 'available'}">🚕</div>`;

        const popupHtml = `
            <div style="font-family:'DM Sans',sans-serif;min-width:160px">
              <strong style="font-size:14px">${driver.name}</strong><br>
              <span style="color:#6b7280;font-size:12px">${driver.plate} · ${driver.car_brand || ''} ${driver.car_color || ''}</span><br>
              <span style="color:#6b7280;font-size:12px">📱 ${driver.phone || '—'}</span><br>
              <div style="margin-top:6px">
                ${driver.courses_started >= 5
                    ? `<span style="background:#f97316;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">En course</span>`
                    : `<span style="background:#16a34a;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">Disponible</span>`
                }
              </div>
              <div style="color:#9ca3af;font-size:11px;margin-top:4px">
                Pos. ${formatDate(driver.update_position_driver)}
              </div>
            </div>`;

        if (AdminState.driverMarkers[driver.id]) {
            AdminState.driverMarkers[driver.id]
                .setLatLng([lat, lng])
                .setPopupContent(popupHtml);
        } else {
            const icon = L.divIcon({
                html: iconHtml,
                iconSize: [36, 36],
                iconAnchor: [18, 18],
                className: ""
            });
            const marker = L.marker([lat, lng], { icon })
                .addTo(map)
                .bindPopup(popupHtml);
            AdminState.driverMarkers[driver.id] = marker;
        }
    });

    Object.keys(AdminState.driverMarkers).forEach(id => {
        if (!seen.has(parseInt(id))) {
            AdminState.driversMap.removeLayer(AdminState.driverMarkers[id]);
            delete AdminState.driverMarkers[id];
        }
    });

    const countEl = document.getElementById("map-driver-count");
    if (countEl) countEl.textContent = `${drivers.length} chauffeur${drivers.length > 1 ? "s" : ""} en ligne`;

    updateMapRefreshBadge();
}

function updateMapRefreshBadge() {
    const el = document.getElementById("map-last-refresh");
    if (el) {
        const now = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        el.textContent = `Dernière MAJ : ${now}`;
    }
}

/* ══════════════════════════════════════════════════════════
   SECTION : COURSES
══════════════════════════════════════════════════════════ */
async function loadRides() {
    const section = document.getElementById("section-rides");
    const f = AdminState.ridesFilter;

    section.querySelector("#rides-table-wrap").innerHTML =
        `<div class="empty-state"><div class="spinner"></div></div>`;

    try {
        const rides = await fetchRides(f);
        section.querySelector("#rides-table-wrap").innerHTML = renderRidesTable(rides, false);
    } catch (e) {
        section.querySelector("#rides-table-wrap").innerHTML =
            `<p style="color:var(--c-red);padding:20px">Erreur de chargement.</p>`;
    }

    if (AdminState.ridesInterval) clearInterval(AdminState.ridesInterval);
    AdminState.ridesInterval = setInterval(refreshRides, 20000);
}

async function refreshRides() {
    const section = document.getElementById("section-rides");
    if (!section || !section.classList.contains("active")) return;

    try {
        const rides = await fetchRides(AdminState.ridesFilter);
        section.querySelector("#rides-table-wrap").innerHTML = renderRidesTable(rides, false);
    } catch (e) {}
}

// Échappe un texte destiné à un ATTRIBUT HTML (title="..."). escapeHtml() de
// admin-kyc.js laisse passer les guillemets, ce qui permettrait de « sortir » de
// l'attribut ; ce texte vient d'un chauffeur, donc on échappe aussi " et '.
function escapeAttr(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderDriverAlertCell(r) {
    if (!r.problem_description) return "—";
    if (!r.problem_resolved_at) {
        return `<span class="topbar-badge badge-red" title="${escapeAttr(r.problem_description)}">⚠ Problème</span>`;
    }
    return `<span class="topbar-badge badge-gray" title="${escapeAttr(r.problem_description)}\n(traité)">✓ Traité</span>`;
}

function renderClientAlertCell(r) {
    if (!r.client_problem_description) return "—";
    if (!r.client_problem_resolved_at) {
        return `<span class="topbar-badge badge-red" title="${escapeHtml(r.client_problem_description)}">🚨 Signalement</span>`;
    }
    return `<span class="topbar-badge badge-gray" title="${escapeHtml(r.client_problem_description)}\n(traité)">✓ Traité</span>`;
}

function renderRidesTable(rides, compact) {
    if (!rides.length) return `<div class="empty-state"><div class="empty-state-icon">🚗</div><div class="empty-state-text">Aucune course trouvée</div></div>`;

    const rows = rides.map(r => `
        <tr>
          <td><span class="text-mono">#${r.id}</span></td>
          <td>${statusBadge(r.status)}</td>
          <td>
            <div>${r.client_name || "—"}</div>
            ${!compact ? `<div class="ride-detail">${r.client_phone || ""}</div>` : ""}
          </td>
          <td>
            <div>${r.driver_name || "—"}</div>
            ${!compact ? `<div class="ride-detail">${r.driver_plate || ""}</div>` : ""}
          </td>
          <td>
            <div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.pickup || ''}">
              ${r.pickup || "—"}
            </div>
          </td>
          ${!compact ? `
          <td>
            <div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.destination || ''}">
              ${r.destination || "—"}
            </div>
          </td>
          <td>${r.distance_km ? parseFloat(r.distance_km).toFixed(1) + " km" : "—"}</td>` : ""}
          <td style="white-space:nowrap">${r.price_fcfa ? formatFcfa(r.price_fcfa) : "—"}</td>
          <td style="white-space:nowrap">${formatDate(r.created_at)}</td>
          ${!compact ? `<td>${renderDriverAlertCell(r)}</td><td>${renderClientAlertCell(r)}</td>` : ""}
        </tr>`).join("");

    return `<div class="table-wrap"><table>
      <thead><tr>
        <th>#</th><th>Statut</th><th>Client</th><th>Chauffeur</th><th>Départ</th>
        ${!compact ? "<th>Destination</th><th>Distance</th>" : ""}
        <th>Prix</th><th>Date</th>
        ${!compact ? "<th>Alerte chauffeur</th><th>Alerte client</th>" : ""}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/* ══════════════════════════════════════════════════════════
   SECTION : CHAUFFEURS
══════════════════════════════════════════════════════════ */
async function loadChauffeurs() {
    const section = document.getElementById("section-chauffeurs");
    const f = AdminState.chauffeursFilter;
    section.querySelector("#chauffeurs-table-wrap").innerHTML =
        `<div class="empty-state"><div class="spinner"></div></div>`;

    try {
        const list = await fetchChauffeurs(f.q, f.status);
        section.querySelector("#chauffeurs-table-wrap").innerHTML = renderChauffeursTable(list);
    } catch (e) {
        section.querySelector("#chauffeurs-table-wrap").innerHTML =
            `<p style="color:var(--c-red);padding:20px">Erreur de chargement.</p>`;
    }

    if (AdminState.chauffeursInterval) clearInterval(AdminState.chauffeursInterval);
    AdminState.chauffeursInterval = setInterval(refreshChauffeurs, 20000);
}

async function refreshChauffeurs() {
    const section = document.getElementById("section-chauffeurs");
    if (!section || !section.classList.contains("active")) return;

    try {
        const list = await fetchChauffeurs(AdminState.chauffeursFilter.q, AdminState.chauffeursFilter.status);
        section.querySelector("#chauffeurs-table-wrap").innerHTML = renderChauffeursTable(list);
    } catch (e) {}
}

function renderChauffeursTable(list) {
    if (!list.length) return `<div class="empty-state"><div class="empty-state-icon">🚕</div><div class="empty-state-text">Aucun chauffeur trouvé</div></div>`;

    const rows = list.map(c => {
        const onlineLabel = c.is_online == 1 ? "En ligne" : "Hors ligne";
        const onlineCls   = c.is_online == 1 ? "badge-green" : "badge-red";
        return `<tr>
          <td>${c.name}</td>
          <td>${c.email || "—"}<div class="ride-detail">${c.phone || ""}</div></td>
          <td><span class="text-mono">${c.plate}</span><div class="ride-detail">${c.car_brand || ""} ${c.car_color || ""}</div></td>
          <td>${userStatusBadge(c.status)}</td>
          <td><span class="topbar-badge ${onlineCls}">${onlineLabel}</span></td>
          <td>${c.total_completed_rides}</td>
          <td>${c.total_accepted_rides}</td>
          <td>${formatFcfa(c.total_accepted_amount_fcfa)}</td>
          <td>${formatDateShort(c.created_at)}</td>
          <td>
            ${c.status === "active"
                ? `<button class="btn btn-danger btn-sm" onclick="toggleUser('chauffeur', ${c.id}, 'disabled', this)">Désactiver</button>`
                : `<button class="btn btn-success btn-sm" onclick="toggleUser('chauffeur', ${c.id}, 'active', this)">Activer</button>`
            }
          </td>
        </tr>`;
    }).join("");

    return `<div class="table-wrap"><table>
      <thead><tr>
        <th>Nom</th><th>Contact</th><th>Plaque</th><th>Statut</th><th>État</th>
        <th>Courses <br>terminées</th><th>Courses <br>acceptées</th>
        <th>C.A. accepté</th><th>Inscrit le</th><th>Action</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/* ══════════════════════════════════════════════════════════
   SECTION : CLIENTS
══════════════════════════════════════════════════════════ */
async function loadClients() {
    const section = document.getElementById("section-clients");
    const f = AdminState.clientsFilter;
    section.querySelector("#clients-table-wrap").innerHTML =
        `<div class="empty-state"><div class="spinner"></div></div>`;

    try {
        const list = await fetchClients(f.q, f.status);
        section.querySelector("#clients-table-wrap").innerHTML = renderClientsTable(list);
    } catch (e) {
        section.querySelector("#clients-table-wrap").innerHTML =
            `<p style="color:var(--c-red);padding:20px">Erreur de chargement.</p>`;
    }
}

function renderClientsTable(list) {
    if (!list.length) return `<div class="empty-state"><div class="empty-state-icon">👤</div><div class="empty-state-text">Aucun client trouvé</div></div>`;

    const rows = list.map(c => `
        <tr>
          <td>${c.full_name}</td>
          <td>${c.email || "—"}</td>
          <td>${c.phone || "—"}</td>
          <td>${userStatusBadge(c.status)}</td>
          <td>${c.nb_courses}</td>
          <td>${formatFcfa(c.total_depense_fcfa)}</td>
          <td>${formatDateShort(c.created_at)}</td>
          <td>
            ${c.status === "active"
                ? `<button class="btn btn-danger btn-sm" onclick="toggleUser('client', ${c.id}, 'disabled', this)">Désactiver</button>`
                : `<button class="btn btn-success btn-sm" onclick="toggleUser('client', ${c.id}, 'active', this)">Activer</button>`
            }
          </td>
        </tr>`).join("");

    return `<div class="table-wrap"><table>
      <thead><tr>
        <th>Nom</th><th>Email</th><th>Téléphone</th><th>Statut</th>
        <th>Courses</th><th>Total dépensé</th><th>Inscrit le</th><th>Action</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/* ═══════════════════════════════════════════════
   SECTION : PORTEFEUILLE CHAUFFEURS (CORRIGÉ)
═══════════════════════════════════════════════ */

async function loadWallets() {
    const section = document.getElementById("section-wallets");
    const wrap = section.querySelector("#wallets-table-wrap");
    if (!wrap) return;

    // À chaque entrée dans la section : aucune ligne dépliée, cache vidé
    AdminState.walletsFilter.chauffeur_id = 0;
    AdminState.walletsDetailCache = {};

    wrap.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

    try {
        const wallets = await fetchWallets();
        renderAndWireWalletsTable(wallets);
    } catch (e) {
        wrap.innerHTML = `<p style="color:var(--c-red);padding:20px">Erreur de chargement.</p>`;
    }

    if (AdminState.walletsInterval) clearInterval(AdminState.walletsInterval);
    AdminState.walletsInterval = setInterval(refreshWallets, 30000);
}

// Poll toutes les 30 s : met à jour le tableau ET le détail ouvert.
// Le détail est réaffiché depuis le cache (pas de spinner, pas de clignotement),
// puis remplacé par les données fraîches dès qu'elles arrivent.
async function refreshWallets() {
    const section = document.getElementById("section-wallets");
    if (!section || !section.classList.contains("active")) return;

    try {
        const wallets = await fetchWallets();
        renderAndWireWalletsTable(wallets);

        const openId = AdminState.walletsFilter.chauffeur_id;
        if (openId > 0) await loadWalletRowDetail(openId);
    } catch (e) {}
}

// Affiche le tableau puis branche les clics sur les lignes.
// Point unique utilisé par loadWallets, refreshWallets, toggleWalletRow et handleRecharge.
function renderAndWireWalletsTable(wallets) {
    const wrap = document.querySelector("#section-wallets #wallets-table-wrap");
    if (!wrap) return;
    AdminState.walletsCache = wallets;
    wrap.innerHTML = renderWalletsTable(wallets);
    wireWalletRowClicks(wrap);
}

function renderWalletsTable(wallets) {
    if (!wallets || !wallets.length) {
        return `<div class="empty-state"><div class="empty-state-icon">💰</div><div class="empty-state-text">Aucun portefeuille</div></div>`;
    }

    const openId = AdminState.walletsFilter.chauffeur_id; // 0 = aucune ligne ouverte

    const rows = wallets.map(w => {
        const balance = w.wallet_balance_fcfa;
        const balanceClass = balance < 0 ? 'text-danger' : 'text-success';
        const isOpen = openId === w.id;

        // Contenu du détail : cache s'il existe, sinon spinner en attendant le chargement
        const cached = AdminState.walletsDetailCache[w.id];
        const detailHtml = !isOpen ? ''
            : (cached ? renderTransactionHistory(cached, w.id)
                      : '<div class="empty-state"><div class="spinner"></div></div>');

        return `<tr class="wallet-row" data-wallet-row="${w.id}" tabindex="0" role="button" aria-expanded="${isOpen}">
            <td><strong>${escapeHtml(w.name)}</strong><div class="ride-detail">${escapeHtml(w.phone || '')}</div></td>
            <td class="${balanceClass}">${formatFcfa(balance)}</td>
            <td>${formatFcfa(w.total_commissions_fcfa)}</td>
            <td>${formatFcfa(w.total_recharges_fcfa)}</td>
            <td>
                ${w.recharges_en_attente > 0
                    ? `<span class="topbar-badge badge-amber">${w.recharges_en_attente} en attente</span>`
                    : '—'
                }
            </td>
            <td>
                ${w.derniere_transaction_at
                    ? `<span title="${formatDate(w.derniere_transaction_at)}">${formatDateShort(w.derniere_transaction_at)}</span>
                       <div class="ride-detail">${escapeHtml(w.derniere_transaction_type || '')}</div>`
                    : '—'
                }
            </td>
            <td><i class="ti ti-chevron-right wallet-row-chevron${isOpen ? ' open' : ''}"></i></td>
        </tr>
        <tr class="wallet-detail-row" data-wallet-detail="${w.id}" style="display:${isOpen ? 'table-row' : 'none'}">
            <td colspan="7" id="wallet-detail-content-${w.id}">${detailHtml}</td>
        </tr>`;
    }).join('');

    return `<div class="table-wrap"><table>
        <thead><tr>
            <th>Chauffeur</th>
            <th>Solde</th>
            <th>Commissions (20%)</th>
            <th>Recharges</th>
            <th>Recharges en attente</th>
            <th>Dernière activité</th>
            <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}

// Branche le clic (souris) et Entrée/Espace (clavier) sur chaque ligne principale.
// À rappeler après chaque réécriture du tableau.
function wireWalletRowClicks(container) {
    container.querySelectorAll('[data-wallet-row]').forEach(tr => {
        const id = Number(tr.dataset.walletRow);
        tr.addEventListener('click', () => toggleWalletRow(id));
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleWalletRow(id);
            }
        });
    });
}

// Ouvre la ligne cliquée (et ferme l'autre), ou la ferme si elle était déjà ouverte.
async function toggleWalletRow(chauffeurId) {
    const wasOpen = AdminState.walletsFilter.chauffeur_id === chauffeurId;
    AdminState.walletsFilter.chauffeur_id = wasOpen ? 0 : chauffeurId;

    renderAndWireWalletsTable(AdminState.walletsCache);

    if (!wasOpen) await loadWalletRowDetail(chauffeurId);
}

// Croix ✕ du panneau déplié
function closeWalletRow() {
    const chauffeurId = AdminState.walletsFilter.chauffeur_id;
    if (chauffeurId) toggleWalletRow(chauffeurId);
}

// Charge l'historique d'un chauffeur, le met en cache et l'affiche dans sa ligne de détail.
async function loadWalletRowDetail(chauffeurId) {
    try {
        const data = await fetchWalletTransactions({ chauffeur_id: chauffeurId, limit: 20 });
        if (data.status !== 'success') throw new Error('api');
        AdminState.walletsDetailCache[chauffeurId] = data.transactions || [];
    } catch (e) {
        // On garde l'ancien affichage s'il existe ; sinon message d'erreur
        if (!AdminState.walletsDetailCache[chauffeurId]) {
            const errCell = document.getElementById(`wallet-detail-content-${chauffeurId}`);
            if (errCell) errCell.innerHTML = '<p class="text-danger">Erreur chargement historique</p>';
        }
        return;
    }

    // La ligne a été refermée (ou une autre ouverte) pendant le chargement : rien à afficher
    if (AdminState.walletsFilter.chauffeur_id !== chauffeurId) return;

    const cell = document.getElementById(`wallet-detail-content-${chauffeurId}`);
    if (cell) cell.innerHTML = renderTransactionHistory(AdminState.walletsDetailCache[chauffeurId], chauffeurId);
}

function renderTransactionHistory(transactions, chauffeurId) {
    if (!transactions || !transactions.length) {
        return `<div class="wallet-detail-head">
                <h4>Historique des transactions</h4>
                <button class="wallet-detail-close" onclick="closeWalletRow()" aria-label="Fermer"><i class="ti ti-x"></i></button>
            </div>
            <div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">Aucune transaction pour ce chauffeur</div></div>`;
    }

    const rows = transactions.map(t => {
        const amount = t.amount_fcfa;
        const sign = amount >= 0 ? '+' : '';
        const amountClass = amount >= 0 ? 'text-success' : 'text-danger';
        const statusBadge = {
            'pending': 'badge-amber',
            'completed': 'badge-green',
            'rejected': 'badge-red'
        }[t.status] || 'badge-gray';

        // Actions pour les recharges en attente
        let actions = '—';
        if (t.type === 'recharge' && t.status === 'pending') {
            actions = `
                <button class="btn btn-success btn-sm" onclick="handleRecharge(${t.id}, 'approve')">Valider</button>
                <button class="btn btn-danger btn-sm" onclick="handleRecharge(${t.id}, 'reject')">Rejeter</button>
            `;
        }

        // escapeHtml : operator / reference sont saisis par le chauffeur
        return `<tr>
            <td>${escapeHtml(t.type)}</td>
            <td class="${amountClass}">${sign}${formatFcfa(Math.abs(amount))}</td>
            <td><span class="topbar-badge ${statusBadge}">${escapeHtml(t.status)}</span></td>
            <td>${escapeHtml(t.operator || '—')}</td>
            <td>${escapeHtml(t.reference || '—')}</td>
            <td>${escapeHtml(t.description || '—')}</td>
            <td>${formatDate(t.created_at)}</td>
            <td>${actions}</td>
        </tr>`;
    }).join('');

    return `
        <div class="wallet-detail-head">
            <h4>Historique des transactions</h4>
            <button class="wallet-detail-close" onclick="closeWalletRow()" aria-label="Fermer"><i class="ti ti-x"></i></button>
        </div>
        <div class="table-wrap">
            <table>
                <thead><tr><th>Type</th><th>Montant</th><th>Statut</th><th>Opérateur</th><th>Référence</th><th>Description</th><th>Date</th><th>Actions</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// Validation / rejet d'une recharge
async function handleRecharge(transactionId, action) {
    const actionLabel = action === 'approve' ? 'valider' : 'rejeter';
    const ok = await confirmAction({
        title: `${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)} la recharge ?`,
        message: `Êtes-vous sûr de vouloir ${actionLabel} cette recharge ?`,
        confirmLabel: `Oui, ${actionLabel}`,
        cancelLabel: 'Annuler',
        danger: action === 'reject'
    });
    if (!ok) return;

    try {
        const result = await validateRecharge(transactionId, action);
        if (result.status === 'success') {
            showToast(result.message, 'success');

            // 1. Tableau (badge "en attente" + solde de la ligne), sans refermer le détail
            const wallets = await fetchWallets();
            renderAndWireWalletsTable(wallets);

            // 2. Détail ouvert : historique rechargé
            const chauffeurId = AdminState.walletsFilter.chauffeur_id;
            if (chauffeurId > 0) await loadWalletRowDetail(chauffeurId);
        } else {
            showToast(result.message || 'Erreur', 'error');
        }
    } catch (e) {
        showToast('Erreur réseau', 'error');
    }
}

/* ──────────────────────────────────────────────
   Toggle statut utilisateur (commun)
────────────────────────────────────────────── */
async function toggleUser(type, id, newStatus, btn) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "…";

    try {
        const res = await setUserStatus(type, id, newStatus);
        if (res.status === "success") {
            showToast(`Statut mis à jour : ${newStatus === "active" ? "activé" : "désactivé"}`);
            if (AdminState.currentSection === "chauffeurs") loadChauffeurs();
            else if (AdminState.currentSection === "clients") loadClients();
        } else {
            showToast(res.message || "Erreur", "error");
            btn.disabled = false;
            btn.textContent = original;
        }
    } catch (e) {
        showToast("Erreur réseau", "error");
        btn.disabled = false;
        btn.textContent = original;
    }
}

/* ──────────────────────────────────────────────
   Filtres — événements
────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
    bindFilter("rides-search",       val => { AdminState.ridesFilter.q      = val; loadRides(); }, 500);
    bindFilter("rides-status-filter",val => { AdminState.ridesFilter.status = val; loadRides(); }, 0);
    bindFilter("rides-date-from",    val => { AdminState.ridesFilter.date_from = val; loadRides(); }, 0);
    bindFilter("rides-date-to",      val => { AdminState.ridesFilter.date_to   = val; loadRides(); }, 0);

    bindFilter("chauffeurs-search",       val => { AdminState.chauffeursFilter.q      = val; loadChauffeurs(); }, 500);
    bindFilter("chauffeurs-status-filter",val => { AdminState.chauffeursFilter.status = val; loadChauffeurs(); }, 0);

    bindFilter("clients-search",       val => { AdminState.clientsFilter.q      = val; loadClients(); }, 500);
    bindFilter("clients-status-filter",val => { AdminState.clientsFilter.status = val; loadClients(); }, 0);

    document.getElementById("map-refresh-btn")?.addEventListener("click", refreshDriversOnMap);
});

function bindFilter(id, cb, debounce) {
    const el = document.getElementById(id);
    if (!el) return;
    let timer;
    const handler = () => {
        clearTimeout(timer);
        timer = setTimeout(() => cb(el.value.trim()), debounce);
    };
    el.addEventListener(debounce > 0 ? "input" : "change", handler);
}

/* ──────────────────────────────────────────────
   Filtre statut — ajout des options dynamiques
────────────────────────────────────────────── */
function updateRidesFilterOptions() {
    const sel = document.getElementById("rides-status-filter");
    if (!sel) return;
    if (sel.querySelector('option[value="cancelled_client"]')) return;
    const ref = sel.querySelector('option[value="cancelled"]');
    const opt = document.createElement("option");
    opt.value = "cancelled_client";
    opt.textContent = "Annulée (client)";
    if (ref && ref.nextSibling) {
        sel.insertBefore(opt, ref.nextSibling);
    } else {
        sel.appendChild(opt);
    }
}