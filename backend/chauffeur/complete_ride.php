<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/geo.php";

// Distance à partir de laquelle une confirmation est demandée avant de
// terminer la course. Ce n'est PAS un blocage (contrairement à arrive_ride.php,
// 500m strict) : le chauffeur peut confirmer malgré l'alerte — cas légitime
// où le client descend avant la destination prévue.
//
// Valeur mise à 2000 m (2 km) au lieu des 200 m prévus au départ, pour
// garder l'application facilement testable (GPS de test peu précis,
// trajets de démo courts). À resserrer à 200 m avant mise en production réelle.
const COMPLETE_CONFIRM_DISTANCE_METERS = 200;

$driverId = require_driver_id();
$data  = json_decode(file_get_contents("php://input"), true);
$id    = isset($data["id"]) ? (int) $data["id"] : 0;
$lat   = isset($data["lat"]) && is_numeric($data["lat"]) ? (float) $data["lat"] : null;
$lng   = isset($data["lng"]) && is_numeric($data["lng"]) ? (float) $data["lng"] : null;
$force = !empty($data["force"]);

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();

$stmt = $conn->prepare("SELECT destination_lat, destination_lng FROM rides WHERE id = ? AND driver_id = ? AND status = 'started'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$ride = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$ride) {
    $conn->close();
    json_response(["status" => "error", "message" => "Impossible de terminer (course non démarrée)"]);
}

// Vérification de proximité — uniquement si on a le GPS chauffeur ET les
// coordonnées de destination, et que le chauffeur n'a pas déjà confirmé
// (force=true). Donnée absente ou GPS indisponible : on ne bloque jamais,
// on complète directement (à la différence du blocage strict d'arrive_ride.php,
// ici on ne fait qu'avertir).
if (!$force && $lat !== null && $lng !== null
    && $ride["destination_lat"] !== null && $ride["destination_lng"] !== null) {

    $distance = haversine_distance_meters(
        (float) $ride["destination_lat"],
        (float) $ride["destination_lng"],
        $lat,
        $lng
    );

    if ($distance > COMPLETE_CONFIRM_DISTANCE_METERS) {
        $conn->close();
        json_response([
            "status"   => "needs_confirmation",
            "message"  => "Vous etes a " . round($distance) . " m de la destination prevue.",
            "distance" => round($distance)
        ]);
    }
}

$stmt = $conn->prepare("UPDATE rides SET status = 'completed', completed_at = NOW() WHERE id = ? AND driver_id = ? AND status = 'started'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();

if ($updated) {
    // Remplacement du TRIGGER : mise à jour des stats chauffeur
    $rideStmt = $conn->prepare("SELECT distance_km FROM rides WHERE id = ?");
    $rideStmt->bind_param("i", $id);
    $rideStmt->execute();
    $rideRow = $rideStmt->get_result()->fetch_assoc();
    $rideStmt->close();

    $distanceKm = $rideRow["distance_km"] ?? 0;

    $statStmt = $conn->prepare("
        UPDATE chauffeur
        SET total_completed_distance_km = total_completed_distance_km + ?,
            total_completed_rides = total_completed_rides + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    ");
    $statStmt->bind_param("di", $distanceKm, $driverId);
    $statStmt->execute();
    $statStmt->close();
    $conn->close();

    json_response(["status" => "success", "message" => "Course terminée"]);
}

$conn->close();
json_response(["status" => "error", "message" => "Impossible de terminer (course non démarrée)"]);
?>