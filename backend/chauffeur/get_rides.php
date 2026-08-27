<?php
require_once __DIR__ . "/../config/auth.php";

$driverId = require_driver_id();
$conn = db_connect();

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
    : "(status = 'pending' AND id NOT IN (
              SELECT ride_id FROM ride_refusals WHERE driver_id = ?
          ))";

$stmt = $conn->prepare("
    SELECT
        id, user_id, pickup, destination,
        pickup_lat, pickup_lng, destination_lat, destination_lng,
        distance_km, duration_min, price_fcfa, passengers, status,
        driver_id, driver_name, driver_plate, driver_lat, driver_lng,
        update_position_driver, created_at, updated_at,
        accepted_at, arrived_at, started_at, completed_at, cancelled_at,
        problem_description
    FROM rides
    WHERE $pendingClause
       OR (driver_id = ? AND status IN ('accepted', 'arrived', 'started', 'completed'))
       OR (driver_id = ? AND status = 'cancelled_client' AND cancelled_at >= NOW() - INTERVAL 1 DAY)
    ORDER BY created_at DESC
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