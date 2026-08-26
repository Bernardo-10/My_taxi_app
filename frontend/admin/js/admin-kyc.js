/* ============================================================
   TaxiGo Admin — admin-kyc.js
   Vérification des documents chauffeur (CNI, carte grise,
   permis, capacité, licence).

   Navigation en 2 temps :
   - Liste compacte cliquable (résumé par chauffeur)
   - Clic → vue détail plein espace (documents + actions),
     avec bouton "Retour à la liste" (la liste ne reste pas
     visible à côté).

   Fichier autonome : à charger après admin-api.js et
   admin-ui.js (utilise ADMIN_API et showToast déjà définis
   là-bas, et confirmAction déjà chargé via confirm-modal.js).
   ============================================================ */

"use strict";

const KycState = {
    filter: "pending",
    chauffeurs: [],
    interval: null,
    view: "list",        // "list" | "detail"
    selectedId: null
};

/* ──────────────────────────────────────────────
   API
────────────────────────────────────────────── */

async function fetchKycChauffeurs(status = "") {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const res = await fetch(`${ADMIN_API}/list_pending_kyc.php?${params}`);
    const data = await res.json();
    return data.chauffeurs || [];
}

async function submitKycReview(driverId, action, reason = "") {
    const res = await fetch(`${ADMIN_API}/review_kyc.php`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver_id: driverId, action, reason })
    });
    return res.json();
}

/* ──────────────────────────────────────────────
   CHARGEMENT / RAFRAÎCHISSEMENT
────────────────────────────────────────────── */

async function loadKyc() {
    const wrap = document.getElementById("kyc-list-wrap");
    if (!wrap) return;

    wrap.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

    try {
        // On charge toujours "tous" pour calculer les compteurs des 4 filtres
        // en un seul appel, puis on filtre côté client à l'affichage.
        const all = await fetchKycChauffeurs("");
        KycState.chauffeurs = all;
        updateKycCounts(all);
        renderKycView();
    } catch (e) {
        wrap.innerHTML = `<p style="color:var(--c-red);padding:20px">Erreur de chargement.</p>`;
    }

    if (KycState.interval) clearInterval(KycState.interval);
    KycState.interval = setInterval(refreshKyc, 30000);
}

async function refreshKyc() {
    const section = document.getElementById("section-kyc");
    if (!section || !section.classList.contains("active")) return;
    try {
        const all = await fetchKycChauffeurs("");
        KycState.chauffeurs = all;
        updateKycCounts(all);
        renderKycView();
    } catch (e) {
        // silencieux — prochain cycle réessaiera
    }
}

function updateKycCounts(all) {
    const counts = { pending: 0, approved: 0, rejected: 0, incomplete: 0 };
    all.forEach(c => {
        if (counts[c.kyc_status] !== undefined) counts[c.kyc_status]++;
        if (c.incomplete == 1) counts.incomplete++;
    });

    // Compte les chauffeurs ayant au moins un document en attente de
    // renouvellement — indépendant de kyc_status (un chauffeur déjà
    // 'approved' peut très bien avoir un renouvellement 'pending' en
    // parallèle, cf. rapport KYC §2 : la table chauffeur_document_renewals
    // ne touche jamais kyc_status global).
    const renewalCount = all.filter(c => (c.pending_renewals || []).length > 0).length;

    setText("kycCountPending", counts.pending);
    setText("kycCountApproved", counts.approved);
    setText("kycCountRejected", counts.rejected);
    setText("kycCountIncomplete", counts.incomplete);
    setText("kycCountRenewal", renewalCount);
    setText("kycCountAll", all.length);

    // Badge sur l'onglet de navigation — visible seulement s'il y a des
    // dossiers en attente, sur le même modèle que navProblemsBadge.
    // Inclut à la fois les nouveaux dossiers KYC et les renouvellements,
    // les deux nécessitant une action de l'admin dans cette même section.
    const navBadge = document.getElementById("navKycBadge");
    if (navBadge) {
        const total = counts.pending + renewalCount;
        if (total > 0) {
            navBadge.textContent = total;
            navBadge.style.display = "inline-flex";
        } else {
            navBadge.style.display = "none";
        }
    }
}

