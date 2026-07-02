<?php
// Durée de vie de la session : 5 jours (en secondes).
// Source unique — read() et le reste du fichier s'alignent dessus,
// pour éviter la désynchronisation qui existait avant (read() avait
// sa propre valeur de 3600 codée en dur, indépendante du reste).
define("SESSION_LIFETIME", 5 * 24 * 60 * 60);

// Stocker les sessions en base de données MySQL
class DbSessionHandler implements SessionHandlerInterface {
    private $conn;

    public function open($path, $name): bool {
        $creds = require __DIR__ . "/credentials.php";
        $this->conn = new mysqli(
            $creds["db_host"],
            $creds["db_user"],
            $creds["db_pass"],
            $creds["db_name"]
        );
        return !$this->conn->connect_error;
    }

    public function close(): bool {
        $this->conn->close();
        return true;
    }

    public function read($id): string {
        $stmt = $this->conn->prepare("SELECT data FROM sessions WHERE id = ? AND last_activity > ?");
        $expiry = time() - SESSION_LIFETIME;
        $stmt->bind_param("si", $id, $expiry);
        $stmt->execute();
        $result = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $result["data"] ?? "";
    }

    public function write($id, $data): bool {
        $time = time();
        $stmt = $this->conn->prepare("REPLACE INTO sessions (id, data, last_activity) VALUES (?, ?, ?)");
        $stmt->bind_param("ssi", $id, $data, $time);
        $result = $stmt->execute();
        $stmt->close();
        return $result;
    }

    public function destroy($id): bool {
        $stmt = $this->conn->prepare("DELETE FROM sessions WHERE id = ?");
        $stmt->bind_param("s", $id);
        $result = $stmt->execute();
        $stmt->close();
        return $result;
    }

    public function gc($max_lifetime): int|false {
        $expiry = time() - $max_lifetime;
        $stmt = $this->conn->prepare("DELETE FROM sessions WHERE last_activity < ?");
        $stmt->bind_param("i", $expiry);
        $stmt->execute();
        $count = $stmt->affected_rows;
        $stmt->close();
        return $count;
    }
}

$handler = new DbSessionHandler();
session_set_save_handler($handler, true);

$sessionLifetime = SESSION_LIFETIME;

if (session_status() === PHP_SESSION_NONE) {
    ini_set("session.gc_maxlifetime", (string) $sessionLifetime);
    session_set_cookie_params([
        "lifetime" => $sessionLifetime,
        "path"     => "/",
        "domain"   => "taxigocmr.wuaze.com",
        "secure"   => true,
        "httponly" => true,
        "samesite" => "None"
    ]);
    session_start();
}

header("Access-Control-Allow-Origin: https://taxigocmr.wuaze.com");
header("Access-Control-Allow-Credentials: true");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . "/db.php";

$sessionExpired = false;

function refresh_session_cookie() {
    global $sessionLifetime;
    if (session_status() !== PHP_SESSION_ACTIVE || !ini_get("session.use_cookies")) {
        return;
    }
    setcookie(session_name(), session_id(), [
        "expires"  => time() + $sessionLifetime,
        "path"     => "/",
        "domain"   => "taxigocmr.wuaze.com",
        "secure"   => true,
        "httponly" => true,
        "samesite" => "None"
    ]);
}

function expire_session() {
    $_SESSION = [];
    if (ini_get("session.use_cookies")) {
        $params = session_get_cookie_params();
        setcookie(session_name(), "", time() - 42000,
            $params["path"], $params["domain"],
            $params["secure"], $params["httponly"]);
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

function require_admin_id() {
    if (empty($_SESSION["admin_id"]) || ($_SESSION["role"] ?? "") !== "admin") {
        json_response(["status" => "error", "message" => "Acces administrateur requis"], 401);
    }
    return (int) $_SESSION["admin_id"];
}
?>