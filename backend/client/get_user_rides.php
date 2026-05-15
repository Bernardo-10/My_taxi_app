<?php
require_once __DIR__ . "/../config/auth.php";

$userId = require_client_id();
$conn = db_connect();

$stmt = $conn->prepare("
    SELECT *
    FROM rides
    WHERE user_id = ?
      AND status IN ('pending', 'accepted', 'completed', 'cancelled', 'cancelled_client', 'started')
    ORDER BY created_at DESC
");
$stmt->bind_param("i", $userId);
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
