<?php
require_once __DIR__ . "/../config/auth.php";

$userId = require_client_id();
$data = json_decode(file_get_contents("php://input"), true);
$rideId = isset($data["ride_id"]) ? (int) $data["ride_id"] : 0;
$problem = isset($data["problem"]) ? trim($data["problem"]) : "";

if (!$rideId) {
    json_response(["status" => "error", "message" => "ID de course manquant"], 400);
}

if ($problem === "") {
    json_response(["status" => "error", "message" => "Description du probleme requise"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    UPDATE rides
    SET client_problem_description = ?,
        client_problem_at = NOW()
    WHERE id = ?
      AND user_id = ?
      AND status IN ('accepted', 'arrived', 'started')
");

if (!$stmt) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur prepare"], 500);
}

$stmt->bind_param("sii", $problem, $rideId, $userId);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur lors du signalement"], 500);
}

$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

if (!$updated) {
    json_response([
        "status" => "error",
        "message" => "Impossible de signaler ce probleme pour cette course"
    ], 409);
}

json_response(["status" => "success", "message" => "Probleme signale au chauffeur"]);
?>
