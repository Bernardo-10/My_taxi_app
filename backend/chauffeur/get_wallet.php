<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../config/db.php";

$driverId = require_driver_id();

// Paramètres de pagination
$limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 50;
$page  = isset($_GET['page'])  ? (int)$_GET['page']  : 1;
if ($limit < 1) $limit = 50;
if ($limit > 50) $limit = 50;      // Lot 8 : plafond (avant, ?limit=999999 renvoyait tout l'historique)
if ($page < 1)  $page  = 1;
if ($page > 10000) $page = 10000;
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
// Lot 8 : demandes de recharge en attente (le chauffeur voit où en est sa demande)
$pendStmt = $conn->prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_fcfa), 0) AS total
                            FROM wallet_transactions
                            WHERE chauffeur_id = ? AND type = 'recharge' AND status = 'pending'");
$pendStmt->bind_param("i", $driverId);
$pendStmt->execute();
$pend = $pendStmt->get_result()->fetch_assoc();
$pendStmt->close();
$conn->close();

// Lot 8 : règles et instructions de recharge (config/payment.php = source unique,
// la même que celle qui fait respecter les règles dans request_recharge.php)
$cfg = require __DIR__ . "/../config/payment.php";
$operators = [];
foreach ($cfg["operators"] as $name => $info) {
    $operators[] = ["name" => $name, "number" => $info["number"], "holder" => $info["holder"]];
}

json_response([
    'status' => 'success',
    'balance' => (int)$balance,
    'min_balance' => WALLET_MIN_BALANCE_FCFA,
    'pending_recharges' => ['count' => (int)$pend['n'], 'amount_fcfa' => (int)$pend['total']],
    'recharge' => [
        'presets'     => $cfg['presets'],
        'min'         => $cfg['min_amount_fcfa'],
        'max'         => $cfg['max_amount_fcfa'],
        'max_pending' => $cfg['max_pending'],
        'ref_min'     => $cfg['reference_min'],
        'ref_max'     => $cfg['reference_max'],
        'operators'   => $operators,
    ],
    'transactions' => $transactions,
    'pagination' => [
        'page' => $page,
        'limit' => $limit,
        'total' => (int)$total,
        'total_pages' => ceil($total / $limit)
    ]
]);
?>