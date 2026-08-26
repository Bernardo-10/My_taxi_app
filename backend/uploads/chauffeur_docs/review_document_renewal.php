<?php
// Traite une ligne de chauffeur_document_renewals. Contrairement à
// review_kyc.php (qui agit sur le dossier KYC entier), celui-ci ne
// touche qu'UN SEUL document — le reste du dossier du chauffeur n'est
// jamais affecté (voir rapport-kyc-chauffeur.md, §2).

require_once __DIR__ . "/../config/auth.php";
require_admin_id();

$data = json_decode(file_get_contents("php://input"), true);
$renewalId = (int) ($data["renewal_id"] ?? 0);
$action = $data["action"] ?? "";
$reason = trim($data["reason"] ?? "");

if ($renewalId <= 0) {
    json_response(["status" => "error", "message" => "renewal_id requis"], 400);
}
if (!in_array($action, ["approve", "reject"], true)) {
    json_response(["status" => "error", "message" => "action doit être 'approve' ou 'reject'"], 400);
}
if ($action === "reject" && $reason === "") {
    json_response(["status" => "error", "message" => "Un motif est requis pour rejeter un renouvellement"], 400);
}

// Mapping colonne(s) live par groupe de document — la carte grise n'a
// qu'une seule photo et un nom de colonne "immat" plutôt que "number",
// donc pas de raccourci générique possible ici.
$columnMap = [
    "cni"         => ["number" => "cni_number",         "expiration" => "cni_expiration",         "recto" => "cni_photo_recto",         "verso" => "cni_photo_verso"],
    "carte_grise" => ["number" => "carte_grise_immat",  "expiration" => "carte_grise_expiration", "recto" => "carte_grise_photo",       "verso" => null],
    "permit"      => ["number" => "permit_number",      "expiration" => "permit_expiration",      "recto" => "permit_photo_recto",      "verso" => "permit_photo_verso"],
    "capacity"    => ["number" => "capacity_number",    "expiration" => "capacity_expiration",    "recto" => "capacity_photo_recto",    "verso" => "capacity_photo_verso"],
    "license"     => ["number" => "license_number",     "expiration" => "license_expiration",     "recto" => "license_photo_recto",     "verso" => "license_photo_verso"]
];

$conn = db_connect();

// La ligne doit exister et être encore 'pending' — protège contre un
// double-clic ou deux admins qui traiteraient la même ligne en même
// temps (le second échoue proprement plutôt que d'écraser silencieusement).
$stmt = $conn->prepare("
    SELECT id, chauffeur_id, document_group, number, expiration, photo_recto, photo_verso, status
    FROM chauffeur_document_renewals WHERE id = ? LIMIT 1
");
$stmt->bind_param("i", $renewalId);
$stmt->execute();
$renewal = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$renewal) {
    $conn->close();
    json_response(["status" => "error", "message" => "Renouvellement introuvable"], 404);
}
if ($renewal["status"] !== "pending") {
    $conn->close();
    json_response(["status" => "error", "message" => "Ce renouvellement a déjà été traité"], 409);
}
if (!isset($columnMap[$renewal["document_group"]])) {
    $conn->close();
    json_response(["status" => "error", "message" => "Groupe de document invalide en base"], 500);
}

$cols = $columnMap[$renewal["document_group"]];

if ($action === "reject") {
    $stmt = $conn->prepare("
        UPDATE chauffeur_document_renewals
        SET status = 'rejected', rejection_reason = ?, reviewed_at = NOW()
        WHERE id = ?
    ");
    $stmt->bind_param("si", $reason, $renewalId);
    $stmt->execute();
    $stmt->close();
    $conn->close();
    json_response(["status" => "success", "renewal_status" => "rejected"]);
}

// ── Approbation : copie vers les colonnes live du chauffeur ─────
// Récupère d'abord les anciens chemins de photos, pour nettoyage après
// écrasement (best-effort, non bloquant — cf. même logique que
// submit_document_renewal.php).
$oldPhotosStmt = $conn->prepare("SELECT {$cols['recto']} AS old_recto" .
    ($cols['verso'] ? ", {$cols['verso']} AS old_verso" : "") .
    " FROM chauffeur WHERE id = ? LIMIT 1");
$oldPhotosStmt->bind_param("i", $renewal["chauffeur_id"]);
$oldPhotosStmt->execute();
$oldPhotos = $oldPhotosStmt->get_result()->fetch_assoc();
$oldPhotosStmt->close();

// Construction dynamique de la requête — les noms de colonnes viennent
// exclusivement du tableau $columnMap ci-dessus (jamais d'entrée
// utilisateur), donc pas de risque d'injection malgré l'interpolation.
if ($cols["verso"]) {
    $sql = "UPDATE chauffeur SET {$cols['number']} = ?, {$cols['expiration']} = ?, {$cols['recto']} = ?, {$cols['verso']} = ? WHERE id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param("ssssi", $renewal["number"], $renewal["expiration"], $renewal["photo_recto"], $renewal["photo_verso"], $renewal["chauffeur_id"]);
} else {
    // Carte grise : pas de colonne verso à mettre à jour.
    $sql = "UPDATE chauffeur SET {$cols['number']} = ?, {$cols['expiration']} = ?, {$cols['recto']} = ? WHERE id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param("sssi", $renewal["number"], $renewal["expiration"], $renewal["photo_recto"], $renewal["chauffeur_id"]);
}
$updateOk = $stmt->execute();
$stmt->close();

if (!$updateOk) {
    $conn->close();
    json_response(["status" => "error", "message" => "Échec de la mise à jour du dossier chauffeur"], 500);
}

$reviewStmt = $conn->prepare("
    UPDATE chauffeur_document_renewals
    SET status = 'approved', reviewed_at = NOW()
    WHERE id = ?
");
$reviewStmt->bind_param("i", $renewalId);
$reviewStmt->execute();
$reviewStmt->close();
$conn->close();

// Nettoyage des anciennes photos désormais remplacées — après le commit
// en base, jamais avant (si l'UPDATE avait échoué, on ne veut pas avoir
// déjà supprimé les anciens fichiers).
$uploadsRoot = __DIR__ . "/../uploads/";
if (!empty($oldPhotos["old_recto"])) @unlink($uploadsRoot . $oldPhotos["old_recto"]);
if (!empty($oldPhotos["old_verso"] ?? null)) @unlink($uploadsRoot . $oldPhotos["old_verso"]);

json_response(["status" => "success", "renewal_status" => "approved"]);
?>
