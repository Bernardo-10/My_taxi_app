<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../config/db.php";

$driverId = require_driver_id();

// Paramètres de pagination
$limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 50;
$page  = isset($_GET['page'])  ? (int)$_GET['page']  : 1;
if ($limit < 1) $limit = 50;
if ($page < 1)  $page  = 1;
$offset = ($page - 1) * $limit;

$conn = db_connect();

// Solde actuel
$balStmt = $conn->prepare("SELECT wallet_balance_fcfa FROM chauffeur WHERE id = ?");
$balStmt->bind_param("i", $driverId);
$balStmt->execute();
$balRes = $balStmt->get_result();
$balance = $balRes->fetch_assoc()['wallet_balance_fcfa'] ?? 0;
$balStmt->close();

// Total des transactions pour pagination
$countStmt = $conn->prepare("SELECT COUNT(*) as total FROM wallet_transactions WHERE chauffeur_id = ?");
$countStmt->bind_param("i", $driverId);
$countStmt->execute();
$countRes = $countStmt->get_result();
$total = $countRes->fetch_assoc()['total'] ?? 0;
$countStmt->close();

// Historique paginé
$txStmt = $conn->prepare("
    SELECT id, type, amount_fcfa, ride_id, status, operator, reference, description, created_at, validated_at
    FROM wallet_transactions
    WHERE chauffeur_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
");
$txStmt->bind_param("iii", $driverId, $limit, $offset);
$txStmt->execute();
$txRes = $txStmt->get_result();
$transactions = [];
while ($row = $txRes->fetch_assoc()) {
    $transactions[] = $row;
}
$txStmt->close();
$conn->close();

json_response([
    'status' => 'success',
    'balance' => (int)$balance,
    'transactions' => $transactions,
    'pagination' => [
        'page' => $page,
        'limit' => $limit,
        'total' => (int)$total,
        'total_pages' => ceil($total / $limit)
    ]
]);
?>