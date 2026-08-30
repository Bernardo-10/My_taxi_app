<?php
/**
 * API pour enregistrer/mettre à jour le token FCM de l'admin courant.
 * Calqué sur backend/chauffeur/save_push_subscription.php (voir ce fichier
 * pour les commentaires détaillés) — seule différence : user_type='admin'
 * et l'id vient de la session admin (require_admin_id()), pas chauffeur.
 *
 * POST /backend/admin/save_push_subscription.php
 *   { "token": "<token FCM>" }
 */

require_once __DIR__ . "/../config/auth.php";

$adminId = require_admin_id();

$data  = json_decode(file_get_contents('php://input'), true);
$token = trim($data['token'] ?? '');

if ($token === '') {
    json_response([
        'status' => 'error',
        'message' => 'Paramètre token requis'
    ], 400);
}

try {
    $conn = db_connect();

    $stmt = $conn->prepare("
        INSERT INTO push_subscriptions (user_type, user_id, fcm_token)
        VALUES ('admin', ?, ?)
        ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), updated_at = CURRENT_TIMESTAMP
    ");
    if (!$stmt) {
        throw new Exception('Erreur de préparation : ' . $conn->error);
    }

    $stmt->bind_param('is', $adminId, $token);

    if (!$stmt->execute()) {
        throw new Exception("Erreur d'exécution : " . $stmt->error);
    }

    $stmt->close();
    $conn->close();

    json_response(['status' => 'success']);

} catch (Exception $e) {
    if (isset($conn) && $conn) $conn->close();
    json_response([
        'status' => 'error',
        'message' => $e->getMessage()
    ], 500);
}
?>
