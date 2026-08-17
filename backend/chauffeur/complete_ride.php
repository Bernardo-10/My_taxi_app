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

// Passage en 'completed'
$stmt = $conn->prepare("UPDATE rides SET status = 'completed', completed_at = NOW() WHERE id = ? AND driver_id = ? AND status = 'started'");
$stmt->bind_param("ii", $id, $driverId);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();

if ($updated) {
    // Mise à jour des statistiques du chauffeur (distance + nb courses)
    $rideStmt = $conn->prepare("SELECT distance_km FROM rides WHERE id = ?");
    $rideStmt->bind_param("i", $id);
    $rideStmt->execute();
    $rideRow = $rideStmt->get_result()->fetch_assoc();
    $rideStmt->close();

    $distanceKm = $rideRow["distance_km"] ?? 0;

    $statStmt = $conn->prepare("
        UPDATE chauffeur
        SET total_completed_distance_km = total_completed_distance_km + ?,
            total_completed_rides = total_completed_rides + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    ");
    $statStmt->bind_param("di", $distanceKm, $driverId);
    $statStmt->execute();
    $statStmt->close();

    // --- Gestion de la commission 20% ---
    $price = (int) ($ride['price_fcfa'] ?? 0);
    $commission = (int) round($price * 0.20); // montant positif

    if ($commission > 0) {
        // Insérer la transaction (débit)
        $negAmount = -$commission;
        $desc = "Commission 20% sur course #$id";
        $txStmt = $conn->prepare("
            INSERT INTO wallet_transactions
                (chauffeur_id, type, amount_fcfa, ride_id, status, description)
            VALUES (?, 'commission', ?, ?, 'completed', ?)
        ");
        $txStmt->bind_param("iiis", $driverId, $negAmount, $id, $desc);
        $txStmt->execute();
        $txStmt->close();

        // Mettre à jour le solde du chauffeur
        $balStmt = $conn->prepare("
            UPDATE chauffeur
            SET wallet_balance_fcfa = wallet_balance_fcfa - ?
            WHERE id = ?
        ");
        $balStmt->bind_param("ii", $commission, $driverId);
        $balStmt->execute();
        $balStmt->close();
    }

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