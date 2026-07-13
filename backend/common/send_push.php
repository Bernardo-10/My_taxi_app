<?php
/**
 * send_push.php — Envoi de notifications push via Firebase Cloud Messaging
 * (API HTTP v1, la seule encore active — l'ancienne API "Server Key" est
 * éteinte par Google depuis juin 2024).
 *
 * Aucune dépendance Composer : le JWT du compte de service est signé à la
 * main (openssl_sign) et le jeton OAuth2 est obtenu par un simple curl vers
 * oauth2.googleapis.com — cohérent avec le reste du projet (pas de vendor/
 * à maintenir sur un hébergement mutualisé sans accès Composer).
 *
 * Prérequis :
 *   - backend/config/firebase-service-account.json présent (téléchargé
 *     depuis Firebase Console > Paramètres du projet > Comptes de service
 *     > Générer une nouvelle clé privée). Ce fichier est aussi sensible
 *     que credentials.php — jamais commité, protégé par le même .htaccess
 *     (Require all denied sur tout backend/config/).
 *   - Table push_subscriptions et fcm_oauth_cache (voir database/schema.sql).
 *
 * Fonctions publiques :
 *   - send_push_to_user($conn, $userType, $userId, $title, $body, $data = [])
 *   - send_push_to_users($conn, $userType, $userIds, $title, $body, $data = [])
 *
 * Ces deux fonctions n'échouent jamais bruyamment : toute erreur (compte
 * de service manquant, token invalide, panne réseau FCM...) est journalisée
 * via error_log() et avalée — un problème d'envoi de notification ne doit
 * jamais faire échouer la transaction métier qui l'a déclenché (accepter
 * une course, etc.), exactement le principe déjà retenu pour Pusher.
 */

define('FCM_SERVICE_ACCOUNT_PATH', __DIR__ . '/../config/firebase-service-account.json');

/**
 * Encode en base64url (sans padding), requis pour un JWT.
 */
