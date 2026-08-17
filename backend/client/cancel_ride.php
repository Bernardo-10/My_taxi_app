<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";

$userId = require_client_id();

$data = json_decode(file_get_contents("php://input"), true);
$rideId = isset($data["ride_id"]) ? (int)$data["ride_id"] : 0;

if (!$rideId) {
    json_response(["status" => "error", "message" => "ID de course manquant"], 400);
}

$conn = db_connect();

// driver_id récupéré avant la mise à jour pour pouvoir notifier le chauffeur
// une fois l'annulation confirmée — null si la course était encore 'pending'
// (aucun chauffeur assigné, rien à notifier côté chauffeur dans ce cas).
$rideStmt = $conn->prepare("SELECT driver_id, pickup FROM rides WHERE id = ? AND user_id = ?");
$rideStmt->bind_param("ii", $rideId, $userId);
$rideStmt->execute();
$rideRow = $rideStmt->get_result()->fetch_assoc();
$rideStmt->close();

// On annule seulement si la course appartient au client et n'est pas déjà finie/annulée
$stmt = $conn->prepare("
    UPDATE rides
    SET status = 'cancelled_client', cancelled_at = NOW()
    WHERE id = ?
      AND user_id = ?
      AND status IN ('pending', 'accepted', 'arrived', 'started')
");
$stmt->bind_param("ii", $rideId, $userId);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur lors de l'annulation"], 500);
}

$updated = $stmt->affected_rows > 0;
$stmt->close();

if ($updated && !empty($rideRow["driver_id"])) {
    $pickup = $rideRow["pickup"] ?? "";
    send_push_to_user(
        $conn,
        'chauffeur',
        (int) $rideRow["driver_id"],
        'Course annulée',
        trim($pickup) !== "" ? "Le client a annulé la course à $pickup." : "Le client a annulé la course.",
        ['link' => '/chauffeur/', 'ride_id' => (string) $rideId]
    );
}

$conn->close();

if (!$updated) {
    json_response([
        "status" => "error",
        "message" => "Impossible d'annuler (course inexistante ou déjà acceptée/terminée/annulée)"
    ], 409);
}

json_response(["status" => "success", "message" => "Course annulée par le client"]);
?>
