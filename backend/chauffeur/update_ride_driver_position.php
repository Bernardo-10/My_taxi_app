<?php
require_once __DIR__ . "/../config/auth.php";

error_reporting(E_ALL);
ini_set("display_errors", 0);

$driverId = require_driver_id();
$rideId = isset($_GET["ride_id"]) ? (int) $_GET["ride_id"] : 0;
$lat = $_GET["lat"] ?? null;
$lng = $_GET["lng"] ?? null;

if ($lat === null || $lng === null) {
    json_response(["status" => "error", "message" => "Coordonnees manquantes"], 400);
}

$lat = (float) $lat;
$lng = (float) $lng;

$conn = db_connect();

foreach ([
    ["driver_lat", "DOUBLE NULL"],
    ["driver_lng", "DOUBLE NULL"],
    ["update_position_driver", "TIMESTAMP NULL DEFAULT NULL"]
] as [$col, $type]) {
    $check = $conn->query("SHOW COLUMNS FROM chauffeur LIKE '$col'");
    if ($check && $check->num_rows === 0) {
        $conn->query("ALTER TABLE chauffeur ADD COLUMN $col $type");
    }
}

$rideUpdated = false;
if ($rideId > 0) {
    $stmt = $conn->prepare("
        UPDATE rides
        SET driver_lat = ?, driver_lng = ?, update_position_driver = NOW()
        WHERE id = ? AND driver_id = ? AND status IN ('accepted', 'arrived', 'started')
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

    $rideUpdated = $stmt->affected_rows > 0;
    $stmt->close();
}

$driverPosStmt = $conn->prepare("
    UPDATE chauffeur
    SET driver_lat = ?, driver_lng = ?, update_position_driver = NOW()
    WHERE id = ?
");
$driverPosStmt->bind_param("ddi", $lat, $lng, $driverId);
$driverPosStmt->execute();
$driverPosStmt->close();
$conn->close();

json_response([
    "status" => "success",
    "message" => "Position mise a jour",
    "lat" => $lat,
    "lng" => $lng,
    "ride_updated" => $rideUpdated
]);
?>
