<?php
require_once __DIR__ . "/../config/auth.php";

$userId = require_client_id();

$conn = db_connect();

// En théorie une seule course active par client (voir le garde-fou ajouté
// dans backend.php), mais en défense en profondeur pour les lignes créées
// avant ce correctif : si plusieurs existent, on privilégie la plus avancée
// (started > arrived > accepted > pending) et non la plus récente, pour ne
// jamais masquer une course où un chauffeur est déjà engagé/en route.
$stmt = $conn->prepare("
    SELECT r.id, r.status, r.pickup, r.destination,
           r.pickup_lat, r.pickup_lng, r.destination_lat, r.destination_lng,
           r.distance_km, r.duration_min, r.price_fcfa, r.passengers,
           r.driver_name, r.driver_plate, r.driver_id, r.driver_lat, r.driver_lng,
           c.phone AS driver_phone, c.car_color AS driver_color
    FROM rides r
    LEFT JOIN chauffeur c ON c.id = r.driver_id
    WHERE r.user_id = ?
      AND r.status IN ('pending', 'accepted', 'arrived', 'started')
    ORDER BY FIELD(r.status, 'started', 'arrived', 'accepted', 'pending'), r.created_at DESC
    LIMIT 1
");
$stmt->bind_param("i", $userId);
$stmt->execute();
$result = $stmt->get_result();

if ($result->num_rows === 0) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "success", "has_active_ride" => false]);
}

$ride = $result->fetch_assoc();
$stmt->close();
$conn->close();

json_response([
    "status" => "success",
    "has_active_ride" => true,
    "ride_id" => (int) $ride["id"],
    "ride_status" => $ride["status"],
    "pickup" => $ride["pickup"],
    "destination" => $ride["destination"],
    "pickup_lat" => $ride["pickup_lat"],
    "pickup_lng" => $ride["pickup_lng"],
    "destination_lat" => $ride["destination_lat"],
    "destination_lng" => $ride["destination_lng"],
    "distance_km" => $ride["distance_km"],
    "duration_min" => $ride["duration_min"],
    "price_fcfa" => $ride["price_fcfa"],
    "passengers" => $ride["passengers"],
    "driver_name" => $ride["driver_name"],
    "driver_plate" => $ride["driver_plate"],
    "driver_id" => $ride["driver_id"],
    "driver_lat" => $ride["driver_lat"],
    "driver_lng" => $ride["driver_lng"],
    "driver_phone" => $ride["driver_phone"],
    "driver_color" => $ride["driver_color"]
]);
?>
