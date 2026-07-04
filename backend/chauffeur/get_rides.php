<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$conn = db_connect();

$stmt = $conn->prepare("
    SELECT
        id, user_id, pickup, destination,
        pickup_lat, pickup_lng, destination_lat, destination_lng,
        distance_km, duration_min, price_fcfa, passengers, status,
        driver_id, driver_name, driver_plate, driver_lat, driver_lng,
        update_position_driver, created_at, updated_at,
        accepted_at, arrived_at, started_at, completed_at, cancelled_at,
        problem_description
    FROM rides
    WHERE (status = 'pending' AND id NOT IN (
              SELECT ride_id FROM ride_refusals WHERE driver_id = ?
          ))
       OR (driver_id = ? AND status IN ('accepted', 'arrived', 'started', 'completed'))
       OR (driver_id = ? AND status = 'cancelled_client' AND cancelled_at >= NOW() - INTERVAL 1 DAY)
    ORDER BY created_at DESC
");
$stmt->bind_param("iii", $driverId, $driverId, $driverId);
$stmt->execute();
$result = $stmt->get_result();

$rides = [];
while ($row = $result->fetch_assoc()) {
    $rides[] = $row;
}

$stmt->close();
$conn->close();

json_response($rides);
?>
