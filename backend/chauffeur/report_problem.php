<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;
$problem_description = isset($data["problem"]) ? trim($data["problem"]) : "";

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

if (!$problem_description) {
    json_response(["status" => "error", "message" => "Description du probleme requise"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("UPDATE rides SET status = 'reported', problem_description = ? WHERE id = ? AND driver_id = ? AND status = 'started'");
$stmt->bind_param("sii", $problem_description, $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

json_response([
    "status" => $updated ? "success" : "error",
    "message" => $updated ? "Probleme signale" : "Impossible de signaler (course non demarree)"
]);
?>
