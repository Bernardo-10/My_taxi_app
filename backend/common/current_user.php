<?php
require_once __DIR__ . "/../config/auth.php";
// S-A : les error_log qui écrivaient l'identifiant de session et le cookie ont été retirés
// (un identifiant de session lisible dans un journal permet de prendre la session).

// Fallback : si session vide, tenter via session_token en BD.
// S-A (S4) : ce jeton n'est valable que 30 jours après la dernière connexion
// (session_updated_at), et il est vidé à la déconnexion / à la désactivation du compte.
if (empty($_SESSION["role"])) {
    $cookieToken = $_COOKIE[session_name()] ?? "";
    if ($cookieToken) {
        $conn = db_connect();

        // Chercher dans table client
        $stmt = $conn->prepare("SELECT id FROM client WHERE session_token = ? AND status = 'active'
                                AND session_updated_at > DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 1");
        $stmt->bind_param("s", $cookieToken);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();

        if ($row) {
            $_SESSION["role"] = "client";
            $_SESSION["client_id"] = (int) $row["id"];
        } else {
            // Chercher dans table chauffeur
            $stmt = $conn->prepare("SELECT id FROM chauffeur WHERE session_token = ? AND status = 'active'
                                    AND session_updated_at > DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 1");
            $stmt->bind_param("s", $cookieToken);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            $stmt->close();

            if ($row) {
                $_SESSION["role"] = "chauffeur";
                $_SESSION["driver_id"] = (int) $row["id"];
                $_SESSION["driver_checked_at"] = time();   // le statut "active" vient d'être vérifié ci-dessus
            }
        }
        $conn->close();
    }
}

$role = $_SESSION["role"] ?? "";
$user = null;
$conn = db_connect();

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
    // kyc_status ajouté (voir rapport friction-inscription-chauffeur.md) :
    // c'est ce que le frontend utilise pour afficher le bandeau "Complétez
    // votre profil" quand kyc_status === 'incomplete'.
    $stmt = $conn->prepare("
        SELECT id, name, email, phone, plate, car_brand, car_color, status, is_online, kyc_status,
               update_position_driver, cni_expiration, carte_grise_expiration,
               permit_expiration, capacity_expiration, license_expiration
        FROM chauffeur WHERE id = ? LIMIT 1
    ");
    $stmt->bind_param("i", $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    // B1 : le front (chauffeur-ui.js, refreshDriverStatus) lit offline_reason
    // et expired_documents, qui n'étaient renvoyés par aucun endpoint.
    // Pas de colonne en base : la raison est déduite de l'état actuel.
    //   kyc_expired    = au moins un document a une date d'expiration passée
    //   stale_position = aucune position GPS reçue depuis 10 min (même seuil
    //                    que sync_stale_drivers_offline() dans auth.php)
    //   null           = autre cas (mise hors ligne par l'administrateur)
    if ($user) {
        $docLabels = [
            "cni_expiration" => "CNI",
            "carte_grise_expiration" => "Carte grise",
            "permit_expiration" => "Permis de conduire",
            "capacity_expiration" => "Carte de capacité",
            "license_expiration" => "Licence professionnelle"
        ];
        $today = new DateTime("today");
        $expiredDocs = [];
        foreach ($docLabels as $col => $label) {
            if (!empty($user[$col]) && new DateTime($user[$col]) < $today) {
                $expiredDocs[] = $label;
            }
        }

        $offlineReason = null;
        if ((int) $user["is_online"] === 0) {
            $lastPing = !empty($user["update_position_driver"]) ? strtotime($user["update_position_driver"]) : 0;
            if ($expiredDocs) {
                $offlineReason = "kyc_expired";
            } elseif ($lastPing === 0 || $lastPing < time() - 600) {
                $offlineReason = "stale_position";
            }
        }
        $user["offline_reason"] = $offlineReason;
        $user["expired_documents"] = $expiredDocs;

        // Ces colonnes ne servent qu'au calcul ci-dessus : inutile de les exposer.
        foreach (array_keys($docLabels) as $col) unset($user[$col]);
        unset($user["update_position_driver"]);
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