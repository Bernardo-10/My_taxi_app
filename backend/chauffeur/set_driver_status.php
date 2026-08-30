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

    $checkStmt = $conn->prepare("
        SELECT status, kyc_status, wallet_balance_fcfa,
               cni_expiration, carte_grise_expiration, permit_expiration,
               capacity_expiration, license_expiration
        FROM chauffeur WHERE id = ? LIMIT 1
    ");
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
        // 'incomplete' (nouveau, voir rapport friction-inscription-chauffeur.md) :
        // le chauffeur n'a encore rien soumis, distinct de 'pending' (déjà soumis,
        // en attente d'un admin) — le message doit le renvoyer vers la complétion
        // de son profil, pas lui faire croire qu'il attend une validation qui n'a
        // pas encore commencé.
        if ($driver['kyc_status'] === 'incomplete') {
            $message = 'Complétez votre profil (CNI, carte grise, permis, capacité, licence) pour pouvoir passer en ligne.';
        } elseif ($driver['kyc_status'] === 'rejected') {
            $message = 'Vos documents ont été rejetés. Contactez l\'administrateur pour plus de détails.';
        } else {
            $message = 'Vos documents sont en cours de vérification. Vous pourrez vous mettre en ligne une fois validés.';
        }
        json_response([
            'status' => 'error',
            'message' => $message,
            'kyc_status' => $driver['kyc_status']
        ], 403);
    }

    // Documents expirés : bloque la mise en ligne, même si kyc_status
    // reste 'approved' (kyc_status ne descend jamais tout seul — voir
    // proposition ci-dessous). Avant ce correctif, seul get_rides.php
    // (en boucle toutes les 5s pendant que le chauffeur est déjà en
    // ligne) détectait ça — un chauffeur hors ligne pouvait donc repasser
    // en ligne sans blocage immédiat, jusqu'au prochain cycle. Ici, on
    // coupe la possibilité même de passer en ligne.
    if ($isOnline) {
        $docLabels = [
            "cni_expiration" => "CNI",
            "carte_grise_expiration" => "Carte grise",
            "permit_expiration" => "Permis de conduire",
            "capacity_expiration" => "Carte de capacité",
            "license_expiration" => "Licence professionnelle"
        ];
        $today = new DateTime("today");
        $expiredLabels = [];
        foreach ($docLabels as $col => $label) {
            if (!empty($driver[$col]) && new DateTime($driver[$col]) < $today) {
                $expiredLabels[] = $label;
            }
        }
        if ($expiredLabels) {
            $conn->close();
            json_response([
                'status' => 'error',
                'message' => 'Document(s) expiré(s) : ' . implode(', ', $expiredLabels) . '. Renouvelez-le(s) dans "Mes documents" pour pouvoir vous mettre en ligne.',
                'kyc_status' => $driver['kyc_status']
            ], 403);
        }
    }

    // Blocage par solde : un chauffeur sous le seuil ne peut pas se
    // remettre en ligne, SAUF s'il a déjà une course active en cours
    // (on ne coupe jamais un chauffeur qui est en train de rouler).
    if ($isOnline && is_wallet_balance_blocked($driver['wallet_balance_fcfa'] ?? 0)) {
        $activeStmt = $conn->prepare("
            SELECT id FROM rides
            WHERE driver_id = ? AND status IN ('accepted', 'arrived', 'started')
            LIMIT 1
        ");
        $activeStmt->bind_param('i', $driverId);
        $activeStmt->execute();
        $hasActiveRide = $activeStmt->get_result()->num_rows > 0;
        $activeStmt->close();

        if (!$hasActiveRide) {
            $conn->close();
            json_response([
                'status' => 'error',
                'message' => 'Votre solde est insuffisant (< ' . WALLET_MIN_BALANCE_FCFA . ' FCFA). Rechargez votre compte pour pouvoir vous mettre en ligne.'
            ], 402);
        }
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