function renderIncompleteBadgeIfAny(all) {
    const incompleteCount = all.filter(c => c.incomplete == 1).length;
    const el = document.getElementById('kycIncompleteBadge');
    if (!el) return;
    if (incompleteCount > 0) {
        el.textContent = incompleteCount;
        el.style.display = 'inline-flex';
    } else {
        el.style.display = 'none';
    }
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/* ──────────────────────────────────────────────
   FILTRES (liste uniquement)
────────────────────────────────────────────── */

function initKycFilters() {
    document.querySelectorAll(".kyc-filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".kyc-filter-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            KycState.filter = btn.dataset.kycFilter || "";
            renderKycView();
        });
    });
}

/* ──────────────────────────────────────────────
   RENDU — aiguillage liste / détail
────────────────────────────────────────────── */

function renderKycView() {
    const toolbar = document.querySelector("#section-kyc .kyc-toolbar");

    if (KycState.view === "detail" && KycState.selectedId) {
        const driver = KycState.chauffeurs.find(c => Number(c.id) === Number(KycState.selectedId));
        if (!driver) {
            // Le chauffeur sélectionné n'existe plus dans les données
            // fraîches (cas rare) : on retombe proprement sur la liste.
            KycState.view = "list";
            KycState.selectedId = null;
        } else {
            if (toolbar) toolbar.style.display = "none";
            renderKycDetail(driver);
            return;
        }
    }

    if (toolbar) toolbar.style.display = "flex";
    renderKycListCompact();
}

/* ──────────────────────────────────────────────
   RENDU — liste compacte cliquable
────────────────────────────────────────────── */

