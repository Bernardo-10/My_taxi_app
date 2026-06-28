<?php
require_once __DIR__ . "/../config/auth.php";

$adminId = require_admin_id();
$conn    = db_connect();
$stmt    = $conn->prepare("SELECT id, username, email FROM admin WHERE id = ?");
$stmt->bind_param("i", $adminId);
$stmt->execute();
$admin = $stmt->get_result()->fetch_assoc();
$stmt->close();
$conn->close();

if (!$admin) {
    json_response(["status" => "error", "message" => "Admin introuvable"], 404);
}
$admin["id"] = (int)$admin["id"];
json_response(["status" => "success", "admin" => $admin]);
?>
