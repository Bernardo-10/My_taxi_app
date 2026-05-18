<?php
require_once __DIR__ . "/../config/auth.php";

$userId = require_client_id();
$rideId = isset($_GET["ride_id"]) ? (int) $_GET["ride_id"] : 0;

if (!$rideId) {
    json_response(["status" => "error", "message" => "ID de course manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("
    SELECT status, driver_name, driver_plate, driver_id, driver_lat, driver_lng
    FROM rides
    WHERE id = ? AND user_id = ?
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
        "driver_lng" => $ride["driver_lng"]
    ]);
}

$stmt->close();
$conn->close();
json_response(["status" => "error", "message" => "Course non trouvee"], 404);
?>

