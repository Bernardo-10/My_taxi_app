<?php
require_once __DIR__ . "/../config/auth.php";

require_driver_id();
$data = json_decode(file_get_contents("php://input"), true);
$id = isset($data["id"]) ? (int) $data["id"] : 0;

if (!$id) {
    json_response(["status" => "error", "message" => "ID manquant"], 400);
}

$conn = db_connect();
$stmt = $conn->prepare("UPDATE rides SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
$stmt->bind_param("i", $id);
$stmt->execute();
$updated = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

json_response(["status" => $updated ? "ok" : "error"]);
?>

