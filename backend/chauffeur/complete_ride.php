<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("UPDATE rides SET status = 'completed', completed_at = NOW() WHERE id = ? AND driver_id = ? AND status = 'started'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();

if ($updated) {
    // Remplacement du TRIGGER : mise à jour des stats chauffeur
    $rideStmt = $conn->prepare("SELECT distance_km FROM rides WHERE id = ?");
    $rideStmt->bind_param("i", $id);
    $rideStmt->execute();
    $ride = $rideStmt->get_result()->fetch_assoc();
    $rideStmt->close();

    $distance = $ride["distance_km"] ?? 0;

    $statStmt = $conn->prepare("
        UPDATE chauffeur
        SET total_completed_distance_km = total_completed_distance_km + ?,
            total_completed_rides = total_completed_rides + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    ");
    $statStmt->bind_param("di", $distance, $driverId);
    $statStmt->execute();
    $statStmt->close();
    $conn->close();

    json_response(["status" => "success", "message" => "Course terminée"]);
}

$conn->close();
json_response(["status" => "error", "message" => "Impossible de terminer (course non démarrée)"]);
?>