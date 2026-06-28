<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();

$status    = isset($_GET["status"])    ? trim($_GET["status"])    : "";
$search    = isset($_GET["q"])         ? trim($_GET["q"])         : "";
$date_from = isset($_GET["date_from"]) ? trim($_GET["date_from"]) : "";
$date_to   = isset($_GET["date_to"])   ? trim($_GET["date_to"])   : "";
$limit     = isset($_GET["limit"])     ? (int)$_GET["limit"]      : 100;
$offset    = isset($_GET["offset"])    ? (int)$_GET["offset"]     : 0;

$valid_statuses = ["pending","accepted","arrived","started","completed","cancelled","cancelled_client","reported"];

$where  = [];
$params = [];
$types  = "";

if (in_array($status, $valid_statuses)) {
    $where[]  = "r.status = ?";
    $params[] = $status;
    $types   .= "s";
}
if ($search !== "") {
    $like = "%" . $search . "%";
    $where[]  = "(c.full_name LIKE ? OR ch.name LIKE ? OR r.pickup LIKE ? OR r.destination LIKE ?)";
    $params[] = $like; $params[] = $like; $params[] = $like; $params[] = $like;
    $types   .= "ssss";
}
if ($date_from !== "") {
    $where[]  = "r.created_at >= ?";
    $params[] = $date_from . " 00:00:00";
    $types   .= "s";
}
if ($date_to !== "") {
    $where[]  = "r.created_at <= ?";
    $params[] = $date_to . " 23:59:59";
    $types   .= "s";
}

$sql = "
    SELECT r.id, r.status, r.pickup, r.destination,
           r.distance_km, r.duration_min, r.price_fcfa, r.passengers,
           r.created_at, r.updated_at,
           r.pickup_lat, r.pickup_lng, r.destination_lat, r.destination_lng,
           r.driver_lat, r.driver_lng,
           r.driver_name, r.driver_plate,
           c.full_name AS client_name, c.phone AS client_phone,
           ch.phone AS driver_phone,
           r.problem_description, r.client_problem_description
    FROM rides r
    LEFT JOIN client c ON c.id = r.user_id
    LEFT JOIN chauffeur ch ON ch.id = r.driver_id
";
if ($where) {
    $sql .= " WHERE " . implode(" AND ", $where);
}
$sql .= " ORDER BY r.created_at DESC LIMIT ? OFFSET ?";
$params[] = $limit;
$params[] = $offset;
$types   .= "ii";

$stmt = $conn->prepare($sql);
$stmt->bind_param($types, ...$params);
$stmt->execute();
$result = $stmt->get_result();

$rides = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]           = (int)$row["id"];
    $row["price_fcfa"]   = (int)$row["price_fcfa"];
    $row["passengers"]   = (int)$row["passengers"];
    $rides[] = $row;
}
$stmt->close();
$conn->close();
json_response(["status" => "success", "rides" => $rides]);
?>
