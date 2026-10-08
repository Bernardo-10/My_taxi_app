<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/ride_expiry.php";

$driverId = require_driver_id();
$conn = db_connect();
// Les courses 'pending' périmées sont expirées avant la lecture : le chauffeur
// ne voit plus de demandes que plus personne n'attend.
expire_stale_pending_rides($conn);

// ── Correctif §4.1 du rapport KYC ────────────────────────────────
// current_user.php ne vérifie l'expiration des documents qu'au chargement
// de page — insuffisant pour un chauffeur qui reste en ligne en continu
// (sa position GPS ne cesse jamais d'être fraîche, donc il ne repasse
// jamais par set_driver_status.php). get_rides.php, lui, est interrogé
// en boucle toutes les 5s tant que le chauffeur est en ligne : c'est ici
// que la vérification doit se répéter pour de vrai.
$kycCheckStmt = $conn->prepare("
    SELECT is_online, cni_expiration, carte_grise_expiration, permit_expiration,
           capacity_expiration, license_expiration, wallet_balance_fcfa
    FROM chauffeur WHERE id = ? LIMIT 1
");
$kycCheckStmt->bind_param("i", $driverId);
$kycCheckStmt->execute();
$driverRow = $kycCheckStmt->get_result()->fetch_assoc();
$kycCheckStmt->close();

if ($driverRow && (int) $driverRow["is_online"] === 1) {
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
        if (!empty($driverRow[$col]) && new DateTime($driverRow[$col]) < $today) {
            $expiredLabels[] = $label;
        }
    }

    if ($expiredLabels) {
        $offStmt = $conn->prepare("UPDATE chauffeur SET is_online = 0 WHERE id = ?");
        $offStmt->bind_param("i", $driverId);
        $offStmt->execute();
        $offStmt->close();

        // Signalé via en-têtes plutôt que dans le corps JSON : get_rides.php
        // renvoie un tableau brut de courses (pas un objet), consommé tel
        // quel par plusieurs endroits du frontend (allRides = rides) —
        // changer la forme de la réponse casserait ces usages. Les en-têtes
        // permettent d'ajouter ce signal sans toucher au contrat existant.
        header("X-Kyc-Blocked: 1");
        header("X-Kyc-Blocked-Documents: " . rawurlencode(implode(", ", $expiredLabels)));
    }
}

// Blocage par solde (< 500 FCFA) : contrairement au blocage KYC ci-dessus,
// on ne force JAMAIS is_online = 0 ici — un chauffeur en course active ne
// doit pas être coupé. On se contente de ne pas lui envoyer de nouvelles
// courses 'pending' et de signaler l'état via en-tête, comme pour le KYC.
$balanceBlocked = $driverRow
    && (int) $driverRow["is_online"] === 1
    && is_wallet_balance_blocked($driverRow["wallet_balance_fcfa"] ?? 0);

if ($balanceBlocked) {
    header("X-Balance-Blocked: 1");
}

$pendingClause = $balanceBlocked
    ? "(1 = 0)" // solde insuffisant : aucune nouvelle course pending envoyée
    : "(rides.status = 'pending' AND rides.id NOT IN (
              SELECT ride_id FROM ride_refusals WHERE driver_id = ?
          ))";

$stmt = $conn->prepare("
    SELECT
        rides.id, rides.user_id, rides.pickup, rides.destination,
        rides.pickup_lat, rides.pickup_lng, rides.destination_lat, rides.destination_lng,
        rides.distance_km, rides.duration_min, rides.price_fcfa, rides.passengers, rides.status,
        rides.driver_id, rides.driver_name, rides.driver_plate, rides.driver_lat, rides.driver_lng,
        rides.update_position_driver, rides.created_at, rides.updated_at,
        rides.accepted_at, rides.arrived_at, rides.started_at, rides.completed_at, rides.cancelled_at,
        rides.problem_description, rides.problem_at, rides.problem_resolved_at,
        CASE WHEN rides.status = 'pending' THEN NULL ELSE client.full_name END AS client_name
    FROM rides
    LEFT JOIN client ON client.id = rides.user_id
    WHERE $pendingClause
       OR (rides.driver_id = ? AND rides.status IN ('accepted', 'arrived', 'started', 'completed'))
       OR (rides.driver_id = ? AND rides.status = 'cancelled_client' AND rides.cancelled_at >= NOW() - INTERVAL 1 DAY)
    ORDER BY rides.created_at DESC
");

if ($balanceBlocked) {
    $stmt->bind_param("ii", $driverId, $driverId);
} else {
    $stmt->bind_param("iii", $driverId, $driverId, $driverId);
}
$stmt->execute();
$result = $stmt->get_result();

$rides = [];
while ($row = $result->fetch_assoc()) {
    $rides[] = $row;
}

$stmt->close();
$conn->close();

json_response($rides);
?>