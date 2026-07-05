<?php
require_once __DIR__ . "/../config/auth.php";

require_client_id();

$conn = db_connect();

// Chauffeurs reellement disponibles pour une reservation :
// en ligne, statut actif, position recente (< 10 min, meme seuil que l'admin),
// et sans course en cours (pending/accepted/arrived/started) -- un chauffeur
// avec une course active n'est pas reservable, on ne l'affiche donc pas
// (decision produit confirmee : pas de distinction visuelle "en course").
$stmt = $conn->prepare("
    SELECT c.id, c.driver_lat, c.driver_lng, c.car_brand, c.car_color
    FROM chauffeur c
    WHERE c.is_online = 1
      AND c.status = 'active'
      AND c.driver_lat IS NOT NULL
      AND c.driver_lng IS NOT NULL
      AND c.update_position_driver >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
      AND NOT EXISTS (
          SELECT 1 FROM rides r
          WHERE r.driver_id = c.id
            AND r.status IN ('accepted','arrived','started')
      )
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
