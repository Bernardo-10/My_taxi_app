<?php
header("Content-Type: application/json");

// Ce fichier simule la mise a jour GPS du chauffeur.
// En production, la vraie app chauffeur appellera update_ride_driver_position.php
// avec les vraies coordonnees GPS.
// NE PAS utiliser mt_rand() ici - cela fait bouger le marqueur artificiellement.

$conn = new mysqli("localhost", "root", "", "taxi_app1");

if ($conn->connect_error) {
    echo json_encode(["status" => "error", "message" => "Erreur de connexion"]);
    exit;
}

// Pour la demo : on ne touche pas aux positions existantes.
// La position initiale est definie dans accept_ride.php.
// La mise a jour reelle se fait via update_ride_driver_position.php (GPS chauffeur).

echo json_encode([
    "status"  => "success",
    "message" => "Positions inchangees (simulation desactivee - utiliser GPS reel)"
]);

$conn->close();
?>
