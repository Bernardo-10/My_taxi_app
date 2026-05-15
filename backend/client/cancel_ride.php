<?php
require_once __DIR__ . "/../config/auth.php";

$userId = require_client_id();

$data = json_decode(file_get_contents("php://input"), true);
$rideId = isset($data["ride_id"]) ? (int)$data["ride_id"] : 0;

if (!$rideId) {
    json_response(["status" => "error", "message" => "ID de course manquant"], 400);
}

$conn = db_connect();

// On annule seulement si la course appartient au client et n'est pas déjà finie/annulée
$stmt = $conn->prepare("
    UPDATE rides
    SET status = 'cancelled_client'
    WHERE id = ?
      AND user_id = ?
      AND status IN ('pending', 'accepted', 'started')
");
$stmt->bind_param("ii", $rideId, $userId);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur lors de l'annulation"], 500);
}

$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

if (!$updated) {
    json_response([
        "status" => "error",
        "message" => "Impossible d'annuler (course inexistante ou déjà acceptée/terminée/annulée)"
    ], 409);
}

json_response(["status" => "success", "message" => "Course annulée par le client"]);
?>
