<?php
// Source unique de vérité pour le calcul d'itinéraire et de prix.
// Utilisé par backend/client/backend.php (création de course) et pourra
// être réutilisé pour une vérification a posteriori si besoin.

define("OSRM_BASE_URL", "https://router.project-osrm.org"); // à changer en une ligne après migration
define("PRICE_PER_KM_FCFA", 75);

function compute_route(float $fromLat, float $fromLng, float $toLat, float $toLng): ?array {
    $url = OSRM_BASE_URL . "/route/v1/driving/{$fromLng},{$fromLat};{$toLng},{$toLat}?overview=false";

    $ctx = stream_context_create(["http" => ["timeout" => 8]]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false) return null;

    $data = json_decode($raw, true);
    if (empty($data["routes"][0])) return null;

    return [
        "distance_km"  => round($data["routes"][0]["distance"] / 1000, 2),
        "duration_min" => (int) round($data["routes"][0]["duration"] / 60),
    ];
}

function compute_price(float $distanceKm, int $passengers): int {
    return (int) round($distanceKm * PRICE_PER_KM_FCFA * $passengers);
}
?>