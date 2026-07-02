<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/geo.php";

// Rayon de tolérance autour du point de départ pour valider "arrivé".
// Blocage strict : au-delà, la requête est rejetée, pas de confirmation.
const ARRIVE_MAX_DISTANCE_METERS = 500;

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id  = isset($data["id"])  ? (int) $data["id"]  : 0;
$lat = isset($data["lat"]) && is_numeric($data["lat"]) ? (float) $data["lat"] : null;
$lng = isset($data["lng"]) && is_numeric($data["lng"]) ? (float) $data["lng"] : null;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

if ($lat === null || $lng === null) {
    json_response(["status" => "error", "message" => "Position GPS manquante. Activez la localisation pour confirmer l'arrivee."], 400);
}

$conn = db_connect();

// Point de depart de la course (pickup), pour verifier la proximite.
$stmt = $conn->prepare("SELECT pickup_lat, pickup_lng FROM rides WHERE id = ? AND driver_id = ? AND status = 'accepted'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$ride = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$ride) {
    $conn->close();
    json_response(["status" => "error", "message" => "Impossible de marquer la course comme arrivee"]);
}

// Si le point de depart n'a pas de coordonnees enregistrees (cas rare,
// donnee manquante), on ne peut pas verifier la proximite : on ne bloque
// pas le chauffeur sur une donnee absente cote serveur.
if ($ride["pickup_lat"] !== null && $ride["pickup_lng"] !== null) {
    $distance = haversine_distance_meters(
        (float) $ride["pickup_lat"],
        (float) $ride["pickup_lng"],
        $lat,
        $lng
    );

    if ($distance > ARRIVE_MAX_DISTANCE_METERS) {
        $conn->close();
        json_response([
            "status"   => "error",
            "message"  => "Vous etes a " . round($distance) . " m du point de depart. Rapprochez-vous a moins de " . ARRIVE_MAX_DISTANCE_METERS . " m pour confirmer l'arrivee.",
            "distance" => round($distance)
        ]);
    }
}

$stmt = $conn->prepare("UPDATE rides SET status = 'arrived', arrived_at = NOW() WHERE id = ? AND driver_id = ? AND status = 'accepted'");
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