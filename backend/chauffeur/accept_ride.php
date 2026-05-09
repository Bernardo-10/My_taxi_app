<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);

if (!isset($data["id"])) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$id = (int) $data["id"];
$driverLat = isset($data["driver_lat"]) && $data["driver_lat"] !== null ? (float) $data["driver_lat"] : null;
$driverLng = isset($data["driver_lng"]) && $data["driver_lng"] !== null ? (float) $data["driver_lng"] : null;

if ($driverLat === null || $driverLng === null) {
    json_response([
        "status" => "error",
        "message" => "Position GPS non disponible",
        "received_lat" => $driverLat,
        "received_lng" => $driverLng
    ], 400);
}

$conn = db_connect();

$driverStmt = $conn->prepare("SELECT name, plate FROM chauffeur WHERE id = ? AND status = 'active'");
$driverStmt->bind_param("i", $driverId);
$driverStmt->execute();
$driver = $driverStmt->get_result()->fetch_assoc();
$driverStmt->close();

if (!$driver) {
    $conn->close();
    json_response(["status" => "error", "message" => "Chauffeur introuvable ou inactif"], 403);
}

$checkStmt = $conn->prepare("SELECT id, status FROM rides WHERE id = ?");
$checkStmt->bind_param("i", $id);
$checkStmt->execute();
$checkResult = $checkStmt->get_result();

if ($checkResult->num_rows === 0) {
    $checkStmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Course introuvable"], 404);
}

$checkStmt->close();

$stmt = $conn->prepare("
    UPDATE rides
    SET status = 'accepted',
        driver_name = ?,
        driver_plate = ?,
        driver_id = ?,
        driver_lat = ?,
        driver_lng = ?,
        update_position_driver = NOW()
    WHERE id = ? AND status = 'pending'
");

if (!$stmt) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur prepare"], 500);
}

$stmt->bind_param("ssiddi", $driver["name"], $driver["plate"], $driverId, $driverLat, $driverLng, $id);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur execute"], 500);
}

$accepted = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

if ($accepted) {
    json_response([
        "status" => "ok",
        "message" => "Course acceptee et position enregistree",
        "driver_lat" => $driverLat,
        "driver_lng" => $driverLng
    ]);
}

json_response(["status" => "error", "message" => "Course non en pending ou deja acceptee"], 409);
?>

