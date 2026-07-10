<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$data = json_decode(file_get_contents("php://input"), true);
if (!$data || !isset($data['transaction_id']) || !isset($data['action'])) {
    json_response(["status" => "error", "message" => "Données manquantes"], 400);
}

$txId = (int)$data['transaction_id'];
$action = $data['action']; // 'approve' ou 'reject'

if (!in_array($action, ['approve', 'reject'])) {
    json_response(["status" => "error", "message" => "Action invalide"], 400);
}

$conn = db_connect();

// Récupérer la transaction
$stmt = $conn->prepare("SELECT chauffeur_id, amount_fcfa, type, status FROM wallet_transactions WHERE id = ?");
$stmt->bind_param("i", $txId);
$stmt->execute();
$result = $stmt->get_result();
$tx = $result->fetch_assoc();
$stmt->close();

if (!$tx) {
    $conn->close();
    json_response(["status" => "error", "message" => "Transaction introuvable"], 404);
}

if ($tx['type'] !== 'recharge' || $tx['status'] !== 'pending') {
    $conn->close();
    json_response(["status" => "error", "message" => "Cette transaction ne peut pas être traitée"], 400);
}

$chauffeurId = (int)$tx['chauffeur_id'];
$amount = (int)$tx['amount_fcfa'];
$newStatus = ($action === 'approve') ? 'completed' : 'rejected';

// Démarrer une transaction SQL
$conn->begin_transaction();

try {
    if ($action === 'approve') {
        // Créditer le solde du chauffeur
        $stmt = $conn->prepare("UPDATE chauffeur SET wallet_balance_fcfa = wallet_balance_fcfa + ? WHERE id = ?");
        $stmt->bind_param("ii", $amount, $chauffeurId);
        $stmt->execute();
        $stmt->close();
    }

    // Mettre à jour le statut de la transaction
    $stmt = $conn->prepare("UPDATE wallet_transactions SET status = ?, validated_at = NOW() WHERE id = ?");
    $stmt->bind_param("si", $newStatus, $txId);
    $stmt->execute();
    $stmt->close();

    $conn->commit();
    $conn->close();

    json_response([
        "status" => "success",
        "message" => "Recharge " . ($action === 'approve' ? 'validée' : 'rejetée') . " avec succès."
    ]);

} catch (Exception $e) {
    $conn->rollback();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur lors du traitement : " . $e->getMessage()], 500);
}