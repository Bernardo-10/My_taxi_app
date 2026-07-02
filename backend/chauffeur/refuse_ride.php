<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();

// Un refus n'annule plus la course pour tout le monde : il ne
// concerne QUE ce chauffeur. La course reste 'pending' pour les
// autres, on enregistre juste que celui-ci ne veut plus la voir.
$checkStmt = $conn->prepare("SELECT id FROM rides WHERE id = ? AND status = 'pending'");
$checkStmt->bind_param("i", $id);
$checkStmt->execute();
$exists = $checkStmt->get_result()->num_rows > 0;
$checkStmt->close();

if (!$exists) {
    $conn->close();
    json_response(["status" => "error", "message" => "Course indisponible (deja acceptee ou annulee)"], 409);
}

// INSERT IGNORE : si le chauffeur a deja refuse cette course
// (double-tap, retry reseau...), on ne plante pas sur le PK.
$stmt = $conn->prepare("INSERT IGNORE INTO ride_refusals (ride_id, driver_id) VALUES (?, ?)");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$stmt->close();
$conn->close();

json_response(["status" => "ok", "message" => "Course refusee"]);
?>

