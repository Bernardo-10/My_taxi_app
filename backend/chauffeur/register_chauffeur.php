<?php
require_once __DIR__ . "/../config/auth.php";
require_once __DIR__ . "/../common/normalize.php";   // Lot 11 : téléphone et plaque normalisés

// ── Inscription allégée (voir rapport friction-inscription-chauffeur.md) ──
// Avant : ce fichier exigeait les 5 documents KYC (10 champs texte + 9
// photos) dès l'inscription — un formulaire de 6 étapes avant même de
// voir l'application. Le chauffeur ne pouvait pas savoir "ce qu'il y a
// derrière" avant de s'être engagé dans tout ce travail.
//
// Maintenant : seuls les champs strictement nécessaires à la création
// d'un compte (identité, mot de passe, véhicule) sont demandés ici. Le
// compte est créé avec kyc_status = 'incomplete' (nouveau statut, à
// ajouter à l'ENUM en base — voir rapport). La complétion des documents
// se fait ensuite, connecté, via complete_chauffeur_profile.php — le
// chauffeur voit le tableau de bord avant de s'engager dans les documents.
//
// set_driver_status.php bloque toujours la mise en ligne tant que
// kyc_status !== 'approved' (ce comportement existait déjà et n'a pas
// changé) : l'exigence documentaire n'est pas retirée, seulement déplacée
// après la création du compte.

// Le formulaire envoie un FormData (compatibilité avec l'ancien flux),
// donc on lit $_POST comme avant.
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

// ── Lot 11 : longueurs maximales (les colonnes de la base sont plus courtes que
// ce que le formulaire laissait passer) ──
if (mb_strlen($name) > 100 || mb_strlen($email) > 120 || mb_strlen($carBrand) > 50 || mb_strlen($carColor) > 30) {
    json_response(["status" => "error", "message" => "Un des champs est trop long (nom 100, email 120, marque 50, couleur 30 caracteres maximum)"], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_response(["status" => "error", "message" => "Email invalide"], 400);
}

// ── Lot 11 : téléphone sous forme canonique (+237XXXXXXXXX) ──
$phoneCanon = normalize_phone($phone);
if ($phoneCanon === null) {
    json_response(["status" => "error", "message" => "Numero de telephone invalide (exemple : +237 6XX XXX XXX)"], 400);
}
$phone = $phoneCanon;

// ── Lot 11 : plaque en majuscules, espaces simples ; comparée sans espaces ni tirets ──
$plate = plate_for_storage($plate);
$plateKey = plate_key($plate);
if (strlen($plateKey) < 3 || strlen($plate) > 20) {
    json_response(["status" => "error", "message" => "Plaque invalide (exemple : LT 1234 AB)"], 400);
}

// ── Lot 11 : mot de passe 8 caracteres minimum, 72 octets maximum ──
// 72 octets = limite de bcrypt (password_hash par défaut) : au-delà, la fin du mot de
// passe serait ignorée en silence. strlen() compte des octets, c'est voulu ici.
// Aucune règle de composition (majuscule, chiffre...) : voir rapport, choix 11-C.
if (strlen($password) < 8) {
    json_response(["status" => "error", "message" => "Le mot de passe doit contenir au moins 8 caracteres"], 400);
}
if (strlen($password) > 72) {
    json_response(["status" => "error", "message" => "Le mot de passe est trop long (72 caracteres maximum)"], 400);
}

if ($password !== $passwordConfirm) {
    json_response(["status" => "error", "message" => "Les deux mots de passe ne correspondent pas"], 400);
}

// ── Compte déjà existant ? ────────────────────────────────────────
// Le téléphone et la plaque sont comparés sous toutes leurs écritures possibles :
// un compte créé avant le lot 11 (téléphone "677123456", plaque "LT-123") est
// retrouvé même si la migration SQL n'a pas encore été passée.
$conn = db_connect();

$phoneVariants = phone_digit_variants($phone);
$placeholders  = implode(",", array_fill(0, count($phoneVariants), "?"));
$checkStmt = $conn->prepare(
    "SELECT id FROM chauffeur
     WHERE email = ? OR phone = ? OR " . sql_phone_digits("phone") . " IN ($placeholders)
        OR " . sql_plate_key("plate") . " = ?
     LIMIT 1"
);
$checkParams = array_merge([$email, $phone], $phoneVariants, [$plateKey]);
$checkStmt->bind_param(str_repeat("s", count($checkParams)), ...$checkParams);
$checkStmt->execute();
$exists = $checkStmt->get_result()->num_rows > 0;
$checkStmt->close();

if ($exists) {
    $conn->close();
    json_response(["status" => "error", "message" => "Un chauffeur existe deja avec cet email, ce telephone ou cette plaque"], 409);
}

$passwordHash = password_hash($password, PASSWORD_DEFAULT);

// ── Création du compte : aucun document, kyc_status = 'incomplete' ──
// Toutes les colonnes documents (cni_number, permit_number, etc.) restent
// NULL jusqu'à la complétion du profil — c'est exactement l'état que
// get_my_documents.php et l'admin savent déjà afficher comme "manquant".
$stmt = $conn->prepare("
    INSERT INTO chauffeur (
        name, phone, email, password_hash, plate, car_brand, car_color,
        kyc_status, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete', 'active')
");
$stmt->bind_param(
    "sssssss",
    $name, $phone, $email, $passwordHash, $plate, $carBrand, $carColor
);

if (!$stmt->execute()) {
    // 1062 = clé unique violée : deux inscriptions simultanées avec les mêmes
    // données (la vérification ci-dessus ne peut pas voir une ligne pas encore écrite).
    $duplicate = ($stmt->errno === 1062);
    $stmt->close();
    $conn->close();
    if ($duplicate) {
        json_response(["status" => "error", "message" => "Un chauffeur existe deja avec cet email, ce telephone ou cette plaque"], 409);
    }
    json_response(["status" => "error", "message" => "Inscription impossible"], 500);
}

$driverId = $conn->insert_id;
$stmt->close();

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
    "message" => "Compte chauffeur cree. Completez votre profil pour passer en ligne.",
    "session_token" => $sessionToken,
    "driver" => [
        "id" => (int) $driverId,
        "name" => $name,
        "email" => $email,
        "phone" => $phone,
        "plate" => $plate,
        "car_brand" => $carBrand,
        "car_color" => $carColor,
        "kyc_status" => "incomplete"
    ]
]);
?>
