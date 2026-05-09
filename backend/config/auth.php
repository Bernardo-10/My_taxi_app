<?php
$sessionLifetime = 3600; // 1 heure pour les tests.
$sessionCookieOptions = [
    "expires" => time() + $sessionLifetime,
    "path" => "/",
    "domain" => "",
    "secure" => !empty($_SERVER["HTTPS"]) && $_SERVER["HTTPS"] !== "off",
    "httponly" => true,
    "samesite" => "Lax"
];

if (session_status() === PHP_SESSION_NONE) {
    ini_set("session.gc_maxlifetime", (string) $sessionLifetime);
    session_set_cookie_params([
        "lifetime" => $sessionLifetime,
        "path" => $sessionCookieOptions["path"],
        "domain" => $sessionCookieOptions["domain"],
        "secure" => $sessionCookieOptions["secure"],
        "httponly" => $sessionCookieOptions["httponly"],
        "samesite" => $sessionCookieOptions["samesite"]
    ]);
    session_start();
}

require_once __DIR__ . "/db.php";

$sessionExpired = false;

function refresh_session_cookie() {
    global $sessionLifetime, $sessionCookieOptions;

    if (session_status() !== PHP_SESSION_ACTIVE || !ini_get("session.use_cookies")) {
        return;
    }

    $options = $sessionCookieOptions;
    $options["expires"] = time() + $sessionLifetime;
    setcookie(session_name(), session_id(), $options);
}

function expire_session() {
    $_SESSION = [];

    if (ini_get("session.use_cookies")) {
        $params = session_get_cookie_params();
        setcookie(session_name(), "", time() - 42000, $params["path"], $params["domain"], $params["secure"], $params["httponly"]);
    }

    session_destroy();
}

if (!empty($_SESSION["last_activity"]) && (time() - (int) $_SESSION["last_activity"]) > $sessionLifetime) {
    expire_session();
    $sessionExpired = true;
}

if (!$sessionExpired && session_status() === PHP_SESSION_ACTIVE) {
    $_SESSION["last_activity"] = time();
    refresh_session_cookie();
}

function json_response($payload, $statusCode = 200) {
    http_response_code($statusCode);
    header("Content-Type: application/json; charset=utf-8");
    echo json_encode($payload);
    exit;
}

function require_client_id() {
    if (empty($_SESSION["client_id"]) || ($_SESSION["role"] ?? "") !== "client") {
        json_response(["status" => "error", "message" => "Client non connecte"], 401);
    }

    return (int) $_SESSION["client_id"];
}

function require_driver_id() {
    if (empty($_SESSION["driver_id"]) || ($_SESSION["role"] ?? "") !== "chauffeur") {
        json_response(["status" => "error", "message" => "Chauffeur non connecte"], 401);
    }

    return (int) $_SESSION["driver_id"];
}

function store_session_token($conn, $table, $id) {
    $token = session_id();
    $stmt = $conn->prepare("UPDATE `$table` SET session_token = ?, session_updated_at = NOW() WHERE id = ?");
    $stmt->bind_param("si", $token, $id);
    $stmt->execute();
    $stmt->close();
    return $token;
}
?>
