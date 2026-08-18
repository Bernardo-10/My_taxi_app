<?php
require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$data = json_decode(file_get_contents("php://input"), true);
$driverId = (int) ($data["driver_id"] ?? 0);
$action = $data["action"] ?? "";
$reason = trim($data["reason"] ?? "");

if ($driverId <= 0) {
    json_response(["status" => "error", "message" => "driver_id requis"], 400);
}
if (!in_array($action, ["approve", "reject"])) {
    json_response(["status" => "error", "message" => "action doit être 'approve' ou 'reject'"], 400);
}
if ($action === "reject" && $reason === "") {
    json_response(["status" => "error", "message" => "Un motif est requis pour rejeter les documents"], 400);
}

$conn = db_connect();

$checkStmt = $conn->prepare("SELECT id FROM chauffeur WHERE id = ? LIMIT 1");
$checkStmt->bind_param("i", $driverId);
$checkStmt->execute();
$exists = $checkStmt->get_result()->num_rows > 0;
$checkStmt->close();

if (!$exists) {
    $conn->close();
    json_response(["status" => "error", "message" => "Chauffeur introuvable"], 404);
}

$newStatus = $action === "approve" ? "approved" : "rejected";
$reasonValue = $action === "approve" ? null : $reason;

$stmt = $conn->prepare("
    UPDATE chauffeur
    SET kyc_status = ?, kyc_rejection_reason = ?, kyc_reviewed_at = NOW()
    WHERE id = ?
");
$stmt->bind_param("ssi", $newStatus, $reasonValue, $driverId);
$stmt->execute();
$stmt->close();
$conn->close();

json_response([
    "status" => "success",
    "kyc_status" => $newStatus
]);
?>
