<?php
require_once __DIR__ . "/../config/auth.php";

$role = $_SESSION["role"] ?? "";
$user = null;
$conn = db_connect();

if ($role === "client" && !empty($_SESSION["client_id"])) {
    $id = (int) $_SESSION["client_id"];
    $stmt = $conn->prepare("
        SELECT id, full_name AS name, email, phone, car_brand, car_color, status
        FROM client
        WHERE id = ?
        LIMIT 1
    ");
    $stmt->bind_param("i", $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();
} elseif ($role === "chauffeur" && !empty($_SESSION["driver_id"])) {
    $id = (int) $_SESSION["driver_id"];
    $stmt = $conn->prepare("
        SELECT id, name, email, phone, plate, car_brand, car_color, status
        FROM chauffeur
        WHERE id = ?
        LIMIT 1
    ");
    $stmt->bind_param("i", $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();
} else {
    $conn->close();
    json_response(["status" => "error", "message" => "Utilisateur non connecte"], 401);
}

$conn->close();

if (!$user) {
    json_response(["status" => "error", "message" => "Utilisateur introuvable"], 404);
}

$user["id"] = (int) $user["id"];
$user["role"] = $role;

json_response([
    "status" => "success",
    "user" => $user
]);
?>

