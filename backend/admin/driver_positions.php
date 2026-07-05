<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();
sync_stale_drivers_offline($conn);
$stmt = $conn->prepare("
    SELECT c.id, c.name, c.plate, c.car_brand, c.car_color, c.phone,
           c.status, c.is_online,
           c.driver_lat, c.driver_lng, c.update_position_driver,
           (
               SELECT COUNT(*)
               FROM rides r
               WHERE r.driver_id = c.id
                 AND r.status IN ('accepted','arrived','started')
           ) AS course_active
    FROM chauffeur c
    WHERE c.is_online = 1
      AND c.driver_lat IS NOT NULL
      AND c.driver_lng IS NOT NULL
      AND c.update_position_driver >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
    ORDER BY c.update_position_driver DESC
");
$stmt->execute();
$result = $stmt->get_result();

$drivers = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]           = (int)$row["id"];
    $row["course_active"]= (int)$row["course_active"];
    $row["driver_lat"]   = (float)$row["driver_lat"];
    $row["driver_lng"]   = (float)$row["driver_lng"];
    $drivers[] = $row;
}
$stmt->close();
$conn->close();

json_response(["status" => "success", "drivers" => $drivers]);
?>
