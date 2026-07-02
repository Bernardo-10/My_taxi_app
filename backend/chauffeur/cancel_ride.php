<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("UPDATE rides SET status = 'cancelled', cancelled_at = NOW() WHERE id = ? AND driver_id = ? AND status IN ('accepted', 'arrived')");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

json_response(["status" => $updated ? "success" : "error", "message" => $updated ? "Course annulée" : "Impossible d'annuler (course non acceptée, non arrivée ou déjà démarrée)"]);
?>
