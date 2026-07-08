<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$conn = db_connect();

// Filtres optionnels
$chauffeurId = isset($_GET["chauffeur_id"]) ? (int) $_GET["chauffeur_id"] : 0;
$type        = isset($_GET["type"])   ? trim($_GET["type"])   : "";
$status      = isset($_GET["status"]) ? trim($_GET["status"]) : "";

// Pagination
$limit = isset($_GET["limit"]) ? (int) $_GET["limit"] : 50;
$page  = isset($_GET["page"])  ? (int) $_GET["page"]  : 1;
if ($limit < 1) $limit = 50;
if ($page < 1)  $page  = 1;
$offset = ($page - 1) * $limit;

$where  = [];
$params = [];
$types  = "";

if ($chauffeurId > 0) {
    $where[]  = "wt.chauffeur_id = ?";
    $params[] = $chauffeurId;
    $types   .= "i";
}
if (in_array($type, ["commission", "recharge", "ajustement"])) {
    $where[]  = "wt.type = ?";
    $params[] = $type;
    $types   .= "s";
}
if (in_array($status, ["pending", "completed", "rejected"])) {
    $where[]  = "wt.status = ?";
    $params[] = $status;
    $types   .= "s";
}

$whereSql = $where ? ("WHERE " . implode(" AND ", $where)) : "";

// Total pour la pagination
$countSql  = "SELECT COUNT(*) AS total FROM wallet_transactions wt $whereSql";
$countStmt = $conn->prepare($countSql);
if ($params) {
    $countStmt->bind_param($types, ...$params);
}
$countStmt->execute();
$total = (int) $countStmt->get_result()->fetch_assoc()["total"];
$countStmt->close();

// Historique paginé, avec le nom du chauffeur pour affichage direct
$sql = "
    SELECT wt.id, wt.chauffeur_id, c.name AS chauffeur_name, wt.type, wt.amount_fcfa,
           wt.ride_id, wt.status, wt.operator, wt.reference, wt.description,
           wt.created_at, wt.validated_at
    FROM wallet_transactions wt
    JOIN chauffeur c ON c.id = wt.chauffeur_id
    $whereSql
    ORDER BY wt.created_at DESC
    LIMIT ? OFFSET ?
";
$stmt = $conn->prepare($sql);
$allParams   = $params;
$allTypes    = $types . "ii";
$allParams[] = $limit;
$allParams[] = $offset;
$stmt->bind_param($allTypes, ...$allParams);
$stmt->execute();
$result = $stmt->get_result();

$transactions = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]           = (int) $row["id"];
    $row["chauffeur_id"] = (int) $row["chauffeur_id"];
    $row["amount_fcfa"]  = (int) $row["amount_fcfa"];
    $row["ride_id"]      = $row["ride_id"] !== null ? (int) $row["ride_id"] : null;
    $transactions[] = $row;
}
$stmt->close();
$conn->close();

json_response([
    "status" => "success",
    "transactions" => $transactions,
    "pagination" => [
        "page"        => $page,
        "limit"       => $limit,
        "total"       => $total,
        "total_pages" => (int) ceil($total / $limit)
    ]
]);
?>
