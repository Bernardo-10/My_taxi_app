<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();

$search = isset($_GET["q"]) ? trim($_GET["q"]) : "";
$status = isset($_GET["status"]) ? trim($_GET["status"]) : "";

$where  = [];
$params = [];
$types  = "";

if ($search !== "") {
    $like = "%" . $search . "%";
    $where[]  = "(c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)";
    $params[] = $like; $params[] = $like; $params[] = $like;
    $types   .= "sss";
}
if (in_array($status, ["active", "disabled"])) {
    $where[]  = "c.status = ?";
    $params[] = $status;
    $types   .= "s";
}

$sql = "
    SELECT c.id, c.full_name, c.email, c.phone, c.status, c.created_at,
           COUNT(r.id) AS nb_courses,
           IFNULL(SUM(r.price_fcfa), 0) AS total_depense_fcfa
    FROM client c
    LEFT JOIN rides r ON r.user_id = c.id AND r.status = 'completed'
";
if ($where) {
    $sql .= " WHERE " . implode(" AND ", $where);
}
$sql .= " GROUP BY c.id ORDER BY c.created_at DESC";

$stmt = $conn->prepare($sql);
if ($params) {
    $stmt->bind_param($types, ...$params);
}
$stmt->execute();
$result = $stmt->get_result();

$clients = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]                 = (int)$row["id"];
    $row["nb_courses"]         = (int)$row["nb_courses"];
    $row["total_depense_fcfa"] = (int)$row["total_depense_fcfa"];
    $clients[] = $row;
}
$stmt->close();
$conn->close();
json_response(["status" => "success", "clients" => $clients]);
?>
