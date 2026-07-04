<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/require_admin.php";

require_admin_id();
$conn = db_connect();

$result = $conn->query("
    SELECT
        r.id, r.status, r.pickup, r.destination,
        r.price_fcfa, r.created_at, r.updated_at,
        r.problem_description,
        r.client_problem_description,
        r.client_problem_at,
        r.client_problem_resolved_at,
        c.full_name  AS client_name,  c.phone AS client_phone,
        r.driver_name, r.driver_plate,
        ch.phone AS driver_phone
    FROM rides r
    LEFT JOIN client    c  ON c.id  = r.user_id
    LEFT JOIN chauffeur ch ON ch.id = r.driver_id
    WHERE r.problem_description IS NOT NULL
       OR r.client_problem_description IS NOT NULL
    ORDER BY r.updated_at DESC
    LIMIT 200
");

$problems = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]         = (int) $row["id"];
    $row["price_fcfa"] = (int) $row["price_fcfa"];
    $problems[] = $row;
}
$conn->close();

json_response(["status" => "success", "problems" => $problems]);
?>
