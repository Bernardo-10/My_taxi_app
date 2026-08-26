<?php
require_once __DIR__ . "/../config/auth.php";
error_log("=== CURRENT_USER SESSION === ID: " . session_id());
error_log("=== CURRENT_USER SESSION === role: " . ($_SESSION['role'] ?? 'vide'));
error_log("=== CURRENT_USER SESSION === client_id: " . ($_SESSION['client_id'] ?? 'vide'));
error_log("=== CURRENT_USER COOKIE === " . ($_COOKIE[session_name()] ?? 'absent'));

// Fallback : si session vide, tenter via session_token en BD
if (empty($_SESSION["role"])) {
    $cookieToken = $_COOKIE[session_name()] ?? "";
    if ($cookieToken) {
        $conn = db_connect();

        // Chercher dans table client
        $stmt = $conn->prepare("SELECT id FROM client WHERE session_token = ? AND status = 'active' LIMIT 1");
        $stmt->bind_param("s", $cookieToken);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();

        if ($row) {
            $_SESSION["role"] = "client";
            $_SESSION["client_id"] = (int) $row["id"];
        } else {
            // Chercher dans table chauffeur
            $stmt = $conn->prepare("SELECT id FROM chauffeur WHERE session_token = ? AND status = 'active' LIMIT 1");
            $stmt->bind_param("s", $cookieToken);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            $stmt->close();

            if ($row) {
                $_SESSION["role"] = "chauffeur";
                $_SESSION["driver_id"] = (int) $row["id"];
            }
        }
        $conn->close();
    }
}

$role = $_SESSION["role"] ?? "";
$user = null;
$conn = db_connect();

// Correctif §4.2 du rapport KYC : sync_stale_drivers_offline() n'était
// jusqu'ici déclenchée que par des requêtes tierces (admin, client) —
// jamais par le chauffeur lui-même. Résultat : un chauffeur qui ferme
// son app peut rester "en ligne" en base indéfiniment si personne
// d'autre ne consulte la plateforme entre-temps. En l'appelant ici,
// la toute première action du chauffeur à chaque ouverture d'app
// corrige son propre état, sans dépendre du trafic ambiant.
sync_stale_drivers_offline($conn);

if ($role === "client" && !empty($_SESSION["client_id"])) {
    $id = (int) $_SESSION["client_id"];
    $stmt = $conn->prepare("
        SELECT id, full_name AS name, email, phone, car_brand, car_color, status
        FROM client WHERE id = ? LIMIT 1
    ");
    $stmt->bind_param("i", $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();
} elseif ($role === "chauffeur" && !empty($_SESSION["driver_id"])) {
    $id = (int) $_SESSION["driver_id"];
    $stmt = $conn->prepare("
        SELECT id, name, email, phone, plate, car_brand, car_color, status, is_online,
               update_position_driver,
               cni_expiration, carte_grise_expiration, permit_expiration,
               capacity_expiration, license_expiration
        FROM chauffeur WHERE id = ? LIMIT 1
    ");
    $stmt->bind_param("i", $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if ($user) {
        // ── Alerte proactive d'expiration (rapport §3.3, point 1) ──
        // Volontairement léger : juste le nombre de jours restants par
        // document, pas les numéros ni les photos — ça, c'est le rôle
        // de get_my_documents.php quand le chauffeur ouvre réellement
        // le tiroir "Mes documents". Ici on alimente seulement le badge
        // discret, vérifié à chaque ouverture d'app.
        $expirationFields = [
            "cni" => "cni_expiration",
            "carte_grise" => "carte_grise_expiration",
            "permit" => "permit_expiration",
            "capacity" => "capacity_expiration",
            "license" => "license_expiration"
        ];
        $today = new DateTime("today");
        $kycAlert = [];
        $expiredLabels = [];
        $docLabels = [
            "cni" => "CNI", "carte_grise" => "Carte grise", "permit" => "Permis de conduire",
            "capacity" => "Carte de capacité", "license" => "Licence professionnelle"
        ];

        foreach ($expirationFields as $group => $col) {
            $daysUntil = null;
            if (!empty($user[$col])) {
                $expDate = new DateTime($user[$col]);
                $daysUntil = (int) $today->diff($expDate)->format("%r%a");
                if ($daysUntil < 0) $expiredLabels[] = $docLabels[$group];
            }
            $kycAlert[$group] = ["days_until_expiration" => $daysUntil, "pending" => null];
        }

        // Un document déjà "rejected" en renouvellement compte aussi pour
        // le badge, au même titre qu'une expiration proche (rapport §3.2).
        $rejectedStmt = $conn->prepare("
            SELECT document_group FROM chauffeur_document_renewals
            WHERE chauffeur_id = ? AND status = 'rejected'
        ");
        $rejectedStmt->bind_param("i", $id);
        $rejectedStmt->execute();
        $rejectedResult = $rejectedStmt->get_result();
        while ($r = $rejectedResult->fetch_assoc()) {
            if (isset($kycAlert[$r["document_group"]])) {
                $kycAlert[$r["document_group"]]["pending"] = ["status" => "rejected"];
            }
        }
        $rejectedStmt->close();

        // ── Correctif §4.1 (filet de sécurité) ──────────────────────
        // get_rides.php est le point de repassage principal pendant que
        // le chauffeur est en ligne (interrogé en boucle toutes les 5s).
        // Ici, current_user.php n'est appelé qu'au chargement de page —
        // ça reste utile comme filet de sécurité pour le cas où l'app
        // est rouverte après une longue absence, document déjà expiré.
        if ($expiredLabels && (int) $user["is_online"] === 1) {
            $offStmt = $conn->prepare("UPDATE chauffeur SET is_online = 0 WHERE id = ?");
            $offStmt->bind_param("i", $id);
            $offStmt->execute();
            $offStmt->close();
            $user["is_online"] = 0;
        }

        // ── Correctif §4.3 : cause réelle du passage hors ligne ─────
        // Sans ce champ, le frontend affichait systématiquement "changé
        // par l'administrateur" — faux dans les deux autres cas. Ordre
        // de priorité : un document expiré est l'explication la plus
        // actionnable pour le chauffeur, donc vérifiée en premier.
        $offlineReason = null;
        if ((int) $user["is_online"] === 0) {
            if ($expiredLabels) {
                $offlineReason = "kyc_expired";
            } elseif (empty($user["update_position_driver"]) ||
                      strtotime($user["update_position_driver"]) < strtotime("-10 minutes")) {
                $offlineReason = "stale_position";
            } else {
                $offlineReason = "admin";
            }
        }

        $user["kyc_alert"] = $kycAlert;
        $user["offline_reason"] = $offlineReason;
        $user["expired_documents"] = $expiredLabels;
        unset($user["update_position_driver"]); // détail interne, pas utile au frontend
    }
} else {
    $conn->close();
    json_response([
        "status"      => "error",
        "message"     => "Utilisateur non connecte",
        "session_id"  => session_id(),
        "session"     => $_SESSION,
        "cookie"      => $_COOKIE[session_name()] ?? "absent",
        "all_cookies" => $_COOKIE
    ], 401);
}

$conn->close();

if (!$user) {
    json_response(["status" => "error", "message" => "Utilisateur introuvable"], 404);
}

$user["id"] = (int) $user["id"];
$user["role"] = $role;

json_response(["status" => "success", "user" => $user]);
?>