function fcm_base64url_encode(string $data): string {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

/**
 * Construit et signe un JWT à partir du compte de service, puis l'échange
 * contre un jeton d'accès OAuth2 auprès de Google. Résultat mis en cache
 * en base (table fcm_oauth_cache) pour éviter un aller-retour OAuth2 à
 * chaque notification — le jeton dure 1h, on le régénère seulement quand
 * il est expiré (avec une marge de sécurité de 5 minutes).
 */
function fcm_get_access_token(mysqli $conn): ?string {
    // 1. Vérifier le cache
    $res = $conn->query("SELECT access_token, expires_at FROM fcm_oauth_cache WHERE id = 1 LIMIT 1");
    if ($res && ($row = $res->fetch_assoc())) {
        if (strtotime($row['expires_at']) > time() + 60) {
            return $row['access_token'];
        }
    }

    // 2. Regénérer un jeton
    if (!file_exists(FCM_SERVICE_ACCOUNT_PATH)) {
        error_log('[FCM] Fichier de compte de service introuvable : ' . FCM_SERVICE_ACCOUNT_PATH);
        return null;
    }
    $serviceAccount = json_decode(file_get_contents(FCM_SERVICE_ACCOUNT_PATH), true);
    if (!$serviceAccount || empty($serviceAccount['private_key']) || empty($serviceAccount['client_email'])) {
        error_log('[FCM] Fichier de compte de service invalide (private_key/client_email manquants)');
        return null;
    }

    $now = time();
    $header = fcm_base64url_encode(json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $claims = fcm_base64url_encode(json_encode([
        'iss'   => $serviceAccount['client_email'],
        'scope' => 'https://www.googleapis.com/auth/firebase.messaging',
        'aud'   => 'https://oauth2.googleapis.com/token',
        'iat'   => $now,
        'exp'   => $now + 3600,
    ]));
    $unsigned = $header . '.' . $claims;

    $signature = '';
    $ok = openssl_sign($unsigned, $signature, $serviceAccount['private_key'], 'sha256WithRSAEncryption');
    if (!$ok) {
        error_log('[FCM] Échec de signature du JWT (openssl_sign)');
        return null;
    }
    $jwt = $unsigned . '.' . fcm_base64url_encode($signature);

    $ch = curl_init('https://oauth2.googleapis.com/token');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_POSTFIELDS     => http_build_query([
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion'  => $jwt,
        ]),
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $decoded = json_decode((string) $response, true);
    if ($httpCode !== 200 || empty($decoded['access_token'])) {
        error_log('[FCM] Échec échange OAuth2 (HTTP ' . $httpCode . ') : ' . $response);
        return null;
    }

    $accessToken = $decoded['access_token'];
    $expiresAt = date('Y-m-d H:i:s', $now + (int) ($decoded['expires_in'] ?? 3600));

    $stmt = $conn->prepare("
        INSERT INTO fcm_oauth_cache (id, access_token, expires_at) VALUES (1, ?, ?)
        ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), expires_at = VALUES(expires_at)
    ");
    if ($stmt) {
        $stmt->bind_param('ss', $accessToken, $expiresAt);
        $stmt->execute();
        $stmt->close();
    }

    return $accessToken;
}

/**
 * Envoie une notification à un token FCM précis. Supprime automatiquement
 * le token de push_subscriptions si FCM répond qu'il n'est plus valide
 * (UNREGISTERED / NOT_FOUND) — pas de cron sur InfinityFree pour un
 * nettoyage périodique, donc ce nettoyage doit se faire à l'échec d'envoi.
 */
function fcm_send_to_token(mysqli $conn, string $token, string $title, string $body, array $data = []): bool {
    if (!file_exists(FCM_SERVICE_ACCOUNT_PATH)) {
        error_log('[FCM] Compte de service absent, envoi ignoré.');
        return false;
    }
    $serviceAccount = json_decode(file_get_contents(FCM_SERVICE_ACCOUNT_PATH), true);
    $projectId = $serviceAccount['project_id'] ?? null;
    if (!$projectId) {
        error_log('[FCM] project_id introuvable dans le compte de service.');
        return false;
    }

    $accessToken = fcm_get_access_token($conn);
    if (!$accessToken) {
        return false;
    }

    // data doit être un tableau de chaînes (contrainte FCM HTTP v1)
    $stringData = [];
    foreach ($data as $k => $v) {
        $stringData[(string) $k] = (string) $v;
    }

    $payload = [
        'message' => [
            'token' => $token,
            'notification' => [
                'title' => $title,
                'body'  => $body,
            ],
            'data' => $stringData,
            'webpush' => [
                'fcm_options' => [
                    // Décidera plus tard, selon user_type, vers quelle page
                    // ouvrir l'app (peut être surchargé via $data['link']).
                    'link' => $data['link'] ?? '/',
                ],
            ],
        ],
    ];

    $ch = curl_init("https://fcm.googleapis.com/v1/projects/{$projectId}/messages:send");
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => [
            'Authorization: Bearer ' . $accessToken,
            'Content-Type: application/json',
        ],
        CURLOPT_POSTFIELDS => json_encode($payload),
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode === 200) {
        return true;
    }

    $decoded = json_decode((string) $response, true);
    $status = $decoded['error']['status'] ?? '';
    error_log("[FCM] Échec envoi (HTTP {$httpCode}, {$status}) : " . $response);

    // Token mort (app désinstallée, cache vidé...) : on le retire.
    if (in_array($status, ['UNREGISTERED', 'NOT_FOUND', 'INVALID_ARGUMENT'], true)) {
        $del = $conn->prepare("DELETE FROM push_subscriptions WHERE fcm_token = ?");
        if ($del) {
            $del->bind_param('s', $token);
            $del->execute();
            $del->close();
        }
    }

    return false;
}

/**
 * Envoie à tous les appareils enregistrés d'un utilisateur donné
 * (client ou chauffeur) — un même compte peut avoir plusieurs tokens
 * (plusieurs navigateurs/appareils).
 */
function send_push_to_user(mysqli $conn, string $userType, int $userId, string $title, string $body, array $data = []): void {
    try {
        $stmt = $conn->prepare("SELECT fcm_token FROM push_subscriptions WHERE user_type = ? AND user_id = ?");
        if (!$stmt) return;
        $stmt->bind_param('si', $userType, $userId);
        $stmt->execute();
        $res = $stmt->get_result();
        $tokens = [];
        while ($row = $res->fetch_assoc()) {
            $tokens[] = $row['fcm_token'];
        }
        $stmt->close();

        foreach ($tokens as $token) {
            fcm_send_to_token($conn, $token, $title, $body, $data);
        }
    } catch (Throwable $e) {
        error_log('[FCM] send_push_to_user exception : ' . $e->getMessage());
    }
}

/**
 * Variante groupée — utile pour notifier tous les chauffeurs disponibles
 * d'une nouvelle course, par exemple.
 */
function send_push_to_users(mysqli $conn, string $userType, array $userIds, string $title, string $body, array $data = []): void {
    if (empty($userIds)) return;
    try {
        $placeholders = implode(',', array_fill(0, count($userIds), '?'));
        $types = 's' . str_repeat('i', count($userIds));
        $stmt = $conn->prepare("SELECT fcm_token FROM push_subscriptions WHERE user_type = ? AND user_id IN ($placeholders)");
        if (!$stmt) return;
        $stmt->bind_param($types, $userType, ...$userIds);
        $stmt->execute();
        $res = $stmt->get_result();
        $tokens = [];
        while ($row = $res->fetch_assoc()) {
            $tokens[] = $row['fcm_token'];
        }
        $stmt->close();

        foreach ($tokens as $token) {
            fcm_send_to_token($conn, $token, $title, $body, $data);
        }
    } catch (Throwable $e) {
        error_log('[FCM] send_push_to_users exception : ' . $e->getMessage());
    }
}
?>
