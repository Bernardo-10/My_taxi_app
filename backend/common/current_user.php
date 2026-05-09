<?php
require_once __DIR__ . "/../config/auth.php";

$role = $_SESSION["role"] ?? "";
$name = "";

if ($role === "client" && !empty($_SESSION["client_id"])) {
    $name = $_SESSION["client_name"] ?? "";
} elseif ($role === "chauffeur" && !empty($_SESSION["driver_id"])) {
    $name = $_SESSION["driver_name"] ?? "";
} else {
    json_response(["status" => "error", "message" => "Utilisateur non connecte"], 401);
}

json_response([
    "status" => "success",
    "user" => [
        "role" => $role,
        "name" => $name
    ]
]);
?>

