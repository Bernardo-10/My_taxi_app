<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/normalize.php";   // Lot 11 : téléphone et plaque normalisés
require_once __DIR__ . "/../common/rate_limit.php";  // S-A : limiteur de tentatives

$data = json_decode(file_get_contents("php://input"), true);

if (!$data) {
    json_response(["status" => "error", "message" => "Aucune donnee recue"], 400);
}

$login = trim($data["login"] ?? $data["email"] ?? $data["phone"] ?? "");
$password = $data["password"] ?? "";

if ($login === "" || $password === "") {
    json_response(["status" => "error", "message" => "Identifiant et mot de passe requis"], 400);
}

if (strlen($login) > 120) {
    json_response(["status" => "error", "message" => "Identifiants invalides"], 401);
}

$conn = db_connect();

// ── S-A (S7) : limiteur de tentatives ──
// Identifiant mémorisé sous sa forme canonique (téléphone +237...) : "677123456" et
// "+237 677 123 456" comptent comme le MÊME identifiant.
$rlIp    = rl_ip();
$rlIdent = rl_ident(strpos($login, "@") !== false ? $login : (normalize_phone($login) ?? $login));
$wait = max(
    rl_wait_seconds($conn, "login", $rlIp, $rlIdent, RL_LOGIN_MAX_IDENT, RL_LOGIN_WINDOW),
    rl_wait_seconds($conn, "login", $rlIp, null,     RL_LOGIN_MAX_IP,    RL_LOGIN_WINDOW)
);
if ($wait > 0) {
    $conn->close();
    rl_block_response($wait, "tentatives de connexion");
}

// ── Lot 11 : recherche du compte par e-mail OU téléphone ──
// Avant : un seul "WHERE email = ? OR phone = ? OR plate = ?" avec la saisie brute,
// donc "677123456" ne retrouvait pas un compte enregistré "+237 677 123 456".
// Maintenant la saisie est normalisée (comme à l'inscription) et les trois
// recherches se font dans un ordre fixe, pour qu'une saisie ne puisse jamais
// correspondre à deux comptes différents : e-mail, puis téléphone, puis plaque.
$columns = "id, name, email, phone, plate, car_brand, car_color, password_hash, status";

/** Exécute une recherche à paramètres texte et renvoie la première ligne (ou null). */
function find_driver_row($conn, $columns, $where, array $params) {
    $stmt = $conn->prepare("SELECT $columns FROM chauffeur WHERE $where LIMIT 1");
    if (!$stmt) return null;
    $stmt->bind_param(str_repeat("s", count($params)), ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

$driver = null;

if (strpos($login, "@") !== false) {
    // 1. E-mail
    $driver = find_driver_row($conn, $columns, "email = ?", [$login]);
} else {
    // 2. Téléphone (n'importe quelle écriture : +237 6.., 6.., 00237..)
    $phoneCanon = normalize_phone($login);
    if ($phoneCanon !== null) {
        $variants     = phone_digit_variants($phoneCanon);
        $placeholders = implode(",", array_fill(0, count($variants), "?"));
        $driver = find_driver_row(
            $conn, $columns,
            "phone = ? OR phone = ? OR " . sql_phone_digits("phone") . " IN ($placeholders)",
            array_merge([$phoneCanon, $login], $variants)
        );
    }
    // S-A (S7) : la connexion par plaque a été retirée (la plaque est publique : elle
    // permettait de cibler le compte d'un chauffeur précis). E-mail ou téléphone seulement.
}

// S-A (S7) : le mot de passe est TOUJOURS vérifié, même si le compte n'existe pas (contre un
// faux hash), pour que la réponse prenne le même temps : sinon la rapidité de la réponse
// révélait si l'identifiant correspondait à un compte.
const LOGIN_DUMMY_HASH = '$2y$10$XryX0CVt4PapmoMJpKzZkOcrhz5sIlgyWfYYucJ2NBMY9GIBxrWi2';
$passwordOk = password_verify($password, $driver["password_hash"] ?? LOGIN_DUMMY_HASH);

if (!$driver || $driver["status"] !== "active" || !$passwordOk) {
    rl_record($conn, "login", $rlIp, $rlIdent);   // échec noté pour le limiteur
    $conn->close();
    json_response(["status" => "error", "message" => "Identifiants invalides"], 401);
}
rl_clear($conn, "login", $rlIp, $rlIdent);        // succès : on repart de zéro

session_regenerate_id(true);
refresh_session_cookie();
$_SESSION["role"] = "chauffeur";
$_SESSION["driver_id"] = (int) $driver["id"];
$_SESSION["driver_name"] = $driver["name"];
$_SESSION["driver_checked_at"] = time();   // statut vérifié à l'instant (voir require_driver_id)
unset($_SESSION["client_id"], $_SESSION["client_name"]);

$sessionToken = store_session_token($conn, "chauffeur", (int) $driver["id"]);
$conn->close();

json_response([
    "status" => "success",
    "message" => "Chauffeur connecte",
    "session_token" => $sessionToken,
    "driver" => [
        "id" => (int) $driver["id"],
        "name" => $driver["name"],
        "email" => $driver["email"],
        "phone" => $driver["phone"],
        "plate" => $driver["plate"],
        "car_brand" => $driver["car_brand"],
        "car_color" => $driver["car_color"]
    ]
]);
?>

