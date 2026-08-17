<?php
/**
 * test_push.php — TEST MANUEL UNIQUEMENT. À SUPPRIMER APRÈS VALIDATION.
 *
 * Sert uniquement à vérifier que l'envoi FCM fonctionne de bout en bout
 * (JWT signé, échange OAuth2, appel HTTP v1) avant de brancher quoi que ce
 * soit dans les fichiers métier. Protégé par une session admin — personne
 * d'autre ne peut déclencher un envoi via ce fichier.
 *
 * Usage (une fois connecté en admin, dans le même navigateur) :
 *   /backend/admin/test_push.php?user_type=client&user_id=12
 *   /backend/admin/test_push.php?user_type=chauffeur&user_id=7&title=Salut&body=Ca+marche
 *
 * Retourne un diagnostic détaillé : combien de tokens trouvés pour cet
 * utilisateur, et le résultat de l'envoi pour chacun (au lieu de
 * send_push_to_user() qui ne renvoie rien, volontairement, pour ne jamais
 * faire échouer une vraie transaction métier sur un souci de notification).
 *
 * ⚠️ Ne fonctionnera que si backend/config/firebase-service-account.json
 * est bien présent sur le serveur (jamais dans un zip, uploadé à la main).
 */

require_once __DIR__ . '/../config/auth.php';
require_once __DIR__ . '/../common/send_push.php';

require_admin_id();

$userType = $_GET['user_type'] ?? $_POST['user_type'] ?? '';
$userId   = (int) ($_GET['user_id'] ?? $_POST['user_id'] ?? 0);
$title    = $_GET['title'] ?? $_POST['title'] ?? 'Test TaxiGo';
$body     = $_GET['body']  ?? $_POST['body']  ?? 'Si tu vois cette notification, FCM fonctionne 🎉';

if (!in_array($userType, ['client', 'chauffeur'], true) || $userId <= 0) {
    json_response([
        'status' => 'error',
        'message' => 'Paramètres requis : user_type=client|chauffeur et user_id=<int>',
    ], 400);
}

try {
    $conn = db_connect();

    if (!file_exists(FCM_SERVICE_ACCOUNT_PATH)) {
        json_response([
            'status' => 'error',
            'message' => 'firebase-service-account.json introuvable sur le serveur à : ' . FCM_SERVICE_ACCOUNT_PATH
                       . ' — upload-le d\'abord (jamais via un zip), puis relance ce test.',
        ], 500);
    }

    // Récupère tous les tokens de cet utilisateur (peut avoir plusieurs
    // appareils/navigateurs enregistrés).
    $stmt = $conn->prepare("SELECT id, fcm_token, created_at, updated_at FROM push_subscriptions WHERE user_type = ? AND user_id = ?");
    $stmt->bind_param('si', $userType, $userId);
    $stmt->execute();
    $res = $stmt->get_result();

    $tokens = [];
    while ($row = $res->fetch_assoc()) {
        $tokens[] = $row;
    }
    $stmt->close();

    if (empty($tokens)) {
        json_response([
            'status' => 'error',
            'message' => "Aucun token trouvé pour user_type=$userType, user_id=$userId. "
                       . "Vérifie que ce compte s'est bien connecté sur l'app avec les notifications autorisées "
                       . "(SELECT * FROM push_subscriptions; pour voir ce qui existe réellement).",
        ], 404);
    }

    // Test préalable : le jeton OAuth2 s'obtient-il correctement ?
    $accessToken = fcm_get_access_token($conn);
    if (!$accessToken) {
        json_response([
            'status' => 'error',
            'message' => 'Échec de génération du jeton OAuth2 — vérifie error_log() côté serveur '
                       . '(clé privée invalide, client_email incorrect, horloge serveur désynchronisée...).',
        ], 500);
    }

    // Envoi réel à chaque token trouvé, avec diagnostic détaillé par token.
    $results = [];
    foreach ($tokens as $t) {
        $success = fcm_send_to_token($conn, $t['fcm_token'], $title, $body, ['link' => '/']);
        $results[] = [
            'subscription_id' => (int) $t['id'],
            'token_preview'   => substr($t['fcm_token'], 0, 20) . '...',
            'registered_at'   => $t['created_at'],
            'sent'            => $success,
        ];
    }

    $conn->close();

    json_response([
        'status'        => 'success',
        'oauth_token_ok' => true,
        'tokens_found'  => count($tokens),
        'results'       => $results,
        'note'          => 'Regarde ton téléphone (verrouille l\'écran juste après cet appel pour tester ce cas précis). '
                          . 'Si "sent": false pour un token, regarde error_log() côté serveur pour le détail exact.',
    ]);

} catch (Exception $e) {
    if (isset($conn) && $conn) $conn->close();
    json_response([
        'status' => 'error',
        'message' => $e->getMessage(),
    ], 500);
}
?>
