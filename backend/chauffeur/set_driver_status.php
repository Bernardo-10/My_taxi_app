<?php
/**
 * API pour mettre à jour le statut en ligne/hors ligne du chauffeur
 * 
 * POST /backend/chauffeur/set_driver_status.php
 * 
 * Parameters:
 *   - is_online (boolean): true pour en ligne, false pour hors ligne
 * 
 * Response:
 *   - { "status": "success", ... }
 *   - { "status": "error", "message": "..." }
 */

require_once __DIR__ . '/../config/auth.php';

$driverId = require_driver_id();

$data = json_decode(file_get_contents('php://input'), true);
$isOnline = isset($data['is_online']) ? (int)(bool)$data['is_online'] : null;

if ($isOnline === null) {
    json_response([
        'status' => 'error',
        'message' => 'Paramètre is_online requis'
    ], 400);
}

try {
    $conn = db_connect();

    $checkStmt = $conn->prepare("SELECT status, kyc_status FROM chauffeur WHERE id = ? LIMIT 1");
    if (!$checkStmt) {
        throw new Exception('Erreur de préparation : ' . $conn->error);
    }
    $checkStmt->bind_param('i', $driverId);
    $checkStmt->execute();
    $result = $checkStmt->get_result();
    $driver = $result->fetch_assoc();
    $checkStmt->close();

    if (!$driver) {
        $conn->close();
        json_response(['status' => 'error', 'message' => 'Chauffeur introuvable'], 404);
    }

    if ($driver['status'] !== 'active' && $isOnline) {
        $conn->close();
        json_response([
            'status' => 'error',
            'message' => 'Votre compte a été désactivé par l\'administrateur. Contactez l\'admin.'
        ], 403);
    }

    // Documents non encore validés par un admin : impossible de passer
    // en ligne. Le compte reste utilisable pour consulter l'espace
    // chauffeur (compléter des documents, etc.), mais ne peut pas
    // recevoir de courses tant que kyc_status n'est pas 'approved'.
    if ($isOnline && $driver['kyc_status'] !== 'approved') {
        $conn->close();
        $message = $driver['kyc_status'] === 'rejected'
            ? 'Vos documents ont été rejetés. Contactez l\'administrateur pour plus de détails.'
            : 'Vos documents sont en cours de vérification. Vous pourrez vous mettre en ligne une fois validés.';
        json_response([
            'status' => 'error',
            'message' => $message,
            'kyc_status' => $driver['kyc_status']
        ], 403);
    }

    $stmt = $conn->prepare("
        UPDATE chauffeur 
        SET is_online = ?, updated_at = NOW() 
        WHERE id = ?
    ");
    
    if (!$stmt) {
        throw new Exception('Erreur de préparation : ' . $conn->error);
    }
    
    $stmt->bind_param('ii', $isOnline, $driverId);
    
    if (!$stmt->execute()) {
        throw new Exception("Erreur d'exécution : " . $stmt->error);
    }
    
    $stmt->close();
    $conn->close();
    
    json_response([
        'status' => 'success',
        'message' => $isOnline ? 'Vous êtes en ligne' : 'Vous êtes hors ligne',
        'is_online' => (bool)$isOnline
    ]);
    
} catch (Exception $e) {
    if (isset($conn) && $conn) $conn->close();
    json_response([
        'status' => 'error',
        'message' => $e->getMessage()
    ], 500);
}
?>