/* ============================================================
   TaxiGo Admin — admin-api.js
   Toutes les fonctions de communication avec le backend admin
   ============================================================ */

"use strict";

const ADMIN_API = "/backend/admin";
const COMMON_API = "/backend/common";

/* ──────────────────────────────────────────────
   AUTH
────────────────────────────────────────────── */

async function checkAdminAuth() {
    try {
        const res = await fetch(`${ADMIN_API}/current_admin.php`);
        if (res.status === 401) {
            window.location.href = "/admin/login";
            return null;
        }
        const data = await res.json();
        return data.status === "success" ? data.admin : null;
    } catch (e) {
        window.location.href = "/admin/login";
        return null;
    }
}

async function logoutAdmin() {
    try {
        await fetch(`${COMMON_API}/logout.php`, { method: "POST" });
    } finally {
        window.location.href = "/admin/login";
    }
}

/* ──────────────────────────────────────────────
   STATISTIQUES
────────────────────────────────────────────── */

async function fetchStats() {
    const res  = await fetch(`${ADMIN_API}/get_stats.php`);
    const data = await res.json();
    return data.stats || null;
}

/* ──────────────────────────────────────────────
   CHAUFFEURS
────────────────────────────────────────────── */

async function fetchChauffeurs(q = "", status = "") {
    const params = new URLSearchParams();
    if (q)      params.set("q",      q);
    if (status) params.set("status", status);
    const res  = await fetch(`${ADMIN_API}/list_chauffeurs.php?${params}`);
    const data = await res.json();
    return data.chauffeurs || [];
}

async function fetchDriverPositions() {
    const res  = await fetch(`${ADMIN_API}/driver_positions.php`);
    const data = await res.json();
    return data.drivers || [];
}

/* ──────────────────────────────────────────────
   CLIENTS
────────────────────────────────────────────── */

async function fetchClients(q = "", status = "") {
    const params = new URLSearchParams();
    if (q)      params.set("q",      q);
    if (status) params.set("status", status);
    const res  = await fetch(`${ADMIN_API}/list_clients.php?${params}`);
    const data = await res.json();
    return data.clients || [];
}

/* ──────────────────────────────────────────────
   COURSES
────────────────────────────────────────────── */

async function fetchRides({ status = "", q = "", date_from = "", date_to = "", limit = 100, offset = 0 } = {}) {
    const params = new URLSearchParams({ limit, offset });
    if (status)    params.set("status",    status);
    if (q)         params.set("q",         q);
    if (date_from) params.set("date_from", date_from);
    if (date_to)   params.set("date_to",   date_to);
    const res  = await fetch(`${ADMIN_API}/list_rides.php?${params}`);
    const data = await res.json();
    return data.rides || [];
}

/* ──────────────────────────────────────────────
   GESTION DES UTILISATEURS
────────────────────────────────────────────── */

async function setUserStatus(type, id, status) {
    const res  = await fetch(`${ADMIN_API}/set_user_status.php`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ type, id, status })
    });
    return await res.json();
}

/* ──────────────────────────────────────────────
   UTILITAIRES
────────────────────────────────────────────── */

function formatFcfa(amount) {
    return Number(amount).toLocaleString("fr-FR") + " FCFA";
}

function formatDate(dt) {
    if (!dt) return "—";
    return new Date(dt).toLocaleString("fr-FR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
    });
}

function formatDateShort(dt) {
    if (!dt) return "—";
    return new Date(dt).toLocaleDateString("fr-FR", {
        day: "2-digit", month: "2-digit", year: "numeric"
    });
}

function statusBadge(status) {
    const map = {
        "pending":          ["badge-amber",   "En attente"],
        "accepted":         ["badge-blue",    "Acceptée"],
        "arrived":          ["badge-blue",    "Arrivé"],
        "started":          ["badge-purple",  "En cours"],
        "completed":        ["badge-green",   "Terminée"],
        "cancelled":        ["badge-gray",    "Annulée (chauffeur)"],
        "cancelled_client": ["badge-red",     "Annulée (client)"],
        "reported":         ["badge-red",     "Signalée"]
    };
    const [cls, label] = map[status] || ["badge-gray", status];
    return `<span class="topbar-badge ${cls}">${label}</span>`;
}

function userStatusBadge(status) {
    return status === "active"
        ? `<span class="topbar-badge badge-green">Actif</span>`
        : `<span class="topbar-badge badge-red">Désactivé</span>`;
}

function showToast(msg, type = "success") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById("toast-container").appendChild(el);
    setTimeout(() => el.remove(), 3500);
}
