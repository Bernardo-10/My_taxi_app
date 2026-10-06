<?php
require_once __DIR__ . "/../config/auth.php";

$userId = require_client_id();
$conn = db_connect();

// Colonnes explicites (et non SELECT *) : le client ne doit recevoir que ce
// que l'historique affiche. Un SELECT * renvoyait aussi problem_description
// (signalement écrit par le chauffeur), driver_id, la dernière position du
// chauffeur et les horodatages internes. Pour exposer un nouveau champ au
// front, l'ajouter ici volontairement.
// 'reported' (course signalée par le chauffeur) est inclus pour qu'elle apparaisse
// dans l'historique avec le libellé « Signalée » ; problem_description, lui,
// reste volontairement jamais renvoyé au client.
$stmt = $conn->prepare("
    SELECT id, status, pickup, destination,
           distance_km, price_fcfa, passengers, created_at
    FROM rides
    WHERE user_id = ?
      AND status IN ('pending', 'accepted', 'arrived', 'completed', 'cancelled', 'cancelled_client', 'started', 'reported')
    ORDER BY created_at DESC
");
$stmt->bind_param("i", $userId);
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
