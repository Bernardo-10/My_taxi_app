<?php
require_once __DIR__ . "/../config/auth.php";

// ── Complétion du profil chauffeur (documents KYC) ────────────────
// Nouveau fichier — voir rapport friction-inscription-chauffeur.md.
// Reprend telle quelle la validation/compression/stockage des documents
// qui vivait auparavant dans register_chauffeur.php (rien n'a changé
// dans les règles : mêmes champs, mêmes formats, mêmes tailles), mais :
//   - le chauffeur doit être connecté (require_driver_id()) — ce n'est
//     plus une étape de création de compte ;
//   - les 5 groupes de documents sont TOUJOURS envoyés en un seul bloc
//     ici (contrairement à submit_document_renewal.php qui traite un
//     groupe à la fois) car il s'agit d'une première soumission complète,
//     pas d'un renouvellement ciblé — on reste sur le même contrat que
//     l'admin connaît déjà (review_kyc.php approuve/rejette tout le
//     dossier en un bloc, comme avant) ;
//   - à la fin, kyc_status passe de 'incomplete' à 'pending' : c'est
//     précisément le moment où le dossier doit apparaître dans la file
//     d'attente admin (list_pending_kyc.php filtre déjà sur ce statut,
//     aucun changement nécessaire côté admin).
//
// Un chauffeur dont le kyc_status n'est plus 'incomplete' (déjà pending,
// approved, ou rejected) doit passer par submit_document_renewal.php
// pour corriger un document précis — pas par ce point d'entrée, qui
// exige le dossier complet.

require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/send_push.php";
$driverId = require_driver_id();

$conn = db_connect();

$statusStmt = $conn->prepare("SELECT kyc_status FROM chauffeur WHERE id = ? LIMIT 1");
$statusStmt->bind_param("i", $driverId);
$statusStmt->execute();
$statusRow = $statusStmt->get_result()->fetch_assoc();
$statusStmt->close();

if (!$statusRow) {
    $conn->close();
    json_response(["status" => "error", "message" => "Chauffeur introuvable"], 404);
}

if ($statusRow["kyc_status"] !== "incomplete") {
    $conn->close();
    json_response([
        "status" => "error",
        "message" => "Votre profil est deja complet. Pour corriger un document, utilisez le renouvellement depuis \"Mes documents\"."
    ], 409);
}

// ── Documents : tous obligatoires (numéro + date d'expiration) ──
// Identique à l'ancienne validation de register_chauffeur.php.
$requiredTextFields = [
    "cni_number"             => "Numéro de CNI",
    "cni_expiration"         => "Date d'expiration de la CNI",
    "carte_grise_immat"      => "Numéro d'immatriculation (carte grise)",
    "carte_grise_expiration" => "Date d'expiration de la carte grise",
    "permit_number"          => "Numéro de permis",
    "permit_expiration"      => "Date d'expiration du permis",
    "capacity_number"        => "Numéro de carte de capacité",
    "capacity_expiration"    => "Date d'expiration de la carte de capacité",
    "license_number"         => "Numéro de licence",
    "license_expiration"     => "Date d'expiration de la licence",
];

$textValues = [];
foreach ($requiredTextFields as $field => $label) {
    $value = trim($_POST[$field] ?? "");
    if ($value === "") {
        $conn->close();
        json_response(["status" => "error", "message" => "Champ requis manquant : $label"], 400);
    }
    $textValues[$field] = $value;
}

function validate_expiration_date(string $value, string $label): string {
    $date = DateTime::createFromFormat("Y-m-d", $value);
    $errors = DateTime::getLastErrors();
    if (!$date || ($errors && ($errors["warning_count"] > 0 || $errors["error_count"] > 0))) {
        json_response(["status" => "error", "message" => "Date invalide : $label"], 400);
    }
    $today = new DateTime("today");
    if ($date < $today) {
        json_response(["status" => "error", "message" => "Document expiré : $label"], 400);
    }
    return $date->format("Y-m-d");
}

$textValues["cni_expiration"]         = validate_expiration_date($textValues["cni_expiration"], "CNI");
$textValues["carte_grise_expiration"] = validate_expiration_date($textValues["carte_grise_expiration"], "Carte grise");
$textValues["permit_expiration"]      = validate_expiration_date($textValues["permit_expiration"], "Permis");
$textValues["capacity_expiration"]    = validate_expiration_date($textValues["capacity_expiration"], "Carte de capacité");
$textValues["license_expiration"]     = validate_expiration_date($textValues["license_expiration"], "Licence");

// ── Photos : 9 fichiers obligatoires ──────────────────────────────
$documentFields = [
    "cni_photo_recto"      => "CNI (recto)",
    "cni_photo_verso"      => "CNI (verso)",
    "carte_grise_photo"    => "Carte grise",
    "permit_photo_recto"   => "Permis de conduire (recto)",
    "permit_photo_verso"   => "Permis de conduire (verso)",
    "capacity_photo_recto" => "Carte de capacite (recto)",
    "capacity_photo_verso" => "Carte de capacite (verso)",
    "license_photo_recto"  => "Licence de chauffeur (recto)",
    "license_photo_verso"  => "Licence de chauffeur (verso)"
];

