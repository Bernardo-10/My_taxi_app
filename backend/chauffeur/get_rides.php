<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$conn = db_connect();

$stmt = $conn->prepare("
    SELECT *
    FROM rides
    WHERE status = 'pending'
       OR (driver_id = ? AND status IN ('accepted', 'completed'))
    ORDER BY created_at DESC
");
$stmt->bind_param("i", $driverId);
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

