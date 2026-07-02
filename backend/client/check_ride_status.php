<?php
require_once __DIR__ . "/../config/auth.php";

$userId = require_client_id();
$rideId = isset($_GET["ride_id"]) ? (int) $_GET["ride_id"] : 0;

if (!$rideId) {
    json_response(["status" => "error", "message" => "ID de course manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    SELECT r.status, r.driver_name, r.driver_plate, r.driver_id, r.driver_lat, r.driver_lng,
           r.pickup_lat, r.pickup_lng, r.destination_lat, r.destination_lng,
           c.phone AS driver_phone, c.car_color AS driver_color
    FROM rides r
    LEFT JOIN chauffeur c ON c.id = r.driver_id
    WHERE r.id = ? AND r.user_id = ?
");
$stmt->bind_param("ii", $rideId, $userId);
$stmt->execute();
$result = $stmt->get_result();

if ($result->num_rows > 0) {
    $ride = $result->fetch_assoc();
    $stmt->close();
    $conn->close();

    json_response([
        "status" => "success",
        "ride_status" => $ride["status"],
        "driver_name" => $ride["driver_name"],
        "driver_plate" => $ride["driver_plate"],
        "driver_id" => $ride["driver_id"],
        "driver_lat" => $ride["driver_lat"],
        "driver_lng" => $ride["driver_lng"],
        "driver_phone" => $ride["driver_phone"],
        "driver_color" => $ride["driver_color"],
        "pickup_lat" => $ride["pickup_lat"],
        "pickup_lng" => $ride["pickup_lng"],
        "destination_lat" => $ride["destination_lat"],
        "destination_lng" => $ride["destination_lng"]
    ]);
}

$stmt->close();
$conn->close();
json_response(["status" => "error", "message" => "Course non trouvee"], 404);
?>
