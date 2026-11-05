<?php
/**
 * logout.php — déconnexion (commun client / chauffeur / admin).
 *
 * Chantier S-A (S4) : avant, seule la session PHP était détruite. Restaient valides :
 *   - le jeton de secours `session_token` (qui permettait de recréer la session),
 *   - le jeton de notification (le téléphone recevait encore des courses avec adresses),
 *   - l'état "en ligne" du chauffeur.
 * Maintenant, à la déconnexion :
 *   - chauffeur : mis hors ligne ; REFUSÉ s'il a une course en cours (même règle que
 *     le bouton "Hors ligne" : on n'abandonne pas un client en route) ;
 *   - tous : jeton de secours vidé ; jeton de notification DE CET APPAREIL supprimé
 *     (le navigateur l'envoie dans le corps : { "push_token": "..." }).
 * Si la base répond mal, la session est quand même détruite (on ne bloque jamais
 * une déconnexion pour un incident technique).
 */
require_once __DIR__ . "/../config/auth.php";

$data  = json_decode(file_get_contents("php://input"), true);
$pushToken = (is_array($data) && isset($data["push_token"]) && is_string($data["push_token"]))
    ? substr(trim($data["push_token"]), 0, 4096) : "";

$role = $_SESSION["role"] ?? "";
$map  = [   // rôle => [table, clé de session, type dans push_subscriptions]
    "chauffeur" => ["chauffeur", "driver_id", "chauffeur"],
    "client"    => ["client",    "client_id", "client"],
    "admin"     => ["admin",     "admin_id",  "admin"],
];

if (isset($map[$role]) && !empty($_SESSION[$map[$role][1]])) {
    [$table, $sessionKey, $pushType] = $map[$role];
    $userId = (int) $_SESSION[$sessionKey];

    try {
        $conn = db_connect();

        if ($role === "chauffeur") {
            $stmt = $conn->prepare("SELECT id FROM rides WHERE driver_id = ?
                                    AND status IN ('accepted', 'arrived', 'started') LIMIT 1");
            $stmt->bind_param("i", $userId);
            $stmt->execute();
            $hasActiveRide = $stmt->get_result()->num_rows > 0;
            $stmt->close();
            if ($hasActiveRide) {
                $conn->close();
                json_response(["status" => "error", "code" => "active_ride",
                    "message" => "Terminez ou annulez vos courses en cours avant de vous deconnecter"], 409);
            }
            $stmt = $conn->prepare("UPDATE chauffeur SET is_online = 0, session_token = NULL WHERE id = ?");
        } else {
            $stmt = $conn->prepare("UPDATE `$table` SET session_token = NULL WHERE id = ?");
        }
        $stmt->bind_param("i", $userId);
        $stmt->execute();
        $stmt->close();

        // Jeton de notification de CET appareil seulement (les autres appareils gardent le leur)
        if ($pushToken !== "") {
            $stmt = $conn->prepare("DELETE FROM push_subscriptions WHERE user_type = ? AND user_id = ? AND fcm_token = ?");
            $stmt->bind_param("sis", $pushType, $userId, $pushToken);
            $stmt->execute();
            $stmt->close();
        }
        $conn->close();
    } catch (Throwable $e) {
        error_log("[logout] nettoyage base impossible : " . $e->getMessage());
    }
}

$_SESSION = [];

if (ini_get("session.use_cookies")) {
    $params = session_get_cookie_params();
    setcookie(session_name(), "", time() - 42000, $params["path"], $params["domain"], $params["secure"], $params["httponly"]);
}

session_destroy();

json_response(["status" => "success", "message" => "Session fermee"]);
?>
