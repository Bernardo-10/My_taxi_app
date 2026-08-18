<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";

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

require_once __DIR__ . "/../common/pricing.php";
$pickup_lat = (float) ($data["pickup_lat"] ?? 0);
$pickup_lng = (float) ($data["pickup_lng"] ?? 0);
$destination_lat = (float) ($data["destination_lat"] ?? 0);
$destination_lng = (float) ($data["destination_lng"] ?? 0);
$passengers = max(1, min(5, (int) ($data["passengers"] ?? 1))); // borné à la capacité du véhicule

if (!$pickup_lat || !$pickup_lng || !$destination_lat || !$destination_lng) {
    json_response(["status" => "error", "message" => "Coordonnées manquantes"], 400);
}

$route = compute_route($pickup_lat, $pickup_lng, $destination_lat, $destination_lng);
if (!$route) {
    json_response(["status" => "error", "message" => "Itinéraire introuvable, réessayez"], 400);
}

$distance_km  = $route["distance_km"];
$duration_min = $route["duration_min"];
$price_fcfa   = compute_price($distance_km, $passengers);

$conn = db_connect();

// Empêche la création d'une 2e course active pour le même client (double
// onglet, double-clic, refresh mal timé...) : une seule course pending/
// accepted/arrived/started à la fois par user_id.
$checkStmt = $conn->prepare("
    SELECT id, status FROM rides
    WHERE user_id = ?
      AND status IN ('pending', 'accepted', 'arrived', 'started')
    ORDER BY FIELD(status, 'started', 'arrived', 'accepted', 'pending'), created_at DESC
    LIMIT 1
");
$checkStmt->bind_param("i", $user_id);
$checkStmt->execute();
$existing = $checkStmt->get_result()->fetch_assoc();
$checkStmt->close();

if ($existing) {
    $conn->close();
    json_response([
        "status" => "error",
        "message" => "Une course est deja en cours",
        "existing_ride_id" => (int) $existing["id"],
        "existing_ride_status" => $existing["status"]
    ], 409);
}

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

    // FCM — reveille les chauffeurs en ligne meme app fermee/ecran verrouille.
    // Modele covoiturage (voir memoire projet) : pas de filtre sur les
    // chauffeurs deja en course, ils peuvent accepter une course
    // supplementaire — meme WHERE que nearby_drivers.php, sans le filtre
    // de fraicheur de position (pas necessaire pour notifier, juste pour
    // les afficher sur une carte).
    sync_stale_drivers_offline($conn);
    $driversRes = $conn->query("SELECT id FROM chauffeur WHERE is_online = 1 AND status = 'active'");
    $driverIds = [];
    if ($driversRes) {
        while ($row = $driversRes->fetch_assoc()) {
            $driverIds[] = (int) $row["id"];
        }
    }
    if (!empty($driverIds)) {
        send_push_to_users(
            $conn,
            'chauffeur',
            $driverIds,
            'Nouvelle course disponible',
            trim($pickup) !== "" && trim($destination) !== "" ? "$pickup → $destination" : "Une nouvelle course vous attend.",
            ['link' => '/chauffeur/', 'ride_id' => (string) $rideId]
        );
    }

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

