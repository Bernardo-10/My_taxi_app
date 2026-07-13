<?php
/**
 * API pour enregistrer/mettre à jour le token FCM du client courant.
 *
 * POST /backend/client/save_push_subscription.php
 *
 * Parameters:
 *   - token (string): token FCM renvoyé par getToken() côté navigateur
 *
 * Response:
 *   - { "status": "success" }
 *   - { "status": "error", "message": "..." }
 */

require_once __DIR__ . '/../config/auth.php';

$clientId = require_client_id();

$data = json_decode(file_get_contents('php://input'), true);
$token = trim($data['token'] ?? '');

if ($token === '') {
    json_response([
        'status' => 'error',
        'message' => 'Paramètre token requis'
    ], 400);
}

try {
    $conn = db_connect();

    // UNIQUE porte sur fcm_token (pas sur user_id) : un même navigateur qui
    // regénère le même token met simplement à jour user_id/updated_at,
    // un même utilisateur peut avoir plusieurs tokens (plusieurs appareils).
    $stmt = $conn->prepare("
        INSERT INTO push_subscriptions (user_type, user_id, fcm_token)
        VALUES ('client', ?, ?)
        ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), updated_at = CURRENT_TIMESTAMP
    ");
    if (!$stmt) {
        throw new Exception('Erreur de préparation : ' . $conn->error);
    }

    $stmt->bind_param('is', $clientId, $token);

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
