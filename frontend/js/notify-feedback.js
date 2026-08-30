/**
 * notify-feedback.js — Son + vibration + notification système, partagé
 * entre les frontends chauffeur et client (même pattern que confirm-modal.js).
 *
 * SON / VIBRATION — aucune permission navigateur requise. Le son est bloqué
 * par défaut par la politique d'autoplay (pas par une permission), donc ce
 * module se "déverrouille" tout seul dès la première interaction de
 * l'utilisateur sur la page (clic, tap, touche), sans lui demander quoi que
 * ce soit. La vibration n'a besoin d'aucun déverrouillage.
 *
 * Chaque son est préchargé une seule fois (pas re-téléchargé à chaque
 * notification) — important vu la cible mobile/données limitées du projet.
 * Un échec de lecture (fichier absent, autoplay encore bloqué) est toujours
 * silencieux : ça ne doit jamais empêcher l'affichage d'un toast.
 *
 * NOTIFICATION SYSTÈME (chantier 07/07/2026, côté client uniquement pour le
 * moment — chauffeur laissé de côté, prévu via FCM séparément) — celle-ci
 * REQUIERT la permission `Notification.requestPermission()`, à demander
 * uniquement suite à un vrai geste utilisateur (obligatoire sur iOS Safari,
 * sinon silencieusement ignoré). Voir requestNotifyPermission() plus bas.
 * Elle ne s'affiche que si l'onglet n'est PAS au premier plan
 * (document.visibilityState !== "visible") — si l'utilisateur regarde déjà
 * l'app, le toast déjà affiché suffit, pas besoin d'un doublon système.
 * Rappel important (voir rapport FCM vs Pusher) : ceci ne fonctionne que
 * tant que l'onglet/l'app reste ouvert quelque part (même en arrière-plan) —
 * app totalement fermée = rien ne s'affiche, c'est le rôle réservé à FCM.
 * Sur iPhone, ne fonctionne que si le site a été ajouté à l'écran d'accueil
 * (PWA installée) ; dans un simple onglet Safari, la permission peut être
 * accordée mais aucune notification n'apparaîtra jamais (limitation iOS,
 * pas un bug de ce module).
 *
 * Usage :
 *   window.notifyFeedback({ sound: "accepted", vibrate: [100, 50, 100] });
 *   window.notifyFeedback({ vibrate: [35] }); // vibration seule, pas de son
 *   window.notifyFeedback({ sound: "new_ride" }); // son seul, pas de vibration
 *   window.notifyFeedback({
 *     sound: "accepted", vibrate: [100, 50, 100],
 *     notify: { title: "Chauffeur en route", body: "Bernardo arrive !" }
 *   });
 *   window.requestNotifyPermission(); // à appeler depuis un clic (une fois)
 */
"use strict";

(function () {
    if (window.notifyFeedback) return; // déjà chargé (script inclus deux fois)

    const SOUND_BASE_PATH = "/frontend/sounds/";

    // Correspondance nom logique -> fichier. Les fichiers réels sont à
    // déposer par Bernardo dans frontend/sounds/ ; en attendant, un son
    // manquant échoue silencieusement (aucune erreur visible pour l'utilisateur).
    const SOUND_FILES = {
        accepted:  "accepted.mp3",   // son1 — client : chauffeur a accepté
        arrived:   "arrived.mp3",    // son2 — client : chauffeur arrivé
        cancelled: "cancelled.mp3",  // son3 — annulation par l'autre partie (client ET chauffeur)
        new_ride:  "new_ride.mp3",   // son4 — chauffeur : nouvelle course disponible (plus long)
        admin_alert: "admin_alert.mp3", // son5 — admin : nouvelle recharge en attente OU nouveau document KYC (attente/renouvellement)
    };

    const audioCache = {};
    let unlocked = false;

    function getAudio(name) {
        if (!SOUND_FILES[name]) return null;
        if (!audioCache[name]) {
            const audio = new Audio(SOUND_BASE_PATH + SOUND_FILES[name]);
            audio.preload = "auto";
            audioCache[name] = audio;
        }
        return audioCache[name];
    }

    // Précharge tous les sons dès le chargement du script (fichiers courts,
    // coût négligeable) pour ne jamais avoir de délai au premier déclenchement.
    Object.keys(SOUND_FILES).forEach(getAudio);

    function unlockAudio() {
        if (unlocked) return;
        unlocked = true;
        Object.values(audioCache).forEach((audio) => {
            const p = audio.play();
            if (p && typeof p.then === "function") {
                p.then(() => {
                    audio.pause();
                    audio.currentTime = 0;
                }).catch(() => {
                    // Toujours bloqué : on retentera au prochain geste utilisateur.
                    unlocked = false;
                });
            }
        });
    }

    ["pointerdown", "touchstart", "click", "keydown"].forEach((evt) => {
        document.addEventListener(evt, unlockAudio, { once: true, passive: true });
    });

    function playSound(name) {
        const audio = getAudio(name);
        if (!audio) return;
        try {
            audio.currentTime = 0;
            const p = audio.play();
            if (p && typeof p.catch === "function") {
                p.catch(() => { /* échec silencieux */ });
            }
        } catch (e) {
            // échec silencieux
        }
    }

    function doVibrate(pattern) {
        if (!navigator.vibrate) return;
        try { navigator.vibrate(pattern); } catch (e) { /* échec silencieux */ }
    }

    // ── Notification système native ─────────────────────────────────
    // Icône déduite du dossier courant (/client/... ou /chauffeur/...) pour
    // que ce module reste générique quand le chauffeur l'utilisera à son tour.
    const NOTIFY_ICON = location.pathname.startsWith("/chauffeur")
        ? "/chauffeur/icons/chauffeur-192.png"
        : "/client/icons/client-192.png";

    function canNotify() {
        return typeof window.Notification === "function";
    }

    // À appeler UNIQUEMENT depuis un vrai geste utilisateur (clic/tap) —
    // obligatoire sur iOS Safari, sinon la demande est silencieusement
    // ignorée. Ne redemande jamais si l'utilisateur a déjà répondu
    // (accordé ou refusé) : Notification.permission reste "default"
    // uniquement tant qu'aucune décision n'a été prise.
    window.requestNotifyPermission = function () {
        if (!canNotify()) return;
        if (Notification.permission === "default") {
            try { Notification.requestPermission(); } catch (e) { /* échec silencieux */ }
        }
    };

    function showNativeNotification(notify) {
        if (!notify || !canNotify()) return;
        if (Notification.permission !== "granted") return;
        // Le toast déjà affiché à l'écran suffit si l'onglet est au premier
        // plan — éviter une notification système redondante dans ce cas.
        if (document.visibilityState === "visible") return;
        try {
            const n = new Notification(notify.title, {
                body: notify.body || "",
                icon: NOTIFY_ICON,
                tag: notify.tag || "taxigo-ride",
            });
            n.onclick = () => {
                window.focus();
                n.close();
            };
        } catch (e) {
            // échec silencieux — ex. permission révoquée entre-temps
        }
    }

    window.notifyFeedback = function (options) {
        const opts = options || {};
        if (opts.sound) playSound(opts.sound);
        if (opts.vibrate) doVibrate(opts.vibrate);
        if (opts.notify) showNativeNotification(opts.notify);
    };
})();
