<?php
// Reçoit une demande de renouvellement pour UN SEUL groupe de documents
// (cni, carte_grise, permit, capacity, license). N'écrit jamais dans les
// colonnes "live" de `chauffeur` — uniquement dans
// chauffeur_document_renewals, en attente de validation admin (voir
// rapport-kyc-chauffeur.md, §2 : l'ancien document reste celui qui
// compte pour le blocage à la mise en ligne tant que ce n'est pas
// approuvé).

require_once __DIR__ . "/../config/auth.php";
$driverId = require_driver_id();

// ── Groupe de document ─────────────────────────────────────────
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
$hasVerso = $documentGroup !== "carte_grise"; // seule la carte grise n'a qu'une photo

// ── Champs texte ────────────────────────────────────────────────
$number = trim($_POST["number"] ?? "");
$expiration = trim($_POST["expiration"] ?? "");

if ($number === "") {
    json_response(["status" => "error", "message" => "Numéro requis"], 400);
}

// Même validation que register_chauffeur.php : format Y-m-d, pas déjà
// expirée — resoumettre un document déjà périmé n'a pas de sens.
$expDate = DateTime::createFromFormat("Y-m-d", $expiration);
$dateErrors = DateTime::getLastErrors();
if (!$expDate || ($dateErrors && ($dateErrors["warning_count"] > 0 || $dateErrors["error_count"] > 0))) {
    json_response(["status" => "error", "message" => "Date d'expiration invalide"], 400);
}
if ($expDate < new DateTime("today")) {
    json_response(["status" => "error", "message" => "La nouvelle date d'expiration ne peut pas être déjà passée"], 400);
}
$expiration = $expDate->format("Y-m-d");

// ── Photos ──────────────────────────────────────────────────────
// Toujours une nouvelle photo recto exigée (pas de réutilisation d'un
// ancien fichier, pour éviter les incohérences si l'ancien renouvellement
// a été rejeté puis modifié entre-temps).
if (empty($_FILES["photo_recto"]) || $_FILES["photo_recto"]["error"] === UPLOAD_ERR_NO_FILE) {
    json_response(["status" => "error", "message" => "Photo recto requise"], 400);
}
if ($hasVerso && (empty($_FILES["photo_verso"]) || $_FILES["photo_verso"]["error"] === UPLOAD_ERR_NO_FILE)) {
    json_response(["status" => "error", "message" => "Photo verso requise"], 400);
}

$allowedMimes = [
    "image/jpeg" => "jpg",
    "image/png"  => "png",
    "image/webp" => "webp"
];
$maxFileSize = 8 * 1024 * 1024; // 8 Mo

