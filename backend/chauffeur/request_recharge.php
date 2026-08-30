<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../config/db.php";
require_once __DIR__ . "/../common/send_push.php";

$driverId = require_driver_id();

$data = json_decode(file_get_contents("php://input"), true);
if (!$data) {
    json_response(["status" => "error", "message" => "Données JSON invalides"], 400);
}

$amount    = isset($data['amount'])    ? (int)$data['amount'] : 0;
$operator  = isset($data['operator'])  ? trim($data['operator']) : '';
$reference = isset($data['reference']) ? trim($data['reference']) : '';

if ($amount <= 0) {
    json_response(["status" => "error", "message" => "Montant invalide (doit être > 0)"], 400);
}
if (empty($operator)) {
    json_response(["status" => "error", "message" => "Opérateur requis"], 400);
}

$conn = db_connect();

// Insérer la demande de recharge (statut 'pending')
$stmt = $conn->prepare("
    INSERT INTO wallet_transactions
        (chauffeur_id, type, amount_fcfa, status, operator, reference, description)
    VALUES (?, 'recharge', ?, 'pending', ?, ?, ?)
");
$description = "Recharge demandée";
$stmt->bind_param("iisss", $driverId, $amount, $operator, $reference, $description);

if ($stmt->execute()) {
    $id = $stmt->insert_id;
    $stmt->close();

    // Alerte admin (son+vibration si l'onglet est ouvert, push si fermé/en
    // arrière-plan — voir chantier notifications admin). Best-effort : ne
    // doit jamais faire échouer la demande de recharge elle-même.
    $nameStmt = $conn->prepare("SELECT name FROM chauffeur WHERE id = ? LIMIT 1");
    $nameStmt->bind_param("i", $driverId);
    $nameStmt->execute();
    $driverName = $nameStmt->get_result()->fetch_assoc()['name'] ?? 'Un chauffeur';
    $nameStmt->close();

    send_push_to_all_admins(
        $conn,
        "Nouvelle recharge en attente",
        "$driverName demande une recharge de $amount FCFA.",
        ["link" => "/admin/#wallets"]
    );

    $conn->close();
    json_response([
        "status" => "success",
        "message" => "Demande de recharge enregistrée",
        "transaction_id" => $id
    ]);
} else {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur lors de l'enregistrement de la demande"], 500);
}
?>