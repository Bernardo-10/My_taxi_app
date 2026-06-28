<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/require_admin.php";

require_admin_id();
$conn = db_connect();

// Tous les chauffeurs avec une position GPS récente (< 5 min)
// ou engagés dans une course active.
$result = $conn->query("
    SELECT
        ch.id,
        ch.name,
        ch.phone,
        ch.plate,
        ch.car_brand,
        ch.car_color,
        ch.status AS account_status,
        r.id         AS ride_id,
        r.status     AS ride_status,
        r.pickup,
        r.destination,
        r.driver_lat AS lat,
        r.driver_lng AS lng,
        r.update_position_driver AS gps_at
    FROM chauffeur ch
    INNER JOIN rides r ON r.driver_id = ch.id
        AND r.status IN ('accepted','arrived','started')
        AND r.driver_lat IS NOT NULL
        AND r.driver_lng IS NOT NULL
    WHERE ch.status = 'active'

    UNION

    SELECT
        ch.id,
        ch.name,
        ch.phone,
        ch.plate,
        ch.car_brand,
        ch.car_color,
        ch.status AS account_status,
        NULL AS ride_id,
        'idle' AS ride_status,
        NULL AS pickup,
        NULL AS destination,
        ch.driver_lat AS lat,
        ch.driver_lng AS lng,
        ch.update_position_driver AS gps_at
    FROM chauffeur ch
    WHERE ch.status = 'active'
      AND ch.driver_lat IS NOT NULL
      AND ch.driver_lng IS NOT NULL
      AND ch.update_position_driver >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
      AND ch.id NOT IN (
          SELECT driver_id FROM rides WHERE status IN ('accepted','arrived','started') AND driver_id IS NOT NULL
      )
");

$positions = [];
while ($row = $result->fetch_assoc()) {
    $row["id"]      = (int) $row["id"];
    $row["lat"]     = $row["lat"]  !== null ? (float) $row["lat"]  : null;
    $row["lng"]     = $row["lng"]  !== null ? (float) $row["lng"]  : null;
    $row["ride_id"] = $row["ride_id"] ? (int) $row["ride_id"] : null;
    $positions[]    = $row;
}
$conn->close();

// Ajouter aussi la colonne driver_lat/lng dans chauffeur si elle n'existe pas encore.
// ALTER TABLE chauffeur ADD COLUMN IF NOT EXISTS driver_lat DOUBLE NULL;
// ALTER TABLE chauffeur ADD COLUMN IF NOT EXISTS driver_lng DOUBLE NULL;
// ALTER TABLE chauffeur ADD COLUMN IF NOT EXISTS update_position_driver TIMESTAMP NULL;

json_response([
    "status"    => "success",
    "positions" => $positions,
    "ts"        => date("c")
]);
?>
