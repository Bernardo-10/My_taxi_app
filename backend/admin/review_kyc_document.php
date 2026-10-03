<?php
// Approuve/rejette UN SEUL document de l'examen KYC INITIAL (pas un
// renouvellement — voir review_document_renewal.php pour ça, système
// totalement séparé). Remplace l'ancien review_kyc.php qui traitait tout
// le dossier en bloc.
//
// Après chaque action, kyc_status est recalculé par recompute_kyc_status()
// (voir config/auth.php) selon la règle :
//   - au moins 1 document encore 'pending' -> dossier reste 'pending'
//   - les 5 'approved'                     -> dossier 'approved'
//   - les 5 traités, au moins 1 'rejected' -> dossier 'rejected'

require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$data           = json_decode(file_get_contents("php://input"), true);
$driverId       = (int) ($data["driver_id"] ?? 0);
$documentGroup  = trim($data["document_group"] ?? "");
$action         = $data["action"] ?? "";
$reason         = trim($data["reason"] ?? "");

$validGroups = ["cni", "carte_grise", "permit", "capacity", "license"];

if ($driverId <= 0) {
    json_response(["status" => "error", "message" => "driver_id requis"], 400);
}
if (!in_array($documentGroup, $validGroups, true)) {
    json_response(["status" => "error", "message" => "document_group invalide"], 400);
}
if (!in_array($action, ["approve", "reject"], true)) {
    json_response(["status" => "error", "message" => "action doit etre 'approve' ou 'reject'"], 400);
}
if ($action === "reject" && $reason === "") {
    json_response(["status" => "error", "message" => "Un motif est requis pour rejeter un document"], 400);
}

$conn = db_connect();

// La ligne doit exister et être encore 'pending' — même garde-fou que
// review_document_renewal.php (double-clic, deux admins simultanés).
$stmt = $conn->prepare("
    SELECT id, status FROM chauffeur_document_reviews
    WHERE chauffeur_id = ? AND document_group = ? LIMIT 1
");
$stmt->bind_param("is", $driverId, $documentGroup);
$stmt->execute();
$review = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$review) {
    $conn->close();
    json_response(["status" => "error", "message" => "Document introuvable pour ce chauffeur"], 404);
}
if ($review["status"] !== "pending") {
    $conn->close();
    json_response(["status" => "error", "message" => "Ce document a deja ete traite"], 409);
}

$newDocStatus = $action === "approve" ? "approved" : "rejected";
$reasonValue  = $action === "approve" ? null : $reason;

$upd = $conn->prepare("
    UPDATE chauffeur_document_reviews
    SET status = ?, rejection_reason = ?, reviewed_at = NOW()
    WHERE id = ?
");
$upd->bind_param("ssi", $newDocStatus, $reasonValue, $review["id"]);
$upd->execute();
$upd->close();

$dossierStatus = recompute_kyc_status($conn, $driverId);
$conn->close();

json_response([
    "status"          => "success",
    "document_status" => $newDocStatus,
    "kyc_status"       => $dossierStatus
]);
?>
