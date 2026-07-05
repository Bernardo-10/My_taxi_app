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

// ── Domaine dynamique (remplace le domaine "taxigocmr.wuaze.com" codé en dur) ──
// Un cookie dont l'attribut Domain ne correspond pas exactement au nom d'hôte
// réellement visité est silencieusement rejeté par le navigateur : c'est ce
// qui provoquait la boucle de login constatée chez un utilisateur arrivant
// par un autre nom d'hôte que celui codé en dur.
function get_request_host(): string {
    $host = $_SERVER["HTTP_HOST"] ?? $_SERVER["SERVER_NAME"] ?? "";
    return preg_replace('/:\d+$/', '', $host); // retire un éventuel port (ex: localhost:8080)
}

function get_cookie_domain(): ?string {
    $host = get_request_host();
    // Les navigateurs rejettent l'attribut Domain sur une IP, et il est
    // inutile pour localhost : dans ces cas, on l'omet pour laisser le
    // navigateur utiliser l'hôte courant par défaut.
    if ($host === "" || $host === "localhost" || filter_var($host, FILTER_VALIDATE_IP)) {
        return null;
    }
    return $host;
}

function get_allowed_origin(): string {
    // Reflète l'origine réelle de la requête plutôt qu'un domaine figé —
    // nécessaire dès qu'on utilise Access-Control-Allow-Credentials: true
    // (la spec interdit "*" dans ce cas de toute façon).
    if (!empty($_SERVER["HTTP_ORIGIN"])) {
        return $_SERVER["HTTP_ORIGIN"];
    }
    $scheme = (!empty($_SERVER["HTTPS"]) && $_SERVER["HTTPS"] !== "off") ? "https" : "http";
    return $scheme . "://" . get_request_host();
}

$cookieDomain = get_cookie_domain();

if (session_status() === PHP_SESSION_NONE) {
    ini_set("session.gc_maxlifetime", (string) $sessionLifetime);
    $cookieParams = [
        "lifetime" => $sessionLifetime,
        "path"     => "/",
        "secure"   => true,
        "httponly" => true,
        "samesite" => "None"
    ];
    if ($cookieDomain !== null) {
        $cookieParams["domain"] = $cookieDomain;
    }
    session_set_cookie_params($cookieParams);
    session_start();
}

header("Access-Control-Allow-Origin: " . get_allowed_origin());
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
    $params = [
        "expires"  => time() + $sessionLifetime,
        "path"     => "/",
        "secure"   => true,
        "httponly" => true,
        "samesite" => "None"
    ];
    $domain = get_cookie_domain();
    if ($domain !== null) {
        $params["domain"] = $domain;
    }
    setcookie(session_name(), session_id(), $params);
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

/**
 * Corrige les chauffeurs marqués "en ligne" (is_online = 1) dont la dernière
 * position GPS remonte à plus de 10 minutes -- même seuil que la carte admin
 * et la liste "chauffeurs à proximité" côté client.
 *
 * is_online n'est mis à jour QUE par un appel explicite du chauffeur
 * (toggle "En ligne"/"Hors ligne") ; rien ne le repasse à 0 quand l'app se
 * ferme, perd le réseau, ou que le téléphone s'éteint. Sans ce correctif,
 * un chauffeur déconnecté depuis des heures reste affiché "En ligne" dans
 * le tableau admin, alors même que la carte et la liste client, elles,
 * appliquent déjà un filtre de fraîcheur en lecture.
 *
 * Suit le même principe "lazy" que l'expiration de session ci-dessus :
 * corrigé au moment de la lecture plutôt que par une tâche planifiée
 * (absente sur InfinityFree). Appelée par tous les endpoints qui affichent
 * ou comptent des chauffeurs en ligne (liste chauffeurs admin, carte admin,
 * chauffeurs à proximité côté client, KPI dashboard) pour qu'ils restent
 * tous d'accord entre eux à chaque rafraîchissement.
 */
function sync_stale_drivers_offline($conn) {
    $conn->query("
        UPDATE chauffeur
        SET is_online = 0
        WHERE is_online = 1
          AND (update_position_driver IS NULL
               OR update_position_driver < DATE_SUB(NOW(), INTERVAL 10 MINUTE))
    ");
}

function json_response($payload, $statusCode = 200) {
    http_response_code($statusCode);
    header("Content-Type: application/json; charset=utf-8");
    // Ces réponses reflètent un état de session à l'instant T (connecté / rôle /
    // en ligne...). Sans ces en-têtes, un navigateur -- ou une couche proxy côté
    // hébergeur -- peut légitimement réutiliser une ancienne réponse GET pour
    // current_user.php au lieu de refaire l'aller-retour serveur : le client reste
    // alors bloqué avec un statut "connecté" périmé et ne redirige jamais vers le
    // login, même après une longue attente.
    header("Cache-Control: no-store, no-cache, must-revalidate");
    header("Pragma: no-cache");
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