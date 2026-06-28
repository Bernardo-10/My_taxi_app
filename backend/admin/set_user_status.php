<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$data   = json_decode(file_get_contents("php://input"), true);
$type   = $data["type"]   ?? "";   // "client" | "chauffeur"
$id     = isset($data["id"]) ? (int)$data["id"] : 0;
$status = $data["status"] ?? "";   // "active" | "disabled"

if (!in_array($type, ["client", "chauffeur"])) {
    json_response(["status" => "error", "message" => "Type invalide"], 400);
}
if (!in_array($status, ["active", "disabled"])) {
    json_response(["status" => "error", "message" => "Statut invalide"], 400);
}
if ($id <= 0) {
    json_response(["status" => "error", "message" => "ID invalide"], 400);
}

$conn  = db_connect();
$table = $type === "client" ? "client" : "chauffeur";

// Quand l'admin désactive un chauffeur, le mettre automatiquement hors ligne
if ($type === "chauffeur" && $status === "disabled") {
    $stmt = $conn->prepare("UPDATE chauffeur SET status = ?, is_online = 0 WHERE id = ?");
    $stmt->bind_param("si", $status, $id);
} else {
    $stmt = $conn->prepare("UPDATE `$table` SET status = ? WHERE id = ?");
    $stmt->bind_param("si", $status, $id);
}

$stmt->execute();
$ok = $stmt->affected_rows > 0;
$stmt->close();
$conn->close();

json_response([
    "status"  => $ok ? "success" : "error",
    "message" => $ok ? "Statut mis a jour" : "Utilisateur introuvable"
]);
?>
