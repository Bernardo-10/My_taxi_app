<?php
require_once __DIR__ . "/../config/auth.php";

require_client_id();

$conn = db_connect();
sync_stale_drivers_offline($conn);

// Tous les chauffeurs en ligne, en position recente (< 10 min, meme seuil
// que l'admin) -- y compris ceux en course. Decision produit : donner une
// image complete de l'activite dans la zone plutot que de se limiter aux
// chauffeurs strictement reservables (cf. discussion plan v4, chantier 3).
$stmt = $conn->prepare("
    SELECT c.id, c.driver_lat, c.driver_lng, c.car_brand, c.car_color
    FROM chauffeur c
    WHERE c.is_online = 1
      AND c.status = 'active'
      AND c.driver_lat IS NOT NULL
      AND c.driver_lng IS NOT NULL
      AND c.update_position_driver >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
");
$stmt->execute();
$result = $stmt->get_result();

$drivers = [];
while ($row = $result->fetch_assoc()) {
    $drivers[] = [
        "id"         => (int) $row["id"],
        "driver_lat" => (float) $row["driver_lat"],
        "driver_lng" => (float) $row["driver_lng"],
        "car_brand"  => $row["car_brand"],
        "car_color"  => $row["car_color"],
    ];
}
$stmt->close();
$conn->close();

json_response(["status" => "success", "drivers" => $drivers]);
?>
