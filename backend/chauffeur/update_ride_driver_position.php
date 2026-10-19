<?php
require_once __DIR__ . "/../config/auth.php";

error_reporting(E_ALL);
ini_set("display_errors", 0);

$driverId = require_driver_id();
// Lot 5 : le front envoie maintenant la position en POST. Le GET reste accepté
// pendant la transition (ancien JS encore en cache chez certains chauffeurs) :
// à retirer plus tard, quand tous les chauffeurs ont rechargé l'application.
$lat = $_POST["lat"] ?? $_GET["lat"] ?? null;
$lng = $_POST["lng"] ?? $_GET["lng"] ?? null;

if ($lat === null || $lng === null) {
    json_response(["status" => "error", "message" => "Coordonnees manquantes"], 400);
}

// Une valeur non numérique ou hors bornes devenait silencieusement 0,0.
if (!is_numeric($lat) || !is_numeric($lng)) {
    json_response(["status" => "error", "message" => "Coordonnees invalides"], 400);
}

$lat = (float) $lat;
$lng = (float) $lng;

if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
    json_response(["status" => "error", "message" => "Coordonnees hors limites"], 400);
}

$conn = db_connect();

// Plus de SHOW COLUMNS / ALTER TABLE à chaque ping : les colonnes driver_lat,
// driver_lng et update_position_driver existent dans le schéma (chauffeur et
// rides). Ces 3 requêtes de vérification s'exécutaient toutes les 10 s.

// UNE requête met à jour toutes les courses actives du chauffeur : le front
// n'envoie plus un ping par course. Le paramètre ride_id, s'il est encore
// envoyé par un ancien client (cache / service worker), est simplement ignoré.
$stmt = $conn->prepare("
    UPDATE rides
    SET driver_lat = ?, driver_lng = ?, update_position_driver = NOW()
    WHERE driver_id = ? AND status IN ('accepted', 'arrived', 'started')
");

if (!$stmt) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur prepare"], 500);
}

$stmt->bind_param("ddi", $lat, $lng, $driverId);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur execute"], 500);
}

$ridesUpdated = $stmt->affected_rows;
$stmt->close();

$driverPosStmt = $conn->prepare("
    UPDATE chauffeur
    SET driver_lat = ?, driver_lng = ?, update_position_driver = NOW()
    WHERE id = ?
");
$driverPosStmt->bind_param("ddi", $lat, $lng, $driverId);
$driverPosStmt->execute();
$driverPosStmt->close();
$conn->close();

json_response([
    "status" => "success",
    "message" => "Position mise a jour",
    "lat" => $lat,
    "lng" => $lng,
    "ride_updated" => $ridesUpdated > 0,
    "rides_updated" => $ridesUpdated
]);
?>
