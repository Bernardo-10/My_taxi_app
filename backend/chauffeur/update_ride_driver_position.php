<?php
require_once __DIR__ . "/../config/auth.php";

error_reporting(E_ALL);
ini_set("display_errors", 0);

$driverId = require_driver_id();
$rideId = isset($_GET["ride_id"]) ? (int) $_GET["ride_id"] : 0;
$lat = $_GET["lat"] ?? null;
$lng = $_GET["lng"] ?? null;

if (!$rideId) {
    json_response(["status" => "error", "message" => "ride_id manquant"], 400);
}

if ($lat === null || $lng === null) {
    json_response(["status" => "error", "message" => "Coordonnees manquantes"], 400);
}

$lat = (float) $lat;
$lng = (float) $lng;

$conn = db_connect();
$stmt = $conn->prepare("
    UPDATE rides
    SET driver_lat = ?, driver_lng = ?, update_position_driver = NOW()
    WHERE id = ? AND driver_id = ? AND status IN ('accepted', 'started')
");

if (!$stmt) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur prepare"], 500);
}

$stmt->bind_param("ddii", $lat, $lng, $rideId, $driverId);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur execute"], 500);
}

$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

if ($updated) {
    json_response(["status" => "success", "message" => "Position mise a jour", "lat" => $lat, "lng" => $lng]);
}

json_response(["status" => "error", "message" => "Course non trouvee ou non attribuee a ce chauffeur"], 404);
?>

