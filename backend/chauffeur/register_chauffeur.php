<?php
require_once __DIR__ . "/../config/auth.php";

// Le formulaire d'inscription envoie un FormData (champs texte + fichiers
// photo), donc on lit $_POST / $_FILES au lieu du JSON brut.

// ── Champs de base ──────────────────────────────────────────────
$name = trim($_POST["name"] ?? "");
$phone = trim($_POST["phone"] ?? "");
$email = trim($_POST["email"] ?? "");
$password = $_POST["password"] ?? "";
$passwordConfirm = $_POST["password_confirm"] ?? "";
$plate = trim($_POST["plate"] ?? "");
$carBrand = trim($_POST["car_brand"] ?? "");
$carColor = trim($_POST["car_color"] ?? "");

if ($name === "" || $phone === "" || $email === "" || $password === "" || $plate === "") {
    json_response(["status" => "error", "message" => "Nom, telephone, email, plaque et mot de passe requis"], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_response(["status" => "error", "message" => "Email invalide"], 400);
}

if (strlen($password) < 6) {
    json_response(["status" => "error", "message" => "Le mot de passe doit contenir au moins 6 caracteres"], 400);
}

if ($password !== $passwordConfirm) {
    json_response(["status" => "error", "message" => "Les deux mots de passe ne correspondent pas"], 400);
}

// ── Documents : tous obligatoires (numéro + date d'expiration) ──
// Contrairement à une version précédente, plus aucun document n'est
// facultatif : la vérification (KYC) démarre dès l'inscription, mais
// reste "pending" tant qu'un admin n'a pas validé (voir plus bas).
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
        json_response(["status" => "error", "message" => "Champ requis manquant : $label"], 400);
    }
    $textValues[$field] = $value;
}

// Valide qu'une date est au format Y-m-d et n'est pas déjà expirée —
// un document déjà périmé au moment de l'inscription n'a pas de sens
// à accepter tel quel.
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
        json_response(["status" => "error", "message" => "Photo requise manquante : $label"], 400);
    }
    if ($_FILES[$field]["error"] !== UPLOAD_ERR_OK) {
        json_response(["status" => "error", "message" => "Echec de l'envoi de la photo : $label"], 400);
    }
    if ($_FILES[$field]["size"] > $maxFileSize) {
        json_response(["status" => "error", "message" => "Photo trop volumineuse (8 Mo max) : $label"], 400);
    }

    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $_FILES[$field]["tmp_name"]);
    finfo_close($finfo);

    if (!isset($allowedMimes[$mime])) {
        json_response(["status" => "error", "message" => "Format non supporte pour : $label (JPEG, PNG ou WEBP uniquement)"], 400);
    }
}

// ── Compte déjà existant ? ────────────────────────────────────────
$conn = db_connect();

$checkStmt = $conn->prepare("SELECT id FROM chauffeur WHERE email = ? OR phone = ? OR plate = ? LIMIT 1");
$checkStmt->bind_param("sss", $email, $phone, $plate);
$checkStmt->execute();
$exists = $checkStmt->get_result()->num_rows > 0;
$checkStmt->close();

if ($exists) {
    $conn->close();
    json_response(["status" => "error", "message" => "Un chauffeur existe deja avec cet email, ce telephone ou cette plaque"], 409);
}

$passwordHash = password_hash($password, PASSWORD_DEFAULT);

// ── Création du compte (documents/photos ajoutés juste après) ────
$stmt = $conn->prepare("
    INSERT INTO chauffeur (
        name, phone, email, password_hash, plate, car_brand, car_color,
        cni_number, cni_expiration,
        carte_grise_immat, carte_grise_expiration,
        permit_number, permit_expiration,
        capacity_number, capacity_expiration,
        license_number, license_expiration,
        kyc_status, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active')
");
$stmt->bind_param(
    "sssssssssssssssss",
    $name, $phone, $email, $passwordHash, $plate, $carBrand, $carColor,
    $textValues["cni_number"], $textValues["cni_expiration"],
    $textValues["carte_grise_immat"], $textValues["carte_grise_expiration"],
    $textValues["permit_number"], $textValues["permit_expiration"],
    $textValues["capacity_number"], $textValues["capacity_expiration"],
    $textValues["license_number"], $textValues["license_expiration"]
);

if (!$stmt->execute()) {
    $stmt->close();
    $conn->close();
    json_response(["status" => "error", "message" => "Inscription impossible"], 500);
}

$driverId = $conn->insert_id;
$stmt->close();

// ── Stockage des photos : backend/uploads/chauffeur_docs/{driverId}/ ──
// Dossier protege par .htaccess (Require all denied) place dans le
// dossier parent backend/uploads/ : jamais d'acces direct par URL,
// seul serve_document.php (admin) peut les servir.
$uploadRoot = __DIR__ . "/../uploads/chauffeur_docs/" . $driverId;

if (!is_dir($uploadRoot) && !mkdir($uploadRoot, 0750, true)) {
    $conn->query("DELETE FROM chauffeur WHERE id = " . (int) $driverId);
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
        // Nettoyage en cas d'echec partiel : on retire le chauffeur et
        // les fichiers deja deplaces pour ne rien laisser d'incoherent.
        foreach ($storedPaths as $path) {
            if ($path !== null) {
                @unlink(__DIR__ . "/../uploads/chauffeur_docs/" . $driverId . "/" . basename($path));
            }
        }
        $conn->query("DELETE FROM chauffeur WHERE id = " . (int) $driverId);
        $conn->close();
        json_response(["status" => "error", "message" => "Echec de l'enregistrement de la photo : $label"], 500);
    }

    // Chemin relatif stocke en base (jamais le chemin absolu du serveur)
    $storedPaths[$field] = "chauffeur_docs/$driverId/$filename";
}

$updateStmt = $conn->prepare("
    UPDATE chauffeur SET
        cni_photo_recto = ?, cni_photo_verso = ?,
        carte_grise_photo = ?,
        permit_photo_recto = ?, permit_photo_verso = ?,
        capacity_photo_recto = ?, capacity_photo_verso = ?,
        license_photo_recto = ?, license_photo_verso = ?
    WHERE id = ?
");
$updateStmt->bind_param(
    "sssssssssi",
    $storedPaths["cni_photo_recto"], $storedPaths["cni_photo_verso"],
    $storedPaths["carte_grise_photo"],
    $storedPaths["permit_photo_recto"], $storedPaths["permit_photo_verso"],
    $storedPaths["capacity_photo_recto"], $storedPaths["capacity_photo_verso"],
    $storedPaths["license_photo_recto"], $storedPaths["license_photo_verso"],
    $driverId
);
$updateStmt->execute();
$updateStmt->close();

// ── Session ────────────────────────────────────────────────────
session_regenerate_id(true);
refresh_session_cookie();
$_SESSION["role"] = "chauffeur";
$_SESSION["driver_id"] = (int) $driverId;
$_SESSION["driver_name"] = $name;
unset($_SESSION["client_id"], $_SESSION["client_name"]);

$sessionToken = store_session_token($conn, "chauffeur", (int) $driverId);
$conn->close();

json_response([
    "status" => "success",
    "message" => "Compte chauffeur cree, documents recus. Verification en cours.",
    "session_token" => $sessionToken,
    "driver" => [
        "id" => (int) $driverId,
        "name" => $name,
        "email" => $email,
        "phone" => $phone,
        "plate" => $plate,
        "car_brand" => $carBrand,
        "car_color" => $carColor,
        "kyc_status" => "pending"
    ]
]);
?>