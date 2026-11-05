<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";   // Lot 8 : notifier le chauffeur
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

// Lot 8 : motif de refus facultatif (affiché au chauffeur dans son historique).
// Si l'écran admin n'en envoie pas, un texte par défaut est utilisé.
$reason = isset($data['reason']) && is_string($data['reason']) ? trim($data['reason']) : '';
$reason = mb_substr(preg_replace('/\s+/u', ' ', $reason), 0, 120);
$description = ($action === 'approve')
    ? "Recharge validée"
    : ("Recharge refusée" . ($reason !== '' ? " : " . $reason : " (référence non retrouvée ou montant différent)"));

// Démarrer une transaction SQL
$conn->begin_transaction();

try {
    // Lot 8 (sécurité) : on "réserve" la demande d'abord, avec la condition status='pending'
    // DANS la requête. Avant, le statut était lu plus haut puis mis à jour sans condition :
    // deux clics (ou deux admins) simultanés créditaient le solde deux fois.
    $stmt = $conn->prepare("UPDATE wallet_transactions
                            SET status = ?, validated_at = NOW(), description = ?
                            WHERE id = ? AND type = 'recharge' AND status = 'pending'");
    $stmt->bind_param("ssi", $newStatus, $description, $txId);
    $stmt->execute();
    $claimed = $stmt->affected_rows;
    $stmt->close();

    if ($claimed !== 1) {      // quelqu'un l'a déjà traitée entre-temps
        $conn->rollback();
        $conn->close();
        json_response(["status" => "error", "message" => "Cette recharge a déjà été traitée"], 409);
    }

    if ($action === 'approve') {
        // Créditer le solde du chauffeur (même transaction : tout ou rien)
        $stmt = $conn->prepare("UPDATE chauffeur SET wallet_balance_fcfa = wallet_balance_fcfa + ? WHERE id = ?");
        $stmt->bind_param("ii", $amount, $chauffeurId);
        $stmt->execute();
        $stmt->close();
    }

    $conn->commit();
} catch (Throwable $e) {
    $conn->rollback();
    $conn->close();
    error_log("[validate_wallet_recharge] " . $e->getMessage());   // plus de détail SQL dans la réponse
    json_response(["status" => "error", "message" => "Erreur lors du traitement de la recharge"], 500);
}

// Lot 8 : prévenir le chauffeur (best-effort, ne change pas le résultat)
try {
    $fmt = number_format($amount, 0, ",", " ");
    if ($action === 'approve') {
        send_push_to_user($conn, 'chauffeur', $chauffeurId, "Recharge validée",
            "Votre recharge de $fmt FCFA a été ajoutée à votre portefeuille.", ["link" => "/chauffeur/"]);
    } else {
        send_push_to_user($conn, 'chauffeur', $chauffeurId, "Recharge refusée",
            "Votre demande de recharge de $fmt FCFA n'a pas été validée. Ouvrez votre portefeuille pour le détail.", ["link" => "/chauffeur/"]);
    }
} catch (Throwable $e) {
    error_log("[validate_wallet_recharge] push : " . $e->getMessage());
}
$conn->close();

json_response([
    "status" => "success",
    "message" => "Recharge " . ($action === 'approve' ? 'validée' : 'rejetée') . " avec succès."
]);
