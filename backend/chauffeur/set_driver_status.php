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
