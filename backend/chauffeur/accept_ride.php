<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";

$driverId = require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);

if (!isset($data["id"])) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$id = (int) $data["id"];
$driverLat = isset($data["driver_lat"]) && $data["driver_lat"] !== null ? (float) $data["driver_lat"] : null;
$driverLng = isset($data["driver_lng"]) && $data["driver_lng"] !== null ? (float) $data["driver_lng"] : null;

if ($driverLat === null || $driverLng === null) {
    json_response([
        "status" => "error",
        "message" => "Position GPS non disponible",
        "received_lat" => $driverLat,
        "received_lng" => $driverLng
    ], 400);
}

$conn = db_connect();

$driverStmt = $conn->prepare("SELECT name, plate, wallet_balance_fcfa FROM chauffeur WHERE id = ? AND status = 'active' AND is_online = 1");
$driverStmt->bind_param("i", $driverId);
$driverStmt->execute();
$driver = $driverStmt->get_result()->fetch_assoc();
$driverStmt->close();

if (!$driver) {
    $conn->close();
    json_response(["status" => "error", "message" => "Chauffeur introuvable ou inactif"], 403);
}

// Blocage par solde : un chauffeur sous le seuil ne peut pas accepter de
// nouvelle course. Vérifié ici côté serveur (source de vérité) — le
// filtrage de get_rides.php n'est qu'une aide UX côté client.
if (is_wallet_balance_blocked($driver["wallet_balance_fcfa"] ?? 0)) {
    $conn->close();
    json_response([
        "status" => "error",
        "message" => "Solde insuffisant pour accepter une course. Rechargez votre compte pour continuer."
    ], 402);
}

$checkStmt = $conn->prepare("SELECT id, status FROM rides WHERE id = ?");
$checkStmt->bind_param("i", $id);
$checkStmt->execute();
$checkResult = $checkStmt->get_result();

if ($checkResult->num_rows === 0) {
    $checkStmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Course introuvable"], 404);
}

$checkStmt->close();

$stmt = $conn->prepare("
    UPDATE rides
    SET status = 'accepted',
        driver_name = ?,
        driver_plate = ?,
        driver_id = ?,
        driver_lat = ?,
        driver_lng = ?,
        update_position_driver = NOW(),
        accepted_at = NOW()
    WHERE id = ? AND status = 'pending'
");

if (!$stmt) {
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur prepare"], 500);
}

$stmt->bind_param("ssiddi", $driver["name"], $driver["plate"], $driverId, $driverLat, $driverLng, $id);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Erreur execute"], 500);
}

$accepted = $stmt->affected_rows > 0;
$stmt->close();

if ($accepted) {
    // Remplacement du TRIGGER : mise à jour des stats chauffeur
    $priceStmt = $conn->prepare("SELECT price_fcfa, user_id FROM rides WHERE id = ?");
    $priceStmt->bind_param("i", $id);
    $priceStmt->execute();
    $ride = $priceStmt->get_result()->fetch_assoc();
    $priceStmt->close();

    $price = $ride["price_fcfa"] ?? 0;

    $statStmt = $conn->prepare("
        UPDATE chauffeur
        SET total_accepted_amount_fcfa = total_accepted_amount_fcfa + ?,
            total_accepted_rides = total_accepted_rides + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    ");
    $statStmt->bind_param("di", $price, $driverId);
    $statStmt->execute();
    $statStmt->close();

    // FCM — le client peut avoir verrouille son ecran en attendant.
    if (!empty($ride["user_id"])) {
        send_push_to_user(
            $conn,
            'client',
            (int) $ride["user_id"],
            'Chauffeur en route',
            trim($driver["name"] ?? "") !== "" ? "{$driver['name']} a accepté votre course." : "Votre course a été acceptée.",
            ['link' => '/client/', 'ride_id' => (string) $id]
        );
    }

    $conn->close();

    json_response([
        "status" => "ok",
        "message" => "Course acceptee et position enregistree",
        "driver_lat" => $driverLat,
        "driver_lng" => $driverLng
    ]);
}

$conn->close();
json_response(["status" => "error", "message" => "Course non en pending ou deja acceptee"], 409);
?>