function renewal_validate_upload(array $file, string $label): string {
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

$rectoMime = renewal_validate_upload($_FILES["photo_recto"], "recto");
$versoMime = $hasVerso ? renewal_validate_upload($_FILES["photo_verso"], "verso") : null;

// Même logique de compression/redimensionnement que register_chauffeur.php
// (dupliquée ici plutôt que partagée — chaque endpoint reste autonome,
// cohérent avec le reste du projet où escapeHtml() est dupliqué entre
// client-ui.js et chauffeur-ui.js plutôt qu'extrait en commun).
function renewal_compress_image(string $sourcePath, string $mimeType, string $destinationPath): bool {
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

// ── Base : vérifier l'état actuel du document pour ce groupe ────
$conn = db_connect();

// La ligne la plus récente pour ce (chauffeur, groupe) détermine le
// comportement : déjà 'pending' -> refus (le bouton "Modifier" est
// masqué côté frontend tant que c'est le cas, mais on protège aussi
// côté serveur) ; 'rejected' -> on réutilise la même ligne (repasse à
// pending) plutôt que d'en créer une nouvelle, pour ne pas accumuler
// un historique inutile de tentatives ; sinon (aucune ligne, ou la
// plus récente est 'approved') -> nouvelle ligne.
$existingStmt = $conn->prepare("
    SELECT id, status, photo_recto, photo_verso
    FROM chauffeur_document_renewals
    WHERE chauffeur_id = ? AND document_group = ?
    ORDER BY submitted_at DESC LIMIT 1
");
$existingStmt->bind_param("is", $driverId, $documentGroup);
$existingStmt->execute();
$existing = $existingStmt->get_result()->fetch_assoc();
$existingStmt->close();

if ($existing && $existing["status"] === "pending") {
    $conn->close();
    json_response(["status" => "error", "message" => "Un renouvellement est déjà en attente pour ce document"], 409);
}

// ── Stockage des nouvelles photos ────────────────────────────────
$uploadRoot = __DIR__ . "/../uploads/chauffeur_docs/" . $driverId;
if (!is_dir($uploadRoot) && !mkdir($uploadRoot, 0750, true)) {
    $conn->close();
    json_response(["status" => "error", "message" => "Impossible de créer le dossier des documents"], 500);
}

$rectoFilename = "renewal_{$documentGroup}_recto_" . bin2hex(random_bytes(6)) . "." . $allowedMimes[$rectoMime];
$rectoDestination = $uploadRoot . "/" . $rectoFilename;
if (!renewal_compress_image($_FILES["photo_recto"]["tmp_name"], $rectoMime, $rectoDestination)) {
    $conn->close();
    json_response(["status" => "error", "message" => "Échec de l'enregistrement de la photo recto"], 500);
}
$rectoRelativePath = "chauffeur_docs/$driverId/$rectoFilename";

$versoRelativePath = null;
if ($hasVerso) {
    $versoFilename = "renewal_{$documentGroup}_verso_" . bin2hex(random_bytes(6)) . "." . $allowedMimes[$versoMime];
    $versoDestination = $uploadRoot . "/" . $versoFilename;
    if (!renewal_compress_image($_FILES["photo_verso"]["tmp_name"], $versoMime, $versoDestination)) {
        @unlink($rectoDestination); // nettoyage du recto déjà écrit
        $conn->close();
        json_response(["status" => "error", "message" => "Échec de l'enregistrement de la photo verso"], 500);
    }
    $versoRelativePath = "chauffeur_docs/$driverId/$versoFilename";
}

// ── Écriture en base (insert ou réutilisation d'une ligne rejetée) ──
if ($existing && $existing["status"] === "rejected") {
    $stmt = $conn->prepare("
        UPDATE chauffeur_document_renewals
        SET number = ?, expiration = ?, photo_recto = ?, photo_verso = ?,
            status = 'pending', rejection_reason = NULL,
            submitted_at = NOW(), reviewed_at = NULL
        WHERE id = ?
    ");
    $stmt->bind_param("ssssi", $number, $expiration, $rectoRelativePath, $versoRelativePath, $existing["id"]);
    $ok = $stmt->execute();
    $stmt->close();

    // Nettoyage des anciennes photos rejetées, une fois la nouvelle ligne
    // écrite avec succès (best-effort, non bloquant en cas d'échec).
    if ($ok) {
        if (!empty($existing["photo_recto"])) @unlink(__DIR__ . "/../uploads/" . $existing["photo_recto"]);
        if (!empty($existing["photo_verso"])) @unlink(__DIR__ . "/../uploads/" . $existing["photo_verso"]);
    }
} else {
    $stmt = $conn->prepare("
        INSERT INTO chauffeur_document_renewals
            (chauffeur_id, document_group, number, expiration, photo_recto, photo_verso, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
    ");
    $stmt->bind_param("isssss", $driverId, $documentGroup, $number, $expiration, $rectoRelativePath, $versoRelativePath);
    $ok = $stmt->execute();
    $stmt->close();
}

if (!$ok) {
    @unlink($rectoDestination);
    if ($versoRelativePath) @unlink($uploadRoot . "/" . basename($versoRelativePath));
    $conn->close();
    json_response(["status" => "error", "message" => "Échec de l'enregistrement du renouvellement"], 500);
}

$conn->close();
json_response([
    "status" => "success",
    "message" => "Renouvellement envoyé pour : " . $groupLabels[$documentGroup]
]);
?>
