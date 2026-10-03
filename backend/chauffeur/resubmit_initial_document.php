<?php
// Resoumission d'UN document REJETÉ pendant l'examen KYC INITIAL (dossier
// jamais encore approuvé une première fois). Différent de
// submit_document_renewal.php : ici on écrase directement les colonnes
// "live" de `chauffeur`, car le document rejeté n'a jamais été validé —
// rien à protéger le temps de l'examen, contrairement à un renouvellement
// qui remplace un document déjà approuvé (celui-là reste en staging dans
// chauffeur_document_renewals jusqu'à validation admin).
//
// Garde-fou strict (demande explicite) : la ligne
// chauffeur_document_reviews doit être EXACTEMENT 'rejected'. Ni
// 'pending' (rien à corriger, en attente d'un premier examen), ni
// 'approved' (passer par le renouvellement, pas par ici).

require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";
$driverId = require_driver_id();

$validGroups = ["cni", "carte_grise", "permit", "capacity", "license"];
$documentGroup = trim($_POST["document_group"] ?? "");

if (!in_array($documentGroup, $validGroups, true)) {
    json_response(["status" => "error", "message" => "Document invalide"], 400);
}

$groupLabels = [
    "cni" => "CNI",
    "carte_grise" => "Carte grise",
    "permit" => "Permis de conduire",
    "capacity" => "Carte de capacité",
    "license" => "Licence professionnelle"
];
$hasVerso = $documentGroup !== "carte_grise";

$number = trim($_POST["number"] ?? "");
$expiration = trim($_POST["expiration"] ?? "");

if ($number === "") {
    json_response(["status" => "error", "message" => "Numéro requis"], 400);
}

$expDate = DateTime::createFromFormat("Y-m-d", $expiration);
$dateErrors = DateTime::getLastErrors();
if (!$expDate || ($dateErrors && ($dateErrors["warning_count"] > 0 || $dateErrors["error_count"] > 0))) {
    json_response(["status" => "error", "message" => "Date d'expiration invalide"], 400);
}
if ($expDate < new DateTime("today")) {
    json_response(["status" => "error", "message" => "La date d'expiration ne peut pas être déjà passée"], 400);
}
$expiration = $expDate->format("Y-m-d");

if (empty($_FILES["photo_recto"]) || $_FILES["photo_recto"]["error"] === UPLOAD_ERR_NO_FILE) {
    json_response(["status" => "error", "message" => "Photo recto requise"], 400);
}
if ($hasVerso && (empty($_FILES["photo_verso"]) || $_FILES["photo_verso"]["error"] === UPLOAD_ERR_NO_FILE)) {
    json_response(["status" => "error", "message" => "Photo verso requise"], 400);
}

$allowedMimes = ["image/jpeg" => "jpg", "image/png" => "png", "image/webp" => "webp"];
$maxFileSize = 8 * 1024 * 1024;

function initial_doc_validate_upload(array $file, string $label): string {
    global $allowedMimes, $maxFileSize;
    if ($file["error"] !== UPLOAD_ERR_OK) {
        json_response(["status" => "error", "message" => "Échec de l'envoi de la photo : $label"], 400);
    }
    if ($file["size"] > $maxFileSize) {
        json_response(["status" => "error", "message" => "Photo trop volumineuse (8 Mo max) : $label"], 400);
    }
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $file["tmp_name"]);
    finfo_close($finfo);
    if (!isset($allowedMimes[$mime])) {
        json_response(["status" => "error", "message" => "Format non supporté : $label (JPEG, PNG ou WEBP uniquement)"], 400);
    }
    return $mime;
}

$rectoMime = initial_doc_validate_upload($_FILES["photo_recto"], "recto");
$versoMime = $hasVerso ? initial_doc_validate_upload($_FILES["photo_verso"], "verso") : null;

// Même compression que submit_document_renewal.php / register_chauffeur.php
// (dupliquée volontairement — chaque endpoint reste autonome, cf.
// convention déjà en place dans ce projet).
function initial_doc_compress_image(string $sourcePath, string $mimeType, string $destinationPath): bool {
    if (!function_exists("imagecreatefromstring")) {
        return move_uploaded_file($sourcePath, $destinationPath);
    }
    $sourceData = @file_get_contents($sourcePath);
    if ($sourceData === false) {
        return move_uploaded_file($sourcePath, $destinationPath);
    }
    $image = @imagecreatefromstring($sourceData);
    if ($image === false) {
        return move_uploaded_file($sourcePath, $destinationPath);
    }
    $width = imagesx($image);
    $height = imagesy($image);
    $maxSide = 1400;
    if ($width > $maxSide || $height > $maxSide) {
        $ratio = min($maxSide / $width, $maxSide / $height);
        $newWidth = max(1, (int) round($width * $ratio));
        $newHeight = max(1, (int) round($height * $ratio));
        $resized = imagecreatetruecolor($newWidth, $newHeight);
        imagecopyresampled($resized, $image, 0, 0, 0, 0, $newWidth, $newHeight, $width, $height);
        imagedestroy($image);
        $image = $resized;
    }
    $result = false;
    if ($mimeType === "image/jpeg") {
        $result = imagejpeg($image, $destinationPath, 75);
    } elseif ($mimeType === "image/webp" && function_exists("imagewebp")) {
        $result = imagewebp($image, $destinationPath, 75);
    } elseif ($mimeType === "image/png" && function_exists("imagepng")) {
        $result = imagepng($image, $destinationPath, 7);
    }
    imagedestroy($image);
    if ($result === true) {
        @unlink($sourcePath);
        return true;
    }
    return move_uploaded_file($sourcePath, $destinationPath);
}

