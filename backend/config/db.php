<?php
function db_connect() {
    $conn = new mysqli("localhost", "root", "", "taxi_app1");

    if ($conn->connect_error) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => "Erreur de connexion a la base"]);
        exit;
    }

    $conn->set_charset("utf8mb4");
    return $conn;
}
?>
