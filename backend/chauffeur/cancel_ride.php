<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();

// user_id récupéré avant la mise à jour pour pouvoir notifier le client
// une fois l'annulation confirmée.
$rideStmt = $conn->prepare("SELECT user_id FROM rides WHERE id = ? AND driver_id = ?");
$rideStmt->bind_param("ii", $id, $driverId);
$rideStmt->execute();
$rideRow = $rideStmt->get_result()->fetch_assoc();
$rideStmt->close();

$stmt = $conn->prepare("UPDATE rides SET status = 'cancelled', cancelled_at = NOW() WHERE id = ? AND driver_id = ? AND status IN ('accepted', 'arrived')");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();

if ($updated && !empty($rideRow["user_id"])) {
    send_push_to_user(
        $conn,
        'client',
        (int) $rideRow["user_id"],
        'Course annulée',
        'La course a été annulée par le chauffeur.',
        ['link' => '/client/', 'ride_id' => (string) $id]
    );
}

$conn->close();

json_response(["status" => $updated ? "success" : "error", "message" => $updated ? "Course annulée" : "Impossible d'annuler (course non acceptée, non arrivée ou déjà démarrée)"]);
?>
