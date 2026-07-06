/**
 * notify-feedback.js — Son + vibration pour les notifications, partagé
 * entre les frontends chauffeur et client (même pattern que confirm-modal.js).
 *
 * Ce module ne gère AUCUNE permission navigateur — il n'en a pas besoin.
 * Le son est bloqué par défaut par la politique d'autoplay (pas par une
 * permission), donc ce module se "déverrouille" tout seul dès la première
 * interaction de l'utilisateur sur la page (clic, tap, touche), sans lui
 * demander quoi que ce soit. La vibration n'a besoin d'aucun déverrouillage.
 *
 * Chaque son est préchargé une seule fois (pas re-téléchargé à chaque
 * notification) — important vu la cible mobile/données limitées du projet.
 * Un échec de lecture (fichier absent, autoplay encore bloqué) est toujours
 * silencieux : ça ne doit jamais empêcher l'affichage d'un toast.
 *
 * Usage :
 *   window.notifyFeedback({ sound: "accepted", vibrate: [100, 50, 100] });
 *   window.notifyFeedback({ vibrate: [35] }); // vibration seule, pas de son
 *   window.notifyFeedback({ sound: "new_ride" }); // son seul, pas de vibration
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

    window.notifyFeedback = function (options) {
        const opts = options || {};
        if (opts.sound) playSound(opts.sound);
        if (opts.vibrate) doVibrate(opts.vibrate);
    };
})();
