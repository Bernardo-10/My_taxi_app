<?php
require_once __DIR__ . "/../config/auth.php";

$data = json_decode(file_get_contents("php://input"), true);

if (!$data) {
    json_response(["status" => "error", "message" => "Aucune donnee recue"], 400);
}

$login    = trim($data["login"] ?? $data["email"] ?? "");
$password = $data["password"] ?? "";

if ($login === "" || $password === "") {
    json_response(["status" => "error", "message" => "Identifiant et mot de passe requis"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    SELECT id, username, email, password_hash
    FROM admin
    WHERE email = ? OR username = ?
    LIMIT 1
");
$stmt->bind_param("ss", $login, $login);
$stmt->execute();
$result = $stmt->get_result();
$admin  = $result->fetch_assoc();
$stmt->close();

if (!$admin || !password_verify($password, $admin["password_hash"])) {
    $conn->close();
    json_response(["status" => "error", "message" => "Identifiants invalides"], 401);
}

session_regenerate_id(true);
refresh_session_cookie();
$_SESSION["role"]       = "admin";
$_SESSION["admin_id"]   = (int) $admin["id"];
$_SESSION["admin_name"] = $admin["username"];
unset($_SESSION["client_id"], $_SESSION["driver_id"]);

$token = session_id();
$stmt2 = $conn->prepare("UPDATE admin SET session_token = ?, session_updated_at = NOW() WHERE id = ?");
$stmt2->bind_param("si", $token, $admin["id"]);
$stmt2->execute();
$stmt2->close();
$conn->close();

json_response([
    "status"  => "success",
    "message" => "Administrateur connecte",
    "admin"   => [
        "id"       => (int) $admin["id"],
        "username" => $admin["username"],
        "email"    => $admin["email"]
    ]
]);
?>
