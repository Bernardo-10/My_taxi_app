<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("UPDATE rides SET status = 'started', started_at = NOW() WHERE id = ? AND driver_id = ? AND status = 'arrived'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();

if (!$updated) {
    $checkStmt = $conn->prepare("SELECT status FROM rides WHERE id = ? AND driver_id = ?");
    $checkStmt->bind_param("ii", $id, $driverId);
    $checkStmt->execute();
    $ride = $checkStmt->get_result()->fetch_assoc();
    $checkStmt->close();
    $conn->close();

    $message = "Impossible de demarrer la course";
    if (($ride["status"] ?? "") === "accepted") {
        $message = "Marquez d'abord votre arrivee avant de demarrer";
    }

    json_response(["status" => "error", "message" => $message], 409);
}

$conn->close();

json_response(["status" => "success", "message" => "Course commencee"]);
?>
