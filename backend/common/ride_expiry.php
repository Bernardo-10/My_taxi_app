<?php
// Expiration des courses restées sans chauffeur (lot F3b).
//
// Une course 'pending' que personne n'accepte restait en attente indéfiniment :
// le client attendait sans fin, et sa course bloquait la création d'une
// nouvelle (garde « une seule course active » de client/backend.php).
// Désormais, après RIDE_PENDING_TTL_MINUTES minutes sans chauffeur, la course
// passe au statut 'expired'.
//
// "Paresseuse" : pas de tâche planifiée (InfinityFree n'en a pas). La mise à
// jour est faite à la lecture, comme sync_stale_drivers_offline() dans
// auth.php : chaque endpoint qui affiche ou accepte des courses 'pending'
// appelle expire_stale_pending_rides() avant de lire. C'est un seul UPDATE,
// appuyé sur l'index idx_rides_status_created (status, created_at).
//
// Aucune course acceptée n'est jamais touchée : le UPDATE ne porte que sur
// status = 'pending'. Si un chauffeur accepte au même instant, MySQL
// sérialise les deux UPDATE sur la ligne : l'un des deux gagne, jamais les deux.

define("RIDE_PENDING_TTL_MINUTES", 30);

// Le statut 'expired' existe-t-il dans la colonne rides.status ?
// Garde-fou de déploiement : si ce fichier PHP est mis en ligne AVANT la
// migration SQL (database/migration_lot_f3b.sql), un UPDATE vers une valeur
// ENUM inconnue ne ferait pas une erreur propre sur tous les serveurs : selon
// le sql_mode, MySQL peut enregistrer une chaîne vide et corrompre les courses.
// On vérifie donc d'abord, et le résultat positif est mémorisé dans la session
// pour ne pas refaire la vérification à chaque requête.
function rides_status_supports_expired(mysqli $conn): bool {
    if (isset($_SESSION["rides_expired_ok"]) && $_SESSION["rides_expired_ok"] === true) {
        return true;
    }

    $ok = false;
    $res = $conn->query("SHOW COLUMNS FROM rides LIKE 'status'");
    if ($res) {
        $row = $res->fetch_assoc();
        $res->free();
        $ok = $row && stripos((string) ($row["Type"] ?? ""), "'expired'") !== false;
    }

    if ($ok) {
        if (isset($_SESSION)) $_SESSION["rides_expired_ok"] = true;
    } elseif (isset($_SESSION) && empty($_SESSION["rides_expired_warned"])) {
        $_SESSION["rides_expired_warned"] = true; // un seul message par session, pas un par requête
        error_log("[ride_expiry] statut 'expired' absent de rides.status : exécutez database/migration_lot_f3b.sql. Expiration désactivée.");
    }
    return $ok;
}

// Passe en 'expired' les courses 'pending' plus vieilles que le délai.
// Renvoie le nombre de courses expirées. Ne lève jamais d'exception : un
// problème d'expiration ne doit pas empêcher l'endpoint appelant de répondre.
function expire_stale_pending_rides(mysqli $conn): int {
    try {
        if (!rides_status_supports_expired($conn)) return 0;

        $ttl = (int) RIDE_PENDING_TTL_MINUTES; // entier : sans risque dans la requête
        $conn->query("
            UPDATE rides
            SET status = 'expired'
            WHERE status = 'pending'
              AND created_at < DATE_SUB(NOW(), INTERVAL $ttl MINUTE)
        ");
        return $conn->affected_rows > 0 ? (int) $conn->affected_rows : 0;
    } catch (Throwable $e) {
        error_log("[ride_expiry] " . $e->getMessage());
        return 0;
    }
}
?>