$allowedMimes = [
    "image/jpeg" => "jpg",
    "image/png"  => "png",
    "image/webp" => "webp"
];
$maxFileSize = 8 * 1024 * 1024; // 8 Mo

function compress_uploaded_image(string $sourcePath, string $mimeType, string $destinationPath): bool {
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

foreach ($documentFields as $field => $label) {
    if (empty($_FILES[$field]) || $_FILES[$field]["error"] === UPLOAD_ERR_NO_FILE) {
        $conn->close();
        json_response(["status" => "error", "message" => "Photo requise manquante : $label"], 400);
    }
    if ($_FILES[$field]["error"] !== UPLOAD_ERR_OK) {
        $conn->close();
        json_response(["status" => "error", "message" => "Echec de l'envoi de la photo : $label"], 400);
    }
    if ($_FILES[$field]["size"] > $maxFileSize) {
        $conn->close();
        json_response(["status" => "error", "message" => "Photo trop volumineuse (8 Mo max) : $label"], 400);
    }

    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $_FILES[$field]["tmp_name"]);
    finfo_close($finfo);

    if (!isset($allowedMimes[$mime])) {
        $conn->close();
        json_response(["status" => "error", "message" => "Format non supporte pour : $label (JPEG, PNG ou WEBP uniquement)"], 400);
    }
}

// ── Stockage des photos : backend/uploads/chauffeur_docs/{driverId}/ ──
$uploadRoot = __DIR__ . "/../uploads/chauffeur_docs/" . $driverId;

if (!is_dir($uploadRoot) && !mkdir($uploadRoot, 0750, true)) {
    $conn->close();
    json_response(["status" => "error", "message" => "Impossible de creer le dossier des documents"], 500);
}

$storedPaths = [
    "cni_photo_recto" => null, "cni_photo_verso" => null,
    "carte_grise_photo" => null,
    "permit_photo_recto" => null, "permit_photo_verso" => null,
    "capacity_photo_recto" => null, "capacity_photo_verso" => null,
    "license_photo_recto" => null, "license_photo_verso" => null
];

foreach ($documentFields as $field => $label) {
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $_FILES[$field]["tmp_name"]);
    finfo_close($finfo);
    $ext = $allowedMimes[$mime];

    $filename = $field . "_" . bin2hex(random_bytes(6)) . "." . $ext;
    $destination = $uploadRoot . "/" . $filename;

    if (!compress_uploaded_image($_FILES[$field]["tmp_name"], $mime, $destination)) {
        // Nettoyage en cas d'echec partiel des photos déjà déplacées —
        // on ne supprime pas le compte (contrairement à l'inscription :
        // ici le compte existe déjà et le chauffeur doit pouvoir réessayer).
        foreach ($storedPaths as $path) {
            if ($path !== null) {
                @unlink($uploadRoot . "/" . basename($path));
            }
        }
        $conn->close();
        json_response(["status" => "error", "message" => "Echec de l'enregistrement de la photo : $label"], 500);
    }

    $storedPaths[$field] = "chauffeur_docs/$driverId/$filename";
}

// ── Écriture en base : documents + passage en 'pending' ──────────
$updateStmt = $conn->prepare("
    UPDATE chauffeur SET
        cni_number = ?, cni_expiration = ?,
        cni_photo_recto = ?, cni_photo_verso = ?,
        carte_grise_immat = ?, carte_grise_expiration = ?, carte_grise_photo = ?,
        permit_number = ?, permit_expiration = ?,
        permit_photo_recto = ?, permit_photo_verso = ?,
        capacity_number = ?, capacity_expiration = ?,
        capacity_photo_recto = ?, capacity_photo_verso = ?,
        license_number = ?, license_expiration = ?,
        license_photo_recto = ?, license_photo_verso = ?,
        kyc_status = 'pending', kyc_rejection_reason = NULL, kyc_reviewed_at = NULL
    WHERE id = ?
");
$updateStmt->bind_param(
    "sssssssssssssssssssi",
    $textValues["cni_number"], $textValues["cni_expiration"],
    $storedPaths["cni_photo_recto"], $storedPaths["cni_photo_verso"],
    $textValues["carte_grise_immat"], $textValues["carte_grise_expiration"], $storedPaths["carte_grise_photo"],
    $textValues["permit_number"], $textValues["permit_expiration"],
    $storedPaths["permit_photo_recto"], $storedPaths["permit_photo_verso"],
    $textValues["capacity_number"], $textValues["capacity_expiration"],
    $storedPaths["capacity_photo_recto"], $storedPaths["capacity_photo_verso"],
    $textValues["license_number"], $textValues["license_expiration"],
    $storedPaths["license_photo_recto"], $storedPaths["license_photo_verso"],
    $driverId
);

if (!$updateStmt->execute()) {
    $updateStmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Echec de l'enregistrement du profil"], 500);
}
$updateStmt->close();

// Alerte admin (son+vibration si onglet ouvert, push sinon) — best-effort,
// ne doit jamais faire échouer la complétion du profil elle-même.
send_push_to_all_admins(
    $conn,
    "Nouveau dossier chauffeur à vérifier",
    "Un chauffeur a complété son profil et attend la validation KYC.",
    ["link" => "/admin/#kyc"]
);

$conn->close();

json_response([
    "status" => "success",
    "message" => "Documents recus. Verification en cours.",
    "kyc_status" => "pending"
]);
?>
