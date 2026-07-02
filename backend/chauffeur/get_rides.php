<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$conn = db_connect();

$stmt = $conn->prepare("
    SELECT *
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
