<?php
require_once __DIR__ . "/../config/auth.php";

$data = json_decode(file_get_contents("php://input"), true);

if (!$data) {
    json_response(["status" => "error", "message" => "Aucune donnee recue"], 400);
}

$login = trim($data["login"] ?? $data["email"] ?? $data["phone"] ?? "");
$password = $data["password"] ?? "";

if ($login === "" || $password === "") {
    json_response(["status" => "error", "message" => "Identifiant et mot de passe requis"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    SELECT id, full_name, email, phone, password_hash, status
    FROM client
    WHERE email = ? OR phone = ?
    LIMIT 1
");
$stmt->bind_param("ss", $login, $login);
$stmt->execute();
$result = $stmt->get_result();
$client = $result->fetch_assoc();
$stmt->close();

if (!$client || $client["status"] !== "active" || !password_verify($password, $client["password_hash"])) {
    $conn->close();
    json_response(["status" => "error", "message" => "Identifiants invalides"], 401);
}

session_regenerate_id(true);
refresh_session_cookie();
$_SESSION["role"] = "client";
$_SESSION["client_id"] = (int) $client["id"];
$_SESSION["client_name"] = $client["full_name"];
unset($_SESSION["driver_id"], $_SESSION["driver_name"]);

$sessionToken = store_session_token($conn, "client", (int) $client["id"]);
$conn->close();

error_log("=== LOGIN SESSION === ID: " . session_id());
error_log("=== LOGIN SESSION === role: " . ($_SESSION['role'] ?? 'vide'));
error_log("=== LOGIN SESSION === client_id: " . ($_SESSION['client_id'] ?? 'vide'));

json_response([
    "status" => "success",
    "message" => "Client connecte",
    "session_token" => $sessionToken,
    "client" => [
        "id" => (int) $client["id"],
        "name" => $client["full_name"],
        "email" => $client["email"],
        "phone" => $client["phone"]
    ]
]);
?>

