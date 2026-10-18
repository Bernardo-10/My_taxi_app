<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/geo.php";
require_once __DIR__ . "/../common/send_push.php";

// Distance à partir de laquelle une confirmation est demandée avant de terminer
const COMPLETE_CONFIRM_DISTANCE_METERS = 200;

$driverId = require_driver_id();
$data  = json_decode(file_get_contents("php://input"), true);
$id    = isset($data["id"]) ? (int) $data["id"] : 0;
$lat   = isset($data["lat"]) && is_numeric($data["lat"]) ? (float) $data["lat"] : null;
$lng   = isset($data["lng"]) && is_numeric($data["lng"]) ? (float) $data["lng"] : null;
$force = !empty($data["force"]);

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();

// Récupération des infos de la course (incluant price_fcfa)
$stmt = $conn->prepare("SELECT destination_lat, destination_lng, price_fcfa, user_id FROM rides WHERE id = ? AND driver_id = ? AND status = 'started'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$ride = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$ride) {
    $conn->close();
    json_response(["status" => "error", "message" => "Impossible de terminer (course non démarrée)"]);
}

// Vérification de proximité (si GPS et destination dispo, et non forcé)
if (!$force && $lat !== null && $lng !== null
    && $ride["destination_lat"] !== null && $ride["destination_lng"] !== null) {

    $distance = haversine_distance_meters(
        (float) $ride["destination_lat"],
        (float) $ride["destination_lng"],
        $lat,
        $lng
    );

    if ($distance > COMPLETE_CONFIRM_DISTANCE_METERS) {
        $conn->close();
        json_response([
            "status"   => "needs_confirmation",
            "message"  => "Vous etes a " . round($distance) . " m de la destination prevue.",
            "distance" => round($distance)
        ]);
    }
}

// B3 : tout ce qui concerne la fin de course se fait dans UNE transaction
// (statut + statistiques + commission + solde). Si une étape échoue, rien
// n'est modifié : plus de course "terminée" sans commission débitée, ni de
// solde modifié sans ligne dans l'historique.
$completed = false;
$conn->begin_transaction();
try {
    // FOR UPDATE : verrouille la course. Un double clic / double appel attend
    // ici, puis ne trouve plus le statut 'started' => la commission ne peut
    // pas être débitée deux fois.
    $lockStmt = $conn->prepare("
        SELECT price_fcfa, distance_km, user_id
        FROM rides
        WHERE id = ? AND driver_id = ? AND status = 'started'
        FOR UPDATE
    ");
    $lockStmt->bind_param("ii", $id, $driverId);
    $lockStmt->execute();
    $locked = $lockStmt->get_result()->fetch_assoc();
    $lockStmt->close();

    if ($locked) {
        $ride["user_id"] = $locked["user_id"];
        $price      = (int) ($locked["price_fcfa"] ?? 0);
        $distanceKm = $locked["distance_km"] ?? 0;

        // 1) Passage en 'completed'
        $stmt = $conn->prepare("UPDATE rides SET status = 'completed', completed_at = NOW() WHERE id = ? AND driver_id = ? AND status = 'started'");
        $stmt->bind_param("ii", $id, $driverId);
        if (!$stmt->execute()) { throw new Exception("update ride: " . $stmt->error); }
        $stmt->close();

        // 2) Statistiques du chauffeur (distance + nb courses)
        $statStmt = $conn->prepare("
            UPDATE chauffeur
            SET total_completed_distance_km = total_completed_distance_km + ?,
                total_completed_rides = total_completed_rides + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ");
        $statStmt->bind_param("di", $distanceKm, $driverId);
        if (!$statStmt->execute()) { throw new Exception("update stats: " . $statStmt->error); }
        $statStmt->close();

        // 3) Commission (taux unique : COMMISSION_RATE dans auth.php)
        $commission = (int) round($price * COMMISSION_RATE); // montant positif
        if ($commission > 0) {
            $negAmount = -$commission;
            $desc = "Commission " . round(COMMISSION_RATE * 100) . "% sur course #$id";
            $txStmt = $conn->prepare("
                INSERT INTO wallet_transactions
                    (chauffeur_id, type, amount_fcfa, ride_id, status, description)
                VALUES (?, 'commission', ?, ?, 'completed', ?)
            ");
            $txStmt->bind_param("iiis", $driverId, $negAmount, $id, $desc);
            if (!$txStmt->execute()) { throw new Exception("insert tx: " . $txStmt->error); }
            $txStmt->close();

            $balStmt = $conn->prepare("
                UPDATE chauffeur
                SET wallet_balance_fcfa = wallet_balance_fcfa - ?
                WHERE id = ?
            ");
            $balStmt->bind_param("ii", $commission, $driverId);
            if (!$balStmt->execute()) { throw new Exception("update balance: " . $balStmt->error); }
            $balStmt->close();
        }

        $completed = true;
    }

    $conn->commit();
} catch (Throwable $e) {
    $conn->rollback();
    error_log("[complete_ride] " . $e->getMessage());
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur serveur, la course n'a pas été terminée. Réessayez."], 500);
}

if ($completed) {
    // Notification APRÈS la transaction : un échec d'envoi push ne doit
    // jamais annuler la fin de course.
    if (!empty($ride["user_id"])) {
        send_push_to_user(
            $conn,
            'client',
            (int) $ride["user_id"],
            'Course terminée',
            'Merci d\'avoir voyagé avec TaxiGo !',
            ['link' => '/client/', 'ride_id' => (string) $id]
        );
    }

    $conn->close();
    json_response(["status" => "success", "message" => "Course terminée"]);
}

$conn->close();
json_response(["status" => "error", "message" => "Impossible de terminer (course non démarrée)"]);
?>