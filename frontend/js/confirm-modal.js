/**
 * confirm-modal.js — Composant de confirmation stylisé, partagé entre les
 * 3 frontends (client, chauffeur, admin).
 *
 * Remplace window.confirm() et ajoute une confirmation là où il n'y en
 * avait aucune (déconnexion client, déconnexion chauffeur, annulation
 * chauffeur). Auto-suffisant : injecte son propre CSS, aucune dépendance
 * aux feuilles de style de chaque interface (reprend leurs variables
 * --c-* si présentes, avec un repli sur des valeurs neutres sinon).
 *
 * Usage :
 *   const ok = await confirmAction({
 *     title: "Annuler cette course ?",
 *     message: "Cette action est irréversible.",
 *     confirmLabel: "Annuler la course",
 *     cancelLabel: "Retour",
 *     danger: true
 *   });
 *   if (ok) { ... }
 */
"use strict";

(function () {
    if (window.confirmAction) return; // déjà chargé (script inclus deux fois)

    const STYLE_ID = "tg-confirm-modal-styles";

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.tg-confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(15, 23, 42, .55);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  z-index: 100000;
  animation: tg-confirm-fade .15s ease;
}
.tg-confirm-box {
  background: var(--c-surface, #ffffff);
  border-radius: var(--radius, 14px);
  max-width: 380px;
  width: 100%;
  padding: 22px 22px 18px;
  box-shadow: 0 20px 50px rgba(0,0,0,.25);
  animation: tg-confirm-pop .18s ease;
  font-family: inherit;
}
.tg-confirm-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--c-text, #111827);
  margin-bottom: 8px;
}
.tg-confirm-message {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--c-text-3, #6b7280);
  margin-bottom: 20px;
}
.tg-confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.tg-confirm-btn {
  border: none;
  border-radius: var(--radius-sm, 8px);
  padding: 9px 16px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity .15s ease, transform .1s ease;
  font-family: inherit;
}
.tg-confirm-btn:active { transform: scale(.97); }
.tg-confirm-btn-cancel {
  background: var(--c-surface2, #f3f4f6);
  color: var(--c-text-2, #374151);
}
.tg-confirm-btn-confirm {
  background: var(--c-red, #dc2626);
  color: #fff;
}
.tg-confirm-btn-confirm.tg-confirm-neutral {
  background: var(--c-amber, #f97316);
}
@keyframes tg-confirm-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes tg-confirm-pop  { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
`;
        document.head.appendChild(style);
    }

    /**
     * Affiche une confirmation stylisée.
     * @param {Object}  opts
     * @param {string}  opts.title         Titre de la modale
     * @param {string}  [opts.message]     Texte secondaire (optionnel)
     * @param {string}  [opts.confirmLabel] Libellé du bouton de confirmation
     * @param {string}  [opts.cancelLabel]  Libellé du bouton d'annulation
     * @param {boolean} [opts.danger]       true = bouton rouge (action destructive), false = ambre
     * @returns {Promise<boolean>} true si confirmé, false si annulé/fermé
     */
    window.confirmAction = function ({
        title = "Confirmer ?",
        message = "",
        confirmLabel = "Confirmer",
        cancelLabel = "Annuler",
        danger = false
    } = {}) {
        injectStyles();

        // Un seul modal de confirmation à la fois
        document.querySelectorAll(".tg-confirm-overlay").forEach(el => el.remove());

        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "tg-confirm-overlay";

            const box = document.createElement("div");
            box.className = "tg-confirm-box";
            box.setAttribute("role", "alertdialog");
            box.setAttribute("aria-modal", "true");
            box.setAttribute("aria-label", title);

            const titleEl = document.createElement("div");
            titleEl.className = "tg-confirm-title";
            titleEl.textContent = title;

            const msgEl = document.createElement("div");
            msgEl.className = "tg-confirm-message";
            msgEl.textContent = message;

            const actions = document.createElement("div");
            actions.className = "tg-confirm-actions";

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "tg-confirm-btn tg-confirm-btn-cancel";
            cancelBtn.textContent = cancelLabel;

            const confirmBtn = document.createElement("button");
            confirmBtn.type = "button";
            confirmBtn.className = "tg-confirm-btn tg-confirm-btn-confirm" + (danger ? "" : " tg-confirm-neutral");
            confirmBtn.textContent = confirmLabel;

            function close(result) {
                document.removeEventListener("keydown", onKeydown);
                overlay.remove();
                resolve(result);
            }
            function onKeydown(e) {
                if (e.key === "Escape") close(false);
            }

            cancelBtn.addEventListener("click", () => close(false));
            confirmBtn.addEventListener("click", () => close(true));
            overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
            document.addEventListener("keydown", onKeydown);

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            box.appendChild(titleEl);
            if (message) box.appendChild(msgEl);
            box.appendChild(actions);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            confirmBtn.focus();
        });
    };
})();