$conn = db_connect();

// ── Garde-fou : le document doit être EXACTEMENT 'rejected' ──────
$reviewStmt = $conn->prepare("
    SELECT id, status FROM chauffeur_document_reviews
    WHERE chauffeur_id = ? AND document_group = ? LIMIT 1
");
$reviewStmt->bind_param("is", $driverId, $documentGroup);
$reviewStmt->execute();
$review = $reviewStmt->get_result()->fetch_assoc();
$reviewStmt->close();

if (!$review) {
    $conn->close();
    json_response(["status" => "error", "message" => "Document introuvable"], 404);
}
if ($review["status"] !== "rejected") {
    $conn->close();
    $msg = $review["status"] === "pending"
        ? "Ce document est déjà en attente d'examen, rien à corriger pour l'instant."
        : "Ce document est déjà approuvé. Pour le modifier, utilisez le renouvellement depuis \"Mes documents\".";
    json_response(["status" => "error", "message" => $msg], 409);
}

// ── Photos ─────────────────────────────────────────────────────
$uploadRoot = __DIR__ . "/../uploads/chauffeur_docs/" . $driverId;
if (!is_dir($uploadRoot) && !mkdir($uploadRoot, 0750, true)) {
    $conn->close();
    json_response(["status" => "error", "message" => "Impossible de créer le dossier des documents"], 500);
}

$rectoFilename = "{$documentGroup}_recto_" . bin2hex(random_bytes(6)) . "." . $allowedMimes[$rectoMime];
$rectoDestination = $uploadRoot . "/" . $rectoFilename;
if (!initial_doc_compress_image($_FILES["photo_recto"]["tmp_name"], $rectoMime, $rectoDestination)) {
    $conn->close();
    json_response(["status" => "error", "message" => "Échec de l'enregistrement de la photo recto"], 500);
}
$rectoRelativePath = "chauffeur_docs/$driverId/$rectoFilename";

$versoRelativePath = null;
if ($hasVerso) {
    $versoFilename = "{$documentGroup}_verso_" . bin2hex(random_bytes(6)) . "." . $allowedMimes[$versoMime];
    $versoDestination = $uploadRoot . "/" . $versoFilename;
    if (!initial_doc_compress_image($_FILES["photo_verso"]["tmp_name"], $versoMime, $versoDestination)) {
        @unlink($rectoDestination);
        $conn->close();
        json_response(["status" => "error", "message" => "Échec de l'enregistrement de la photo verso"], 500);
    }
    $versoRelativePath = "chauffeur_docs/$driverId/$versoFilename";
}

// ── Colonnes live à écraser, par groupe (même mapping que
// review_document_renewal.php pour rester cohérent) ──────────────
$columnMap = [
    "cni"         => ["number" => "cni_number",         "expiration" => "cni_expiration",         "recto" => "cni_photo_recto",         "verso" => "cni_photo_verso"],
    "carte_grise" => ["number" => "carte_grise_immat",  "expiration" => "carte_grise_expiration", "recto" => "carte_grise_photo",       "verso" => null],
    "permit"      => ["number" => "permit_number",      "expiration" => "permit_expiration",      "recto" => "permit_photo_recto",      "verso" => "permit_photo_verso"],
    "capacity"    => ["number" => "capacity_number",    "expiration" => "capacity_expiration",    "recto" => "capacity_photo_recto",    "verso" => "capacity_photo_verso"],
    "license"     => ["number" => "license_number",     "expiration" => "license_expiration",     "recto" => "license_photo_recto",     "verso" => "license_photo_verso"]
];
$cols = $columnMap[$documentGroup];

$oldRecto = null;
$oldVerso = null;
if ($hasVerso) {
    $sql = "UPDATE chauffeur SET {$cols['number']} = ?, {$cols['expiration']} = ?, {$cols['recto']} = ?, {$cols['verso']} = ? WHERE id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param("ssssi", $number, $expiration, $rectoRelativePath, $versoRelativePath, $driverId);
} else {
    $sql = "UPDATE chauffeur SET {$cols['number']} = ?, {$cols['expiration']} = ?, {$cols['recto']} = ? WHERE id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param("sssi", $number, $expiration, $rectoRelativePath, $driverId);
}

if (!$stmt->execute()) {
    $stmt->close();
    @unlink($rectoDestination);
    if ($versoRelativePath) @unlink($uploadRoot . "/" . basename($versoRelativePath));
    $conn->close();
    json_response(["status" => "error", "message" => "Échec de l'enregistrement du document"], 500);
}
$stmt->close();

// ── Remet la ligne d'examen à 'pending' pour un nouveau passage admin ──
$resetStmt = $conn->prepare("
    UPDATE chauffeur_document_reviews
    SET status = 'pending', rejection_reason = NULL, reviewed_at = NULL
    WHERE id = ?
");
$resetStmt->bind_param("i", $review["id"]);
$resetStmt->execute();
$resetStmt->close();

$dossierStatus = recompute_kyc_status($conn, $driverId);

// Alerte admin (son+vibration si onglet ouvert, push sinon) — best-effort.
send_push_to_all_admins(
    $conn,
    "Document corrigé à revérifier",
    "Un chauffeur a resoumis : " . $groupLabels[$documentGroup],
    ["link" => "/admin/#kyc"]
);

$conn->close();

json_response([
    "status" => "success",
    "message" => "Document resoumis : " . $groupLabels[$documentGroup],
    "kyc_status" => $dossierStatus
]);
?>
