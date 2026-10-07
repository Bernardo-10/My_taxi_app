<?php
// Marque comme « traité » un signalement fait par le CHAUFFEUR (lot F4).
// Même principe que resolve_client_problem.php, sur les colonnes
// problem_description / problem_resolved_at.
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/require_admin.php";

require_admin_id();

$data   = json_decode(file_get_contents("php://input"), true);
$rideId = isset($data["ride_id"]) ? (int) $data["ride_id"] : 0;

if (!$rideId) {
    json_response(["status" => "error", "message" => "ID de course manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    UPDATE rides
    SET problem_resolved_at = NOW()
    WHERE id = ?
      AND problem_description IS NOT NULL
      AND problem_resolved_at IS NULL
");

if (!$stmt) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur prepare"], 500);
}

$stmt->bind_param("i", $rideId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

if (!$updated) {
    json_response([
        "status"  => "error",
        "message" => "Signalement introuvable ou déjà traité"
    ], 409);
}

json_response(["status" => "success", "message" => "Signalement marqué comme traité"]);
?>
