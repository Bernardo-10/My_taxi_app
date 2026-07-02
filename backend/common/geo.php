<?php
/**
 * geo.php — Fonctions géographiques partagées.
 * Réutilisé par arrive_ride.php (blocage 500m) et complete_ride.php
 * (confirmation 200m) pour éviter de dupliquer le calcul de distance.
 */

/**
 * Distance en mètres entre deux points GPS (formule de Haversine).
 */
function haversine_distance_meters(float $lat1, float $lng1, float $lat2, float $lng2): float {
    $earthRadius = 6371000; // rayon moyen de la Terre, en mètres

    $dLat = deg2rad($lat2 - $lat1);
    $dLng = deg2rad($lng2 - $lng1);

    $a = sin($dLat / 2) ** 2
       + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;

    $c = 2 * atan2(sqrt($a), sqrt(1 - $a));

    return $earthRadius * $c;
}
?>