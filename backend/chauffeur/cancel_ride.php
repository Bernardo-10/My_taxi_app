<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();

// B4 : une annulation par le chauffeur ne termine plus la course. Elle repart
// en 'pending' pour que les autres chauffeurs puissent l'accepter, sans
// pénalité pour le chauffeur. Tout se fait dans UNE transaction : si une
// étape échoue, rien n'est modifié (pas de course à moitié remise en file).
$ride = null;
$conn->begin_transaction();
try {
    // FOR UPDATE : verrouille la ligne, pour qu'un client qui annule au même
    // instant ne croise pas cette remise en file.
    $selStmt = $conn->prepare("
        SELECT user_id, price_fcfa, pickup, destination
        FROM rides
        WHERE id = ? AND driver_id = ? AND status IN ('accepted', 'arrived')
        FOR UPDATE
    ");
    $selStmt->bind_param("ii", $id, $driverId);
    $selStmt->execute();
    $ride = $selStmt->get_result()->fetch_assoc();
    $selStmt->close();

    if ($ride) {
        // 1) La course redevient disponible : on efface tout ce qui rattache
        //    la course à ce chauffeur. created_at repart de maintenant, sinon
        //    le délai d'expiration de 30 min (ride_expiry.php) pourrait
        //    expirer aussitôt une course acceptée il y a longtemps.
        $upStmt = $conn->prepare("
            UPDATE rides
            SET status = 'pending',
                driver_id = NULL, driver_name = NULL, driver_plate = NULL,
                driver_lat = NULL, driver_lng = NULL, update_position_driver = NULL,
                accepted_at = NULL, arrived_at = NULL,
                created_at = NOW()
            WHERE id = ? AND driver_id = ? AND status IN ('accepted', 'arrived')
        ");
        $upStmt->bind_param("ii", $id, $driverId);
        $upStmt->execute();
        $upStmt->close();

        // 2) Ce chauffeur ne revoit plus cette course (même mécanisme que
        //    le bouton « Refuser »). INSERT IGNORE : sans erreur s'il existe déjà.
        $refStmt = $conn->prepare("INSERT IGNORE INTO ride_refusals (ride_id, driver_id) VALUES (?, ?)");
        $refStmt->bind_param("ii", $id, $driverId);
        $refStmt->execute();
        $refStmt->close();

        // 3) Les statistiques « acceptées » ont été incrémentées à l'acceptation
        //    (accept_ride.php) : on les retire, sinon la course serait comptée
        //    deux fois quand un autre chauffeur l'accepte. GREATEST évite un
        //    compteur négatif.
        $price = (float) ($ride["price_fcfa"] ?? 0);
        $statStmt = $conn->prepare("
            UPDATE chauffeur
            SET total_accepted_amount_fcfa = GREATEST(0, total_accepted_amount_fcfa - ?),
                total_accepted_rides = GREATEST(0, total_accepted_rides - 1),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ");
        $statStmt->bind_param("di", $price, $driverId);
        $statStmt->execute();
        $statStmt->close();
    }

    $conn->commit();
} catch (Throwable $e) {
    $conn->rollback();
    error_log("[cancel_ride] " . $e->getMessage());
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur serveur, réessayez."], 500);
}

$updated = !empty($ride);

if ($updated) {
    // Notifications APRÈS la transaction : un échec d'envoi push ne doit
    // jamais annuler la remise en file.
    if (!empty($ride["user_id"])) {
        send_push_to_user(
            $conn,
            'client',
            (int) $ride["user_id"],
            'Chauffeur indisponible',
            'Votre chauffeur a annulé. Nous cherchons un autre chauffeur pour vous.',
            ['link' => '/client/', 'ride_id' => (string) $id]
        );
    }

    // Les autres chauffeurs en ligne sont prévenus que la course est de
    // nouveau disponible (même sélection que client/backend.php, sans le
    // chauffeur qui vient d'annuler).
    sync_stale_drivers_offline($conn);
    $driversRes = $conn->query("SELECT id FROM chauffeur WHERE is_online = 1 AND status = 'active' AND id <> " . (int) $driverId);
    $driverIds = [];
    if ($driversRes) {
        while ($row = $driversRes->fetch_assoc()) {
            $driverIds[] = (int) $row["id"];
        }
    }
    if (!empty($driverIds)) {
        $pickup = (string) ($ride["pickup"] ?? "");
        $destination = (string) ($ride["destination"] ?? "");
        send_push_to_users(
            $conn,
            'chauffeur',
            $driverIds,
            'Course à nouveau disponible',
            trim($pickup) !== "" && trim($destination) !== "" ? "$pickup → $destination" : "Une course vous attend.",
            ['link' => '/chauffeur/', 'ride_id' => (string) $id]
        );
    }
}

$conn->close();

json_response([
    "status" => $updated ? "success" : "error",
    "message" => $updated
        ? "Course annulée : elle est remise à disposition des autres chauffeurs"
        : "Impossible d'annuler (course non acceptée, non arrivée ou déjà démarrée)"
]);
?>
