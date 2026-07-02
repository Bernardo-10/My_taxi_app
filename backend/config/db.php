<?php
function db_connect() {
    $creds = require __DIR__ . "/credentials.php";

    $conn = new mysqli(
        $creds["db_host"],
        $creds["db_user"],
        $creds["db_pass"],
        $creds["db_name"]
    );

    if ($conn->connect_error) {
        http_response_code(500);
        echo json_encode(["status" => "error", "message" => "Erreur de connexion a la base"]);
        exit;
    }

    $conn->set_charset("utf8mb4");
    return $conn;
}
?>
