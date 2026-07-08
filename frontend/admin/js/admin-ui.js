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
    shownProblemIds: new Set(),
    problemAlertQueue: [],
    problemAlertShowing: false,

    // Portefeuille
    walletsFilter: { chauffeur_id: 0, type: '', status: '' },
    walletsInterval: null
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

    switch (name) {
        case "dashboard":  loadDashboard();  break;
        case "map":        loadMapSection(); break;
        case "rides":      loadRides();      break;
        case "chauffeurs": loadChauffeurs(); break;
        case "clients":    loadClients();    break;
        case "wallets":    loadWallets();    break;
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

async function checkClientProblems() {
    let problems;
    try { problems = await fetchProblems(); }
    catch (e) { return; }

    const unresolved = (problems || []).filter(
        p => p.client_problem_description && !p.client_problem_resolved_at
    );

    updateProblemsBadge(unresolved.length);

    unresolved.forEach(ride => {
        if (AdminState.shownProblemIds.has(ride.id)) return;
        AdminState.shownProblemIds.add(ride.id);
        enqueueProblemAlert(ride);
    });
}

function updateProblemsBadge(count) {
    const badge = document.getElementById("navProblemsBadge");
    if (!badge) return;
    badge.textContent = count;
    badge.style.display = count > 0 ? "inline-block" : "none";
}

function enqueueProblemAlert(ride) {
    AdminState.problemAlertQueue.push(ride);
    processProblemAlertQueue();
}

function processProblemAlertQueue() {
    if (AdminState.problemAlertShowing || AdminState.problemAlertQueue.length === 0) return;
    const ride = AdminState.problemAlertQueue.shift();
    AdminState.problemAlertShowing = true;
    openAdminClientProblemAlert(ride);
}

function openAdminClientProblemAlert(ride) {
    const existing = document.getElementById("clientProblemAlert");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "clientProblemAlert";
    overlay.className = "client-problem-alert";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Signalement client");

    const box = document.createElement("div");
    box.className = "client-problem-box";

    const title = document.createElement("div");
    title.className = "client-problem-title";
    title.textContent = "⚠ Signalement client";

    const warning = document.createElement("div");
    warning.className = "client-problem-warning";
    warning.textContent = "Un client a signalé un problème pendant une course. Vérifiez la situation avant de marquer ce signalement comme traité.";

    const rideRef = document.createElement("div");
    rideRef.className = "client-problem-ride";
    rideRef.textContent = `Course #${ride.id}` +
        (ride.client_name ? ` — ${ride.client_name}` : "") +
        (ride.driver_name ? ` · Chauffeur : ${ride.driver_name}` : "");

    const msg = document.createElement("div");
    msg.className = "client-problem-message";
    msg.textContent = ride.client_problem_description;

    const meta = document.createElement("div");
    meta.className = "client-problem-meta";
    meta.textContent = `Signalé le ${formatDate(ride.client_problem_at)}`;

    const action = document.createElement("button");
    action.className = "client-problem-action";
    action.type = "button";
    action.textContent = "Marquer comme traité";
    action.addEventListener("click", async () => {
        action.disabled = true;
        action.textContent = "…";
        try {
            const res = await resolveClientProblem(ride.id);
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
        AdminState.problemAlertShowing = false;
        processProblemAlertQueue();
        checkClientProblems();
    });

    box.appendChild(title);
    box.appendChild(warning);
    box.appendChild(rideRef);
    box.appendChild(msg);
    box.appendChild(meta);
    box.appendChild(action);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
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
        const isActive   = driver.course_active > 0;
        const iconHtml   = `<div class="driver-pin ${isActive ? 'active' : 'available'}">🚕</div>`;

        const popupHtml = `
            <div style="font-family:'DM Sans',sans-serif;min-width:160px">
              <strong style="font-size:14px">${driver.name}</strong><br>
              <span style="color:#6b7280;font-size:12px">${driver.plate} · ${driver.car_brand || ''} ${driver.car_color || ''}</span><br>
              <span style="color:#6b7280;font-size:12px">📱 ${driver.phone || '—'}</span><br>
              <div style="margin-top:6px">
                ${driver.course_active > 0
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

function renderDriverAlertCell(r) {
    if (!r.problem_description) return "—";
    return `<span class="topbar-badge badge-red" title="${r.problem_description}">⚠ Problème</span>`;
}

function renderClientAlertCell(r) {
    if (!r.client_problem_description) return "—";
    if (!r.client_problem_resolved_at) {
        return `<span class="topbar-badge badge-red" title="${r.client_problem_description}">🚨 Signalement</span>`;
    }
    return `<span class="topbar-badge badge-gray" title="${r.client_problem_description}\n(traité)">✓ Traité</span>`;
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
    const historyWrap = section.querySelector("#wallets-history-wrap");
    if (!wrap) return;

    wrap.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
    if (historyWrap) {
        historyWrap.innerHTML = '';
        historyWrap.style.display = 'none';
    }

    try {
        // 1. Charger la liste des portefeuilles
        const wallets = await fetchWallets();
        wrap.innerHTML = renderWalletsTable(wallets);

        // 2. Si un filtre chauffeur_id est actif, charger l'historique
        const chauffeurId = AdminState.walletsFilter.chauffeur_id;
        if (chauffeurId > 0 && historyWrap) {
            try {
                const data = await fetchWalletTransactions({ chauffeur_id: chauffeurId, limit: 20 });
                historyWrap.innerHTML = renderTransactionHistory(data.transactions, chauffeurId);
                historyWrap.style.display = 'block';
            } catch (e) {
                historyWrap.innerHTML = '<p class="text-danger">Erreur chargement historique</p>';
                historyWrap.style.display = 'block';
            }
        }
    } catch (e) {
        wrap.innerHTML = `<p style="color:var(--c-red);padding:20px">Erreur de chargement.</p>`;
    }

    if (AdminState.walletsInterval) clearInterval(AdminState.walletsInterval);
    AdminState.walletsInterval = setInterval(refreshWallets, 30000);
}

async function refreshWallets() {
    const section = document.getElementById("section-wallets");
    if (!section || !section.classList.contains("active")) return;

    try {
        const wallets = await fetchWallets();
        const wrap = section.querySelector("#wallets-table-wrap");
        if (wrap) wrap.innerHTML = renderWalletsTable(wallets);
    } catch (e) {}
}

function renderWalletsTable(wallets) {
    if (!wallets || !wallets.length) {
        return `<div class="empty-state"><div class="empty-state-icon">💰</div><div class="empty-state-text">Aucun portefeuille</div></div>`;
    }

    const rows = wallets.map(w => {
        const balance = w.wallet_balance_fcfa;
        const balanceClass = balance < 0 ? 'text-danger' : 'text-success';
        return `<tr>
            <td><strong>${w.name}</strong><div class="ride-detail">${w.phone || ''}</div></td>
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
                       <div class="ride-detail">${w.derniere_transaction_type || ''}</div>`
                    : '—'
                }
            </td>
            <td>
                <button class="btn btn-sm btn-outline" onclick="showWalletHistory(${w.id})">Historique</button>
            </td>
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
            <th>Action</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}

function showWalletHistory(chauffeurId) {
    if (!chauffeurId) return;
    AdminState.walletsFilter.chauffeur_id = chauffeurId;
    loadWallets();
}

function clearWalletFilter() {
    AdminState.walletsFilter.chauffeur_id = 0;
    loadWallets();
}

function renderTransactionHistory(transactions, chauffeurId) {
    if (!transactions || !transactions.length) {
        return `<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">Aucune transaction pour ce chauffeur</div></div>`;
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

        return `<tr>
            <td>${t.type}</td>
            <td class="${amountClass}">${sign}${formatFcfa(Math.abs(amount))}</td>
            <td><span class="topbar-badge ${statusBadge}">${t.status}</span></td>
            <td>${t.operator || '—'}</td>
            <td>${t.reference || '—'}</td>
            <td>${t.description || '—'}</td>
            <td>${formatDate(t.created_at)}</td>
        </tr>`;
    }).join('');

    return `
        <div style="margin-top:20px;border-top:1px solid var(--c-border);padding-top:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h4 style="margin:0">Historique des transactions</h4>
                <button class="btn btn-sm btn-outline" onclick="clearWalletFilter()">Fermer</button>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Type</th><th>Montant</th><th>Statut</th><th>Opérateur</th><th>Référence</th><th>Description</th><th>Date</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
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