<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();
sync_stale_drivers_offline($conn);
$status = isset($_GET["status"]) ? trim($_GET["status"]) : "";

$where  = [];
$params = [];
$types  = "";

if ($search !== "") {
    $like = "%" . $search . "%";
    $where[]  = "(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.plate LIKE ?)";
    $params[] = $like; $params[] = $like; $params[] = $like; $params[] = $like;
    $types   .= "ssss";
}
if (in_array($status, ["active", "disabled"])) {
    $where[]  = "c.status = ?";
    $params[] = $status;
    $types   .= "s";
}

$sql = "
    SELECT c.id, c.name, c.email, c.phone, c.plate, c.car_brand, c.car_color,
           c.status, c.is_online, c.created_at,
           c.total_accepted_rides, c.total_completed_rides,
           c.total_accepted_amount_fcfa, c.total_completed_distance_km,
           c.driver_lat, c.driver_lng, c.update_position_driver,
           (SELECT COUNT(*) FROM rides r WHERE r.driver_id = c.id AND r.status IN ('accepted','arrived','started')) AS courses_actives
    FROM chauffeur c
";

if ($where) {
    $sql .= " WHERE " . implode(" AND ", $where);
}
$sql .= " ORDER BY c.created_at DESC";

$stmt = $conn->prepare($sql);
if ($params) {
    $stmt->bind_param($types, ...$params);
}
$stmt->execute();
$result = $stmt->get_result();

$chauffeurs = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]                        = (int)$row["id"];
    $row["total_accepted_rides"]      = (int)$row["total_accepted_rides"];
    $row["total_completed_rides"]     = (int)$row["total_completed_rides"];
    $row["total_accepted_amount_fcfa"]= (int)$row["total_accepted_amount_fcfa"];
    $row["courses_actives"]           = (int)$row["courses_actives"];
    $chauffeurs[] = $row;
}

$stmt->close();
$conn->close();
json_response(["status" => "success", "chauffeurs" => $chauffeurs]);
?>
