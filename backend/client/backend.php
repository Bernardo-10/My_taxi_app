<?php
require_once __DIR__ . "/../config/auth.php";

$data = json_decode(file_get_contents("php://input"), true);

if (!$data) {
    json_response(["status" => "error", "message" => "Aucune donnee recue"], 400);
}

$user_id = require_client_id();

$pickup = $data["pickup"] ?? "";
$destination = $data["destination"] ?? "";
$pickup_lat = $data["pickup_lat"] ?? null;
$pickup_lng = $data["pickup_lng"] ?? null;
$destination_lat = $data["destination_lat"] ?? null;
$destination_lng = $data["destination_lng"] ?? null;
$distance_km = $data["distance_km"] ?? 0;
$duration_min = $data["duration_min"] ?? 0;
$price_fcfa = $data["price_fcfa"] ?? 0;
$passengers = $data["passengers"] ?? 1;

$conn = db_connect();

$stmt = $conn->prepare("
    INSERT INTO rides (
        user_id,
        pickup,
        destination,
        pickup_lat,
        pickup_lng,
        destination_lat,
        destination_lng,
        distance_km,
        duration_min,
        price_fcfa,
        passengers
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
");

$stmt->bind_param(
    "issddddiiii",
    $user_id,
    $pickup,
    $destination,
    $pickup_lat,
    $pickup_lng,
    $destination_lat,
    $destination_lng,
    $distance_km,
    $duration_min,
    $price_fcfa,
    $passengers
);

if ($stmt->execute()) {
    $rideId = $conn->insert_id;
    $stmt->close();
    $conn->close();

    json_response([
        "status" => "success",
        "message" => "Trajet sauvegarde",
        "ride_id" => $rideId
    ]);
}

$stmt->close();
$conn->close();
json_response(["status" => "error", "message" => "Erreur lors de l'insertion"], 500);
?>

