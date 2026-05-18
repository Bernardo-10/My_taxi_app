<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("UPDATE rides SET status = 'arrived' WHERE id = ? AND driver_id = ? AND status = 'accepted'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

json_response([
    "status" => $updated ? "success" : "error",
    "message" => $updated ? "Arrivee chauffeur confirmee" : "Impossible de marquer la course comme arrivee"
]);
?>
