<?php
require_once __DIR__ . "/../config/auth.php";

error_reporting(E_ALL);
ini_set("display_errors", 0);

$userId = require_client_id();
$rideId = isset($_GET["ride_id"]) ? (int) $_GET["ride_id"] : 0;

if (!$rideId) {
    json_response(["status" => "error", "message" => "ID de course manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    SELECT driver_lat, driver_lng, pickup_lat, pickup_lng, status, update_position_driver
    FROM rides
    WHERE id = ? AND user_id = ?
");

if (!$stmt) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur requete"], 500);
}

$stmt->bind_param("ii", $rideId, $userId);
$stmt->execute();
$result = $stmt->get_result();

if ($result->num_rows === 0) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Course non trouvee"], 404);
}

$ride = $result->fetch_assoc();
$stmt->close();
$conn->close();

$driverLat = $ride["driver_lat"];
$driverLng = $ride["driver_lng"];

if ($driverLat !== null && $driverLng !== null && (float) $driverLat != 0.0 && (float) $driverLng != 0.0) {
    json_response([
        "status" => "success",
        "driver_lat" => (float) $driverLat,
        "driver_lng" => (float) $driverLng,
        "source" => "driver_position",
        "last_update" => $ride["update_position_driver"]
    ]);
}

json_response([
    "status" => "error",
    "message" => "Position du chauffeur non disponible",
    "driver_lat" => null,
    "driver_lng" => null,
    "source" => "none"
], 404);
?>