function renderKycListCompact() {
    const wrap = document.getElementById("kyc-list-wrap");
    if (!wrap) return;

    // Le filtre "renewal" est indépendant de kyc_status : un dossier déjà
    // approuvé peut avoir un document en cours de renouvellement (cf.
    // rapport KYC §2). Le filtre "incomplete" tolère aussi l'ancienne
    // donnée (incomplete=1 sans kyc_status mis à jour, avant la migration
    // de correction) en plus du vrai kyc_status='incomplete'. Les autres
    // filtres restent basés strictement sur kyc_status.
    const filtered = KycState.filter === "renewal"
        ? KycState.chauffeurs.filter(c => (c.pending_renewals || []).length > 0)
        : KycState.filter === "incomplete"
            ? KycState.chauffeurs.filter(c => c.kyc_status === "incomplete" || c.incomplete == 1)
            : KycState.filter
                ? KycState.chauffeurs.filter(c => c.kyc_status === KycState.filter)
                : KycState.chauffeurs;

    if (filtered.length === 0) {
        wrap.innerHTML = `<div class="empty-state">Aucun dossier dans cette catégorie.</div>`;
        return;
    }

    wrap.innerHTML = `
        <div class="kyc-list-compact">
            ${filtered.map(renderKycListItem).join("")}
        </div>
    `;

    wrap.querySelectorAll("[data-kyc-open]").forEach(item => {
        item.addEventListener("click", () => {
            KycState.selectedId = Number(item.dataset.kycOpen);
            KycState.view = "detail";
            renderKycView();
            wrap.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    });
}

function renderKycListItem(c) {
    const initials = (c.name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
    const statusLabels = { incomplete: "Incomplet", pending: "En attente", approved: "Approuvé", rejected: "Rejeté" };
    const statusPill = `<span class="kyc-status-pill kyc-${c.kyc_status}">${statusLabels[c.kyc_status] || c.kyc_status}</span>`;

    // Pill secondaire visible dans TOUTES les vues (pas seulement le
    // filtre "Renouvellement") — utile par ex. dans "Approuvés" pour
    // repérer d'un coup d'œil un chauffeur qui a quand même un
    // renouvellement en attente d'action.
    const renewalCount = (c.pending_renewals || []).length;
    const renewalPill = renewalCount > 0
        ? `<span class="kyc-renewal-pill">Renouvellement (${renewalCount})</span>`
        : "";

    // Pastille séparée seulement si incomplete=1 SANS que kyc_status soit
    // déjà 'incomplete' — sinon la pastille de statut principale (ligne
    // au-dessus) dit déjà la même chose, doublon inutile.
    const incompletePill = (c.incomplete == 1 && c.kyc_status !== "incomplete")
        ? `<span class="kyc-incomplete-pill">Incomplet</span>`
        : "";

    return `
        <button type="button" class="kyc-list-item" data-kyc-open="${c.id}">
            <div class="kyc-avatar-sm">${initials}</div>
            <div class="kyc-list-item-info">
                <div class="kyc-list-item-name">${escapeHtml(c.name)}</div>
                <div class="kyc-list-item-meta">${escapeHtml(c.phone)} · Plaque ${escapeHtml(c.plate)}</div>
            </div>
            ${renewalPill}
            ${incompletePill}
            ${statusPill}
            <svg class="kyc-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
    `;
}

/* ──────────────────────────────────────────────
   RENDU — vue détail (plein espace, avec retour)
────────────────────────────────────────────── */

function renderKycDetail(c) {
    const wrap = document.getElementById("kyc-list-wrap");
    if (!wrap) return;

    wrap.innerHTML = `
        <div class="kyc-detail-wrap">
            <button type="button" class="kyc-back-btn" id="kycBackBtn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                Retour à la liste
            </button>
            ${renderKycCard(c)}
        </div>
    `;

    document.getElementById("kycBackBtn")?.addEventListener("click", () => {
        KycState.view = "list";
        KycState.selectedId = null;
        renderKycView();
    });

    wireKycCardActions(wrap);
}

function renderKycCard(c) {
    const initials = (c.name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
    const submittedDate = formatFrDate(c.created_at);

    const statusLabels = { incomplete: "Incomplet", pending: "En attente", approved: "Approuvé", rejected: "Rejeté" };
    const statusPill = `<span class="kyc-status-pill kyc-${c.kyc_status}">${statusLabels[c.kyc_status] || c.kyc_status}</span>`;

    const docs = [
        { group: "cni", title: "CNI", number: c.cni_number, expiration: c.cni_expiration,
          thumbs: [["Recto", c.cni_photo_recto_url], ["Verso", c.cni_photo_verso_url]] },
        { group: "carte_grise", title: "Carte grise", number: c.carte_grise_immat, expiration: c.carte_grise_expiration,
          thumbs: [["Photo", c.carte_grise_photo_url]] },
        { group: "permit", title: "Permis de conduire", number: c.permit_number, expiration: c.permit_expiration,
          thumbs: [["Recto", c.permit_photo_recto_url], ["Verso", c.permit_photo_verso_url]] },
        { group: "capacity", title: "Carte de capacité", number: c.capacity_number, expiration: c.capacity_expiration,
          thumbs: [["Recto", c.capacity_photo_recto_url], ["Verso", c.capacity_photo_verso_url]] },
        { group: "license", title: "Licence chauffeur", number: c.license_number, expiration: c.license_expiration,
          thumbs: [["Recto", c.license_photo_recto_url], ["Verso", c.license_photo_verso_url]] }
    ];

    // Associe à chaque document sa demande de renouvellement en attente,
    // s'il y en a une — un renouvellement ne concerne qu'un seul groupe
    // de documents à la fois (cf. table chauffeur_document_renewals).
    const pendingRenewals = c.pending_renewals || [];
    const docsHtml = docs.map(doc => renderKycDocBlock(doc, pendingRenewals.find(r => r.document_group === doc.group))).join("");

    let footerHtml;
    if (c.kyc_status === "pending") {
        footerHtml = `
            <div class="kyc-card-footer" id="kyc-footer-${c.id}">
                <span class="kyc-review-note">Soumis le ${submittedDate}</span>
                <div class="kyc-actions">
                    <button class="kyc-btn kyc-btn-reject" data-kyc-show-reject="${c.id}">
                        <i class="ti ti-x"></i> Rejeter
                    </button>
                    <button class="kyc-btn kyc-btn-approve" data-kyc-approve="${c.id}">
                        <i class="ti ti-check"></i> Approuver
                    </button>
                </div>
            </div>
            <div class="kyc-reject-form" id="kyc-reject-form-${c.id}" style="display:none; padding: 0 18px 14px;">
                <textarea id="kyc-reject-reason-${c.id}" placeholder="Motif du rejet (obligatoire, visible par le chauffeur)"></textarea>
                <div class="kyc-reject-form-actions">
                    <button class="btn btn-sm btn-outline" data-kyc-cancel-reject="${c.id}">Annuler</button>
                    <button class="kyc-btn kyc-btn-reject" data-kyc-confirm-reject="${c.id}">Confirmer le rejet</button>
                </div>
            </div>
        `;
    } else if (c.kyc_status === "approved") {
        footerHtml = `
            <div class="kyc-card-footer">
                <span class="kyc-review-note">Approuvé le <strong>${formatFrDate(c.kyc_reviewed_at)}</strong></span>
            </div>
        `;
    } else {
        footerHtml = `
            <div class="kyc-card-footer">
                <span class="kyc-review-note kyc-reject-reason">
                    Rejeté le ${formatFrDate(c.kyc_reviewed_at)} — Motif : ${escapeHtml(c.kyc_rejection_reason || "—")}
                </span>
            </div>
        `;
    }

    return `
        <div class="kyc-card" data-kyc-card="${c.id}">
            <div class="kyc-card-header">
                <div class="kyc-driver-info">
                    <div class="kyc-avatar">${initials}</div>
                    <div>
                        <div class="kyc-driver-name">${escapeHtml(c.name)}</div>
                        <div class="kyc-driver-meta">${escapeHtml(c.phone)} · Plaque ${escapeHtml(c.plate)} · ${escapeHtml(c.car_brand || "")} ${escapeHtml(c.car_color || "")}</div>
                    </div>
                </div>
                ${statusPill}
                ${(c.incomplete == 1 && c.kyc_status !== "incomplete") ? '<span class="kyc-incomplete-pill kyc-card-incomplete">Incomplet</span>' : ''}
            </div>
            <div class="kyc-docs-grid">${docsHtml}</div>
            ${footerHtml}
        </div>
    `;
}

function renderKycDocBlock(doc, renewal) {
    const expired = doc.expiration && new Date(doc.expiration) < new Date();
    const expirationHtml = doc.expiration
        ? `Expire le ${formatFrDate(doc.expiration)}${expired ? ' <span class="kyc-expired">(expiré)</span>' : ""}`
        : "Date d'expiration non renseignée";

    const thumbsHtml = doc.thumbs.map(([label, url]) => {
        if (!url) {
            return `<div class="kyc-thumb kyc-thumb-missing">Manquant</div>`;
        }
        return `
            <a class="kyc-thumb" href="${url}" target="_blank" rel="noopener">
                <img src="${url}" alt="${escapeHtml(doc.title)} — ${label}" loading="lazy">
                <span class="kyc-thumb-label">${label}</span>
            </a>
        `;
    }).join("");

    const renewalHtml = renewal ? renderKycRenewalBlock(doc, renewal) : "";

    return `
        <div class="kyc-doc-block">
            <div class="kyc-doc-title">${escapeHtml(doc.title)}</div>
            <div class="kyc-doc-meta">
                N° ${escapeHtml(doc.number || "—")}<br>
                ${expirationHtml}
            </div>
            <div class="kyc-thumb-row">${thumbsHtml}</div>
            ${renewalHtml}
        </div>
    `;
}

// Sous-bloc affiché quand CE document précis a une demande de
// renouvellement en attente ou déjà rejetée — indépendant du
// kyc_status global du chauffeur (cf. rapport KYC §2).
function renderKycRenewalBlock(doc, renewal) {
    const renewalExpired = renewal.expiration && new Date(renewal.expiration) < new Date();
    const expirationHtml = renewal.expiration
        ? `Expire le ${formatFrDate(renewal.expiration)}${renewalExpired ? ' <span class="kyc-expired">(déjà expiré)</span>' : ""}`
        : "Date d'expiration non renseignée";

    const thumbs = [["Recto", renewal.photo_recto_url], ["Verso", renewal.photo_verso_url]]
        .filter(([, url]) => url)
        .map(([label, url]) => `
            <a class="kyc-thumb" href="${url}" target="_blank" rel="noopener">
                <img src="${url}" alt="${escapeHtml(doc.title)} — renouvellement — ${label}" loading="lazy">
                <span class="kyc-thumb-label">${label}</span>
            </a>
        `).join("");

    if (renewal.status === "rejected") {
        return `
            <div class="kyc-renewal-block">
                <div class="kyc-renewal-label"><i class="ti ti-refresh"></i> Renouvellement rejeté</div>
                <div class="kyc-doc-meta">
                    N° ${escapeHtml(renewal.number || "—")}<br>
                    ${expirationHtml}<br>
                    Motif : ${escapeHtml(renewal.rejection_reason || "—")}
                </div>
                <div class="kyc-thumb-row">${thumbs}</div>
            </div>
        `;
    }

    return `
        <div class="kyc-renewal-block">
            <div class="kyc-renewal-label"><i class="ti ti-refresh"></i> Renouvellement soumis le ${formatFrDate(renewal.submitted_at)}</div>
            <div class="kyc-doc-meta">
                N° ${escapeHtml(renewal.number || "—")}<br>
                ${expirationHtml}
            </div>
            <div class="kyc-thumb-row">${thumbs}</div>
            <div class="kyc-renewal-actions">
                <button class="kyc-btn kyc-btn-reject" data-renewal-show-reject="${renewal.id}">
                    <i class="ti ti-x"></i> Rejeter
                </button>
                <button class="kyc-btn kyc-btn-approve" data-renewal-approve="${renewal.id}">
                    <i class="ti ti-check"></i> Approuver
                </button>
            </div>
            <div class="kyc-renewal-reject-form" id="renewal-reject-form-${renewal.id}" style="display:none;">
                <textarea id="renewal-reject-reason-${renewal.id}" placeholder="Motif du rejet (obligatoire, visible par le chauffeur)"></textarea>
                <div class="kyc-reject-form-actions">
                    <button class="btn btn-sm btn-outline" data-renewal-cancel-reject="${renewal.id}">Annuler</button>
                    <button class="kyc-btn kyc-btn-reject" data-renewal-confirm-reject="${renewal.id}">Confirmer le rejet</button>
                </div>
            </div>
        </div>
    `;
}

/* ──────────────────────────────────────────────
   ACTIONS (vue détail)
────────────────────────────────────────────── */

function wireKycCardActions(scope) {
    scope.querySelectorAll("[data-kyc-approve]").forEach(btn => {
        btn.addEventListener("click", () => handleKycApprove(Number(btn.dataset.kycApprove), btn));
    });
    scope.querySelectorAll("[data-kyc-show-reject]").forEach(btn => {
        btn.addEventListener("click", () => toggleRejectForm(Number(btn.dataset.kycShowReject)));
    });
    scope.querySelectorAll("[data-kyc-cancel-reject]").forEach(btn => {
        btn.addEventListener("click", () => toggleRejectForm(Number(btn.dataset.kycCancelReject), true));
    });
    scope.querySelectorAll("[data-kyc-confirm-reject]").forEach(btn => {
        btn.addEventListener("click", () => handleKycReject(Number(btn.dataset.kycConfirmReject), btn));
    });

    // Actions de renouvellement — mêmes patterns, mais ciblent une ligne
    // de chauffeur_document_renewals (renewal_id), pas le dossier KYC
    // global du chauffeur.
    scope.querySelectorAll("[data-renewal-approve]").forEach(btn => {
        btn.addEventListener("click", () => handleRenewalApprove(Number(btn.dataset.renewalApprove), btn));
    });
    scope.querySelectorAll("[data-renewal-show-reject]").forEach(btn => {
        btn.addEventListener("click", () => toggleRenewalRejectForm(Number(btn.dataset.renewalShowReject)));
    });
    scope.querySelectorAll("[data-renewal-cancel-reject]").forEach(btn => {
        btn.addEventListener("click", () => toggleRenewalRejectForm(Number(btn.dataset.renewalCancelReject), true));
    });
    scope.querySelectorAll("[data-renewal-confirm-reject]").forEach(btn => {
        btn.addEventListener("click", () => handleRenewalReject(Number(btn.dataset.renewalConfirmReject), btn));
    });
}

async function handleKycApprove(driverId, btn) {
    const ok = await confirmAction({
        title: "Approuver ce dossier ?",
        message: "Le chauffeur pourra se mettre en ligne et recevoir des courses dès validation.",
        confirmLabel: "Approuver",
        cancelLabel: "Annuler",
        danger: false
    });
    if (!ok) return;

    btn.disabled = true;
    try {
        const result = await submitKycReview(driverId, "approve");
        if (result.status === "success") {
            showToast("Dossier approuvé", "success");
            // On reste sur la fiche détail (mise à jour), pas de retour forcé
            // à la liste — l'admin voit immédiatement le nouveau statut.
            await loadKyc();
        } else {
            showToast(result.message || "Erreur", "error");
            btn.disabled = false;
        }
    } catch (e) {
        showToast("Erreur réseau", "error");
        btn.disabled = false;
    }
}

function toggleRejectForm(driverId, forceHide = false) {
    const form = document.getElementById(`kyc-reject-form-${driverId}`);
    if (!form) return;
    const show = forceHide ? false : form.style.display === "none";
    form.style.display = show ? "flex" : "none";
    if (show) {
        document.getElementById(`kyc-reject-reason-${driverId}`)?.focus();
    }
}

async function handleKycReject(driverId, btn) {
    const textarea = document.getElementById(`kyc-reject-reason-${driverId}`);
    const reason = (textarea?.value || "").trim();

    if (!reason) {
        showToast("Merci d'indiquer un motif de rejet", "error");
        textarea?.focus();
        return;
    }

    const ok = await confirmAction({
        title: "Rejeter ce dossier ?",
        message: "Le chauffeur verra ce motif et devra corriger ses documents.",
        confirmLabel: "Confirmer le rejet",
        cancelLabel: "Annuler",
        danger: true
    });
    if (!ok) return;

    btn.disabled = true;
    try {
        const result = await submitKycReview(driverId, "reject", reason);
        if (result.status === "success") {
            showToast("Dossier rejeté", "success");
            await loadKyc();
        } else {
            showToast(result.message || "Erreur", "error");
            btn.disabled = false;
        }
    } catch (e) {
        showToast("Erreur réseau", "error");
        btn.disabled = false;
    }
}

/* ──────────────────────────────────────────────
   ACTIONS (renouvellement de document)
────────────────────────────────────────────── */

async function submitRenewalReview(renewalId, action, reason = "") {
    const res = await fetch(`${ADMIN_API}/review_document_renewal.php`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renewal_id: renewalId, action, reason })
    });
    return res.json();
}

async function handleRenewalApprove(renewalId, btn) {
    const ok = await confirmAction({
        title: "Approuver ce renouvellement ?",
        message: "Le nouveau document remplace immédiatement l'ancien dans le dossier du chauffeur.",
        confirmLabel: "Approuver",
        cancelLabel: "Annuler",
        danger: false
    });
    if (!ok) return;

    btn.disabled = true;
    try {
        const result = await submitRenewalReview(renewalId, "approve");
        if (result.status === "success") {
            showToast("Renouvellement approuvé", "success");
            await loadKyc();
        } else {
            showToast(result.message || "Erreur", "error");
            btn.disabled = false;
        }
    } catch (e) {
        showToast("Erreur réseau", "error");
        btn.disabled = false;
    }
}

function toggleRenewalRejectForm(renewalId, forceHide = false) {
    const form = document.getElementById(`renewal-reject-form-${renewalId}`);
    if (!form) return;
    const show = forceHide ? false : form.style.display === "none";
    form.style.display = show ? "flex" : "none";
    if (show) {
        document.getElementById(`renewal-reject-reason-${renewalId}`)?.focus();
    }
}

async function handleRenewalReject(renewalId, btn) {
    const textarea = document.getElementById(`renewal-reject-reason-${renewalId}`);
    const reason = (textarea?.value || "").trim();

    if (!reason) {
        showToast("Merci d'indiquer un motif de rejet", "error");
        textarea?.focus();
        return;
    }

    const ok = await confirmAction({
        title: "Rejeter ce renouvellement ?",
        message: "L'ancien document reste en vigueur — le chauffeur verra ce motif et pourra resoumettre.",
        confirmLabel: "Confirmer le rejet",
        cancelLabel: "Annuler",
        danger: true
    });
    if (!ok) return;

    btn.disabled = true;
    try {
        const result = await submitRenewalReview(renewalId, "reject", reason);
        if (result.status === "success") {
            showToast("Renouvellement rejeté", "success");
            await loadKyc();
        } else {
            showToast(result.message || "Erreur", "error");
            btn.disabled = false;
        }
    } catch (e) {
        showToast("Erreur réseau", "error");
        btn.disabled = false;
    }
}

/* ──────────────────────────────────────────────
   UTILITAIRES
────────────────────────────────────────────── */

function formatFrDate(value) {
    if (!value) return "—";
    const d = new Date(value.replace(" ", "T"));
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
}

/* ──────────────────────────────────────────────
   INITIALISATION
────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
    initKycFilters